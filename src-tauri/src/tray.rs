use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

/// Menu-bar template glyph (transparent background, black silhouette).
/// Embedded at compile time so it travels with the binary.
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray.png");

/// Item IDs used to look up menu items for live updates and click routing.
const ID_TITLE: &str = "patchdeck-title";
const ID_AUTO_MODE: &str = "patchdeck-auto-state";
const ID_PRS_TOTAL: &str = "patchdeck-prs-total";
const ID_PRS_ATTENTION: &str = "patchdeck-prs-attention";
const ID_ISSUES_REVIEW: &str = "patchdeck-issues-review";
const ID_RECENT_ACTIVITY: &str = "patchdeck-recent-activity";
const ID_TOGGLE_AUTO_PRS: &str = "patchdeck-toggle-auto-prs";
const ID_TOGGLE_AUTO_ISSUES: &str = "patchdeck-toggle-auto-issues";
const ID_OPEN_WINDOW: &str = "patchdeck-open-window";
const ID_QUIT: &str = "patchdeck-quit";
const RECENT_ACTIVITY_MAX_CHARS: usize = 96;

/// Lightweight snapshot of server state polled every few seconds.
#[derive(Default, Debug, Clone)]
struct Status {
    drain_mode: bool,
    auto_prs: bool,
    auto_issues: bool,
    prs_total: usize,
    prs_attention: usize,
    issues_total: usize,
    issues_review: usize,
    last_activity_label: Option<String>,
}

#[derive(Deserialize)]
struct RuntimeStateDto {
    #[serde(rename = "drainMode")]
    drain_mode: bool,
}

#[derive(Deserialize)]
struct ConfigDto {
    #[serde(rename = "autoPrs", default = "default_true")]
    auto_prs: bool,
    #[serde(rename = "autoIssues", default = "default_true")]
    auto_issues: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
struct PrDto {
    status: String,
}

#[derive(Deserialize)]
struct IssueDto {
    #[serde(rename = "evaluationStatus")]
    evaluation_status: Option<String>,
}

#[derive(Deserialize)]
struct ActivityItemDto {
    label: String,
    detail: Option<String>,
    status: String,
}

#[derive(Deserialize)]
struct ActivitySnapshotDto {
    #[serde(default)]
    failed: Vec<ActivityItemDto>,
    #[serde(rename = "inProgress", default)]
    in_progress: Vec<ActivityItemDto>,
    #[serde(default)]
    queued: Vec<ActivityItemDto>,
}

/// Install the tray icon and start the background poller.
pub fn setup(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let menu = build_menu(app, &Status::default())?;

    let tray_image = Image::from_bytes(TRAY_ICON_PNG)?;

    let _tray = TrayIconBuilder::with_id("patchdeck-tray")
        .tooltip("PatchDeck")
        .icon(tray_image)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_icon_event)
        .build(app)?;

    // Background poller: hit the local server and refresh menu labels.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_poller(app_handle, port).await;
    });

    Ok(())
}

fn build_menu(app: &AppHandle, status: &Status) -> tauri::Result<Menu<Wry>> {
    let title = MenuItemBuilder::with_id(ID_TITLE, title_text(status))
        .enabled(false)
        .build(app)?;
    let auto_state = MenuItemBuilder::with_id(ID_AUTO_MODE, auto_mode_text(status))
        .enabled(false)
        .build(app)?;

    let prs_total = MenuItemBuilder::with_id(ID_PRS_TOTAL, prs_total_text(status))
        .enabled(false)
        .build(app)?;
    let prs_attention = MenuItemBuilder::with_id(ID_PRS_ATTENTION, prs_attention_text(status))
        .enabled(false)
        .build(app)?;
    let issues_review = MenuItemBuilder::with_id(ID_ISSUES_REVIEW, issues_review_text(status))
        .enabled(false)
        .build(app)?;
    let recent_activity =
        MenuItemBuilder::with_id(ID_RECENT_ACTIVITY, recent_activity_text(status))
            .enabled(false)
            .build(app)?;

    let toggle_prs =
        MenuItemBuilder::with_id(ID_TOGGLE_AUTO_PRS, toggle_auto_prs_text(status)).build(app)?;
    let toggle_issues =
        MenuItemBuilder::with_id(ID_TOGGLE_AUTO_ISSUES, toggle_auto_issues_text(status))
            .build(app)?;

    let open_window = MenuItemBuilder::with_id(ID_OPEN_WINDOW, "Open PatchDeck").build(app)?;
    let quit = MenuItemBuilder::with_id(ID_QUIT, "Quit PatchDeck").build(app)?;

    MenuBuilder::new(app)
        .item(&title)
        .item(&auto_state)
        .separator()
        .item(&prs_total)
        .item(&prs_attention)
        .item(&issues_review)
        .separator()
        .item(&recent_activity)
        .separator()
        .item(&toggle_prs)
        .item(&toggle_issues)
        .separator()
        .item(&open_window)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit)
        .build()
}

fn title_text(_status: &Status) -> &'static str {
    "PatchDeck"
}

fn auto_mode_text(status: &Status) -> String {
    if status.drain_mode {
        return "● Paused — drain mode".to_string();
    }
    match (status.auto_prs, status.auto_issues) {
        (true, true) => "● Auto — PRs + Issues".to_string(),
        (true, false) => "● Partial — PRs only".to_string(),
        (false, true) => "● Partial — Issues only".to_string(),
        (false, false) => "● Manual — auto off".to_string(),
    }
}

fn prs_total_text(status: &Status) -> String {
    if status.prs_total == 0 {
        "No tracked PRs".to_string()
    } else if status.prs_total == 1 {
        "1 tracked PR".to_string()
    } else {
        format!("{} tracked PRs", status.prs_total)
    }
}

fn prs_attention_text(status: &Status) -> String {
    if status.prs_attention == 0 {
        "All PRs healthy".to_string()
    } else if status.prs_attention == 1 {
        "1 PR needs attention".to_string()
    } else {
        format!("{} PRs need attention", status.prs_attention)
    }
}

fn issues_review_text(status: &Status) -> String {
    if status.issues_total == 0 {
        "No watched issues".to_string()
    } else if status.issues_review == 0 {
        format!("{} watched issues — none flagged", status.issues_total)
    } else if status.issues_review == 1 {
        "1 issue needs review".to_string()
    } else {
        format!("{} issues need review", status.issues_review)
    }
}

fn recent_activity_text(status: &Status) -> String {
    truncate_for_menu(
        status
            .last_activity_label
            .as_deref()
            .unwrap_or("No recent activity"),
        RECENT_ACTIVITY_MAX_CHARS,
    )
}

fn toggle_auto_prs_text(status: &Status) -> String {
    if status.auto_prs {
        "✓ Auto PRs — disable"
    } else {
        "Auto PRs — enable"
    }
    .to_string()
}

fn toggle_auto_issues_text(status: &Status) -> String {
    if status.auto_issues {
        "✓ Auto Issues — disable"
    } else {
        "Auto Issues — enable"
    }
    .to_string()
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    match id {
        ID_OPEN_WINDOW => focus_main_window(app),
        ID_QUIT => app.exit(0),
        ID_TOGGLE_AUTO_PRS => toggle_auto_flag(app.clone(), "autoPrs"),
        ID_TOGGLE_AUTO_ISSUES => toggle_auto_flag(app.clone(), "autoIssues"),
        _ => {}
    }
}

fn handle_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        // Left-click without modifiers opens the menu by default (we enabled
        // show_menu_on_left_click). Allow the OS to open the menu; nothing else to do.
        let _ = tray;
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_auto_flag(app: AppHandle, field: &'static str) {
    tauri::async_runtime::spawn(async move {
        let client = match build_client() {
            Ok(c) => c,
            Err(err) => {
                eprintln!("[tray] failed to build http client: {err}");
                return;
            }
        };

        let port = match app.try_state::<TrayServerPort>() {
            Some(state) => state.0,
            None => return,
        };

        // Read current value first so we can flip it.
        let cfg_url = format!("http://localhost:{port}/api/config");
        let current: ConfigDto = match client.get(&cfg_url).send().await {
            Ok(resp) => match resp.json().await {
                Ok(v) => v,
                Err(err) => {
                    eprintln!("[tray] parse config: {err}");
                    return;
                }
            },
            Err(err) => {
                eprintln!("[tray] fetch config: {err}");
                return;
            }
        };

        let next_value = match field {
            "autoPrs" => !current.auto_prs,
            "autoIssues" => !current.auto_issues,
            _ => return,
        };

        let body = serde_json::json!({ field: next_value });
        if let Err(err) = client.patch(&cfg_url).json(&body).send().await {
            eprintln!("[tray] patch config: {err}");
        }
    });
}

/// Stored alongside the app so async tasks can read the dynamic port.
struct TrayServerPort(u16);

async fn run_poller(app: AppHandle, port: u16) {
    app.manage(TrayServerPort(port));

    let client = match build_client() {
        Ok(c) => Arc::new(c),
        Err(err) => {
            eprintln!("[tray] failed to build http client: {err}");
            return;
        }
    };

    loop {
        let status = match fetch_status(&client, port).await {
            Ok(s) => s,
            Err(err) => {
                eprintln!("[tray] poll failed: {err}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        if let Err(err) = apply_status(&app, &status) {
            eprintln!("[tray] apply status: {err}");
        }

        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

fn build_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
}

async fn fetch_status(client: &reqwest::Client, port: u16) -> Result<Status, String> {
    let base = format!("http://localhost:{port}");

    let runtime: RuntimeStateDto = client
        .get(format!("{base}/api/runtime"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let config: ConfigDto = client
        .get(format!("{base}/api/config"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let prs: Vec<PrDto> = client
        .get(format!("{base}/api/prs"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let issues: Vec<IssueDto> = client
        .get(format!("{base}/api/issues"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let activities: ActivitySnapshotDto = client
        .get(format!("{base}/api/activities"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let prs_total = prs.len();
    let prs_attention = prs.iter().filter(|p| p.status == "error").count();

    let issues_total = issues.len();
    let issues_review = issues
        .iter()
        .filter(|i| {
            matches!(
                i.evaluation_status.as_deref(),
                Some("blocked") | Some("needs_review")
            )
        })
        .count();

    let last_activity_label = activities
        .failed
        .first()
        .or_else(|| activities.in_progress.first())
        .or_else(|| activities.queued.first())
        .map(|a| {
            let prefix = match a.status.as_str() {
                "failed" => "✗",
                "in_progress" => "⋯",
                "queued" => "•",
                _ => "·",
            };
            let detail = a
                .detail
                .as_deref()
                .map(|d| format!(" — {d}"))
                .unwrap_or_default();
            format!("{prefix} {}{detail}", truncate_for_menu(&a.label, 60))
        });

    Ok(Status {
        drain_mode: runtime.drain_mode,
        auto_prs: config.auto_prs,
        auto_issues: config.auto_issues,
        prs_total,
        prs_attention,
        issues_total,
        issues_review,
        last_activity_label,
    })
}

fn truncate_for_menu(input: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if input.chars().count() <= max {
        input.to_string()
    } else {
        let mut out: String = input.chars().take(max - 1).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_activity_text_caps_full_activity_detail() {
        let status = Status {
            last_activity_label: Some(format!(
                "⋯ Babysitting PR #5860 — gsd-build/gsd-2 - {}",
                "fix(issue): ".repeat(20)
            )),
            ..Status::default()
        };

        let text = recent_activity_text(&status);

        assert_eq!(text.chars().count(), RECENT_ACTIVITY_MAX_CHARS);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn recent_activity_text_preserves_empty_state() {
        let text = recent_activity_text(&Status::default());

        assert_eq!(text, "No recent activity");
    }
}

fn apply_status(app: &AppHandle, status: &Status) -> tauri::Result<()> {
    let menu = build_menu(app, status)?;
    if let Some(tray) = app.tray_by_id("patchdeck-tray") {
        tray.set_menu(Some(menu))?;
        tray.set_tooltip(Some(format!("PatchDeck — {}", tooltip_for(status))))?;
    }
    Ok(())
}

fn tooltip_for(status: &Status) -> String {
    if status.drain_mode {
        return "Paused".into();
    }
    let mut parts = vec![];
    if status.prs_attention > 0 {
        parts.push(format!("{} PR alert", status.prs_attention));
    }
    if status.issues_review > 0 {
        parts.push(format!("{} issue alert", status.issues_review));
    }
    if parts.is_empty() {
        match (status.auto_prs, status.auto_issues) {
            (true, true) => "Auto".into(),
            (false, false) => "Manual".into(),
            _ => "Partial auto".into(),
        }
    } else {
        parts.join(" · ")
    }
}
