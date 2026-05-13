use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

mod tray;

struct ServerProcess(Mutex<Option<Child>>);

fn version_sort_key(path: &Path) -> Vec<u32> {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

fn node_binary_for_version(version_dir: &Path) -> Option<PathBuf> {
    [
        version_dir.join("bin").join("node"),
        version_dir.join("bin").join("node.exe"),
        version_dir.join("installation").join("bin").join("node"),
        version_dir
            .join("installation")
            .join("bin")
            .join("node.exe"),
        version_dir.join("node.exe"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

fn home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }

    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return Some(PathBuf::from(profile));
        }
    }

    match (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        (Ok(drive), Ok(path)) if !drive.is_empty() && !path.is_empty() => {
            Some(PathBuf::from(format!("{}{}", drive, path)))
        }
        _ => None,
    }
}

/// Find the node binary by checking common install locations.
/// GUI apps on macOS don't inherit the shell PATH, so `node` alone won't resolve
/// for nvm, Homebrew, fnm, Volta, or other version managers.
fn bundled_node(resource_dir: &Path) -> Option<PathBuf> {
    [
        resource_dir.join("vendor").join("node").join("node.exe"),
        resource_dir.join("vendor").join("node").join("node"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

fn find_node(resource_dir: &Path) -> Option<PathBuf> {
    if let Some(node) = bundled_node(resource_dir) {
        return Some(node);
    }

    // First, try the bare command (works if node is in the system PATH)
    if Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        return Some(PathBuf::from("node"));
    }

    let home = home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(home) = &home {
        // nvm (most common on macOS)
        candidates.push(home.join(".nvm").join("versions").join("node"));
        // fnm
        candidates.push(
            home.join(".local")
                .join("share")
                .join("fnm")
                .join("node-versions"),
        );
        candidates.push(
            home.join("Library")
                .join("Application Support")
                .join("fnm")
                .join("node-versions"),
        );
        // Volta
        candidates.push(home.join(".volta").join("tools").join("image").join("node"));
    }

    if cfg!(target_os = "windows") {
        if let Ok(app_data) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(app_data).join("nvm"));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let local_app_data = PathBuf::from(local_app_data);
            candidates.push(
                local_app_data
                    .clone()
                    .join("Volta")
                    .join("tools")
                    .join("image")
                    .join("node"),
            );
            candidates.push(local_app_data.join("fnm_multishells"));
        }
    }

    for base_path in &candidates {
        if !base_path.is_dir() {
            continue;
        }
        // Pick the highest semver directory
        if let Ok(entries) = std::fs::read_dir(base_path) {
            let mut versions: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            versions.sort_by_key(|path| version_sort_key(path));
            if let Some(node_bin) = versions
                .iter()
                .rev()
                .find_map(|version| node_binary_for_version(version))
            {
                return Some(node_bin);
            }
        }
    }

    let fixed_paths = [
        "/opt/homebrew/bin/node", // Apple Silicon
        "/usr/local/bin/node",    // Intel Mac / Linux Homebrew
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
    ];
    for path in &fixed_paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    None
}

fn push_existing_path(entries: &mut Vec<PathBuf>, path: impl Into<PathBuf>) {
    let path = path.into();
    if path.exists() {
        entries.push(path);
    }
}

fn joined_path(entries: Vec<PathBuf>) -> String {
    std::env::join_paths(entries)
        .map(|paths| paths.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Build a PATH that includes the user's shell-managed binary locations.
/// macOS GUI apps don't inherit the shell PATH, so `gh`, `git`, codex/claude CLIs
/// won't resolve unless we extend it ourselves.
fn build_subprocess_path() -> String {
    let mut entries: Vec<PathBuf> = Vec::new();

    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            entries.extend(std::env::split_paths(&existing));
        }
    }

    let unix_candidates = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    for path in unix_candidates {
        push_existing_path(&mut entries, path);
    }

    if let Some(home) = home_dir() {
        for suffix in [".local/bin", ".cargo/bin", ".npm-global/bin", "bin"] {
            push_existing_path(&mut entries, home.join(suffix));
        }

        push_existing_path(&mut entries, home.join("scoop").join("shims"));
        push_existing_path(
            &mut entries,
            home.join("AppData").join("Roaming").join("npm"),
        );
    }

    if cfg!(target_os = "windows") {
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(program_files) = std::env::var(key) {
                push_existing_path(&mut entries, PathBuf::from(program_files).join("nodejs"));
            }
        }

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            push_existing_path(
                &mut entries,
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("Git")
                    .join("cmd"),
            );
        }
    }

    joined_path(entries)
}

/// Best-effort: launch the user's login shell to capture env vars they set in
/// `~/.zshrc`, `~/.zshenv`, `~/.bash_profile`, etc. The Tauri process itself
/// doesn't see these when launched from Finder.
#[cfg(not(target_os = "windows"))]
fn read_login_shell_env() -> Vec<(String, String)> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // -l: login shell, -i: interactive (loads .zshrc / .bashrc), -c: command
    let output = Command::new(&shell)
        .args(["-l", "-i", "-c", "env -0"])
        .output();

    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let mut pairs = Vec::new();
    for entry in output.stdout.split(|&b| b == 0) {
        if let Ok(line) = std::str::from_utf8(entry) {
            if let Some((key, value)) = line.split_once('=') {
                if !key.is_empty() {
                    pairs.push((key.to_string(), value.to_string()));
                }
            }
        }
    }
    pairs
}

#[cfg(target_os = "windows")]
fn read_login_shell_env() -> Vec<(String, String)> {
    Vec::new()
}

fn start_server(resource_dir: PathBuf, port: u16) -> Result<Child, String> {
    let server_script = resource_dir.join("dist").join("index.cjs");

    if !server_script.exists() {
        return Err(format!(
            "Server bundle not found at {}",
            server_script.display()
        ));
    }

    let node = find_node(&resource_dir).ok_or_else(|| {
        "Node.js not found. Please install Node.js (https://nodejs.org) and restart the app."
            .to_string()
    })?;

    let mut command = Command::new(&node);
    command.arg(&server_script);

    // Load env vars from the user's login shell so GITHUB_TOKEN, etc. are visible
    // when the .app is launched from Finder.
    for (key, value) in read_login_shell_env() {
        // Skip transient or sensitive shell internals.
        if key.starts_with('_') || key == "PWD" || key == "OLDPWD" || key == "SHLVL" {
            continue;
        }
        command.env(key, value);
    }

    // Patchdeck's own settings override anything from the shell.
    command
        .env("NODE_ENV", "production")
        .env("PATCHDECK_DESKTOP", "1")
        .env("PORT", port.to_string())
        .env("PATH", build_subprocess_path())
        .current_dir(&resource_dir);

    command
        .spawn()
        .map_err(|e| format!("Failed to start server with {}: {}", node.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("patchdeck-tauri-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn node_binary_for_version_accepts_windows_node_exe_layout() {
        let dir = temp_dir("node-exe");
        let node = dir.join("node.exe");
        File::create(&node).expect("create node.exe");

        assert_eq!(node_binary_for_version(&dir), Some(node));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_node_prefers_bundled_runtime() {
        let dir = temp_dir("bundled-node");
        let bundled_dir = dir.join("vendor").join("node");
        fs::create_dir_all(&bundled_dir).expect("create bundled node dir");
        let node = bundled_dir.join("node.exe");
        File::create(&node).expect("create bundled node.exe");

        assert_eq!(find_node(&dir), Some(node));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn joined_path_uses_platform_path_separator() {
        let first = PathBuf::from("first");
        let second = PathBuf::from("second");
        let path = joined_path(vec![first.clone(), second.clone()]);
        let parsed: Vec<PathBuf> = std::env::split_paths(&path).collect();

        assert_eq!(parsed, vec![first, second]);
    }

    #[test]
    fn build_subprocess_path_is_parseable_by_current_platform() {
        let path = build_subprocess_path();

        assert!(
            !path.is_empty(),
            "subprocess PATH should include the existing process PATH"
        );
        assert!(
            std::env::split_paths(&path).next().is_some(),
            "subprocess PATH should use the current platform separator"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port: u16 = if cfg!(debug_assertions) {
        5001
    } else {
        portpicker::pick_unused_port().unwrap_or(5001)
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            if !cfg!(debug_assertions) {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;

                match start_server(resource_dir, port) {
                    Ok(child) => {
                        app.manage(ServerProcess(Mutex::new(Some(child))));
                    }
                    Err(msg) => {
                        eprintln!("Server error: {}", msg);
                        // Show a native dialog so the user knows what went wrong
                        if let Some(window) = app.get_webview_window("main") {
                            window
                                .dialog()
                                .message(msg.clone())
                                .title("PatchDeck — Error")
                                .kind(MessageDialogKind::Error)
                                .show(|_| {});
                        }
                        app.manage(ServerProcess(Mutex::new(None)));
                        return Err(msg.into());
                    }
                }

                // Give the server time to initialize
                std::thread::sleep(std::time::Duration::from_millis(2000));
            } else {
                app.manage(ServerProcess(Mutex::new(None)));
            }

            let server_url = format!("http://localhost:{}", port);
            if let Some(window) = app.get_webview_window("main") {
                let url: tauri::Url = server_url
                    .parse()
                    .map_err(|e| format!("Invalid URL: {}", e))?;
                let _ = window.navigate(url);
            }

            // Install the menu-bar tray icon and start its background poller.
            if let Err(err) = tray::setup(&app.handle(), port) {
                eprintln!("Failed to set up tray icon: {err}");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window hides it instead of quitting; the tray icon
            // keeps the app alive. Quit explicitly via the tray menu, ⌘Q, or Quit
            // patchdeck → menu. Other windows close normally.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // User clicked the Dock icon while the window was hidden — reveal it.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                }
                // Normal exit path (⌘Q, tray Quit, system-initiated). Tear down the
                // Node server child process so we don't orphan it.
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<ServerProcess>() {
                        if let Ok(mut guard) = state.0.lock() {
                            if let Some(ref mut child) = *guard {
                                let _ = child.kill();
                            }
                        }
                    }
                }
                _ => {}
            }
        });
}
