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
        version_dir.join("installation").join("bin").join("node"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

/// Find the node binary by checking common install locations.
/// GUI apps on macOS don't inherit the shell PATH, so `node` alone won't resolve
/// for nvm, Homebrew, fnm, Volta, or other version managers.
fn find_node() -> Option<PathBuf> {
    // First, try the bare command (works if node is in the system PATH)
    if Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        return Some(PathBuf::from("node"));
    }

    let home = std::env::var("HOME").ok()?;
    let candidates = [
        // nvm (most common on macOS)
        format!("{}/.nvm/versions/node", home),
        // fnm
        format!("{}/.local/share/fnm/node-versions", home),
        format!("{}/Library/Application Support/fnm/node-versions", home),
        // Volta
        format!("{}/.volta/tools/image/node", home),
    ];

    for base in &candidates {
        let base_path = PathBuf::from(base);
        if !base_path.is_dir() {
            continue;
        }
        // Pick the highest semver directory
        if let Ok(entries) = std::fs::read_dir(&base_path) {
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

    // Homebrew paths
    let brew_paths = [
        "/opt/homebrew/bin/node", // Apple Silicon
        "/usr/local/bin/node",    // Intel Mac / Linux Homebrew
    ];
    for path in &brew_paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    None
}

/// Build a PATH that includes the user's shell-managed binary locations.
/// macOS GUI apps don't inherit the shell PATH, so `gh`, `git`, codex/claude CLIs
/// won't resolve unless we extend it ourselves.
fn build_subprocess_path() -> String {
    let mut entries: Vec<String> = Vec::new();

    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            entries.push(existing);
        }
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    for path in candidates {
        if PathBuf::from(path).exists() {
            entries.push(path.to_string());
        }
    }

    if !home.is_empty() {
        for suffix in [".local/bin", ".cargo/bin", ".npm-global/bin", "bin"] {
            let p = PathBuf::from(&home).join(suffix);
            if p.exists() {
                entries.push(p.display().to_string());
            }
        }
    }

    entries.join(":")
}

/// Best-effort: launch the user's login shell to capture env vars they set in
/// `~/.zshrc`, `~/.zshenv`, `~/.bash_profile`, etc. The Tauri process itself
/// doesn't see these when launched from Finder.
fn read_login_shell_env() -> Vec<(String, String)> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // -l: login shell, -i: interactive (loads .zshrc / .bashrc), -c: command
    let output = Command::new(&shell)
        .args(["-l", "-i", "-c", "env -0"])
        .output();

    let Ok(output) = output else { return Vec::new() };
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

fn start_server(resource_dir: PathBuf, port: u16) -> Result<Child, String> {
    let server_script = resource_dir.join("dist").join("index.cjs");

    if !server_script.exists() {
        return Err(format!(
            "Server bundle not found at {}",
            server_script.display()
        ));
    }

    let node = find_node().ok_or_else(|| {
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
