#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 应用自更新：下载 GitHub Release 的便携包，退出后替换自身再拉起。
mod update;

// 必须把命令**导入到顶层**再注册：`generate_handler![update::desktop_app_info]`
// 会让 Tauri 2 把命令名取成带模块路径的 `update::desktop_app_info`，而前端
// `invoke('desktop_app_info')` 用的是裸名 —— 结果每次调用都失败，而前端又把
// 错误 catch 掉了，表现就是「版本读不出来、点更新没反应」。
use update::{desktop_app_info, desktop_update_install};

use std::{io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{Duration, Instant}};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};

/// 关闭按钮是否最小化到托盘（而不是退出）。
///
/// 用户要求：「关闭时最小化到系统托盘，任务栏里不显示，歌可以继续放。」
/// 前端把这个偏好同步过来（见 desktop_tray_preference 命令）：关掉开关时
/// 关闭按钮恢复成直接退出，避免用户找不到退出入口。
static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// 真的要退出了（托盘「退出」菜单）：放过这一次关闭事件，别再拦回托盘。
static QUITTING: AtomicBool = AtomicBool::new(false);

/// 托盘菜单「退出」：先停掉曲库服务再退，避免留下孤儿 node 进程。
fn quit_app(app: &tauri::AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.state::<MusicService>().stop();
    app.exit(0);
}

// NVIDIA Optimus' documented application hint. MSVC exports this DWORD in
// build.rs even with LTO/stripping. WebView2's GPU subprocess also needs the
// Chromium preference below; the host export alone cannot select its adapter.
#[cfg(windows)]
#[no_mangle]
#[used]
pub static NvOptimusEnablement: u32 = 1;

fn request_high_performance_gpu() {
    #[cfg(windows)] {
        // Preserve Wry's defaults and externally supplied browser arguments.
        // Do not disable driver blocklists, the GPU sandbox, or the single-GPU
        // fallback. Windows/driver policy can still override this preference.
        let previous = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !previous.split_whitespace().any(|arg| arg == "--force_high_performance_gpu") {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("{previous} --force_high_performance_gpu"));
        }
    }
}

struct MusicService(Mutex<Option<Child>>);

impl MusicService {
    fn stop(&self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            if let Some(stdin) = child.stdin.as_mut() { let _ = stdin.write_all(b"shutdown\n"); }
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() { return; }
                std::thread::sleep(Duration::from_millis(30));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for MusicService { fn drop(&mut self) { self.stop(); } }

#[tauri::command]
fn desktop_window_state(window: WebviewWindow) -> serde_json::Value {
    serde_json::json!({ "fullscreen": window.is_fullscreen().unwrap_or(false), "maximized": window.is_maximized().unwrap_or(false) })
}

#[tauri::command]
fn desktop_window_action(window: WebviewWindow, action: &str) -> Result<(), String> {
    match action {
        "minimize" => window.minimize(),
        // Maximize uses the Windows work area, leaving the taskbar available.
        // Keep old action names compatible without entering native fullscreen.
        "maximize" | "fullscreen" => if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() },
        "restore" | "leave-fullscreen" => window.unmaximize(),
        // 关闭按钮：开了「最小化到托盘」就藏窗口（歌继续放、任务栏图标消失），
        // 否则真关。这里直接 hide()，不依赖 CloseRequested 事件是否回调，
        // 保证点关闭的行为一定是确定的。
        "close" => if MINIMIZE_TO_TRAY.load(Ordering::SeqCst) {
            window.hide()
        } else {
            window.close()
        },
        _ => return Err("Unknown window action".into()),
    }.map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_pick_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().set_title("选择音乐文件夹").pick_folder().map(|p| p.to_string_lossy().into_owned()))
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_open_link(url: &str) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|_| "Invalid link")?;
    if !matches!(parsed.scheme(), "https" | "http") { return Err("Only web links are allowed".into()); }
    open::that_detached(url).map_err(|e| e.to_string())
}

// Feedback opens a user-reviewed draft; it never sends mail or accepts another recipient.
#[tauri::command]
fn desktop_open_feedback(url: &str) -> Result<(), String> {
    if url.len() > 7500 { return Err("Feedback draft is too long".into()); }
    let parsed: tauri::Url = url.parse().map_err(|_| "Invalid feedback link")?;
    if parsed.scheme() != "mailto" || parsed.path() != "2228396737@qq.com"
        || parsed.host_str().is_some() || parsed.fragment().is_some() {
        return Err("Invalid feedback recipient".into());
    }
    let mut keys = std::collections::HashSet::new();
    for (key, value) in parsed.query_pairs() {
        if !matches!(key.as_ref(), "subject" | "body") || !keys.insert(key.to_string())
            || (key == "subject" && value.contains(['\r', '\n'])) {
            return Err("Invalid feedback fields".into());
        }
    }
    if keys.len() != 2 { return Err("Missing feedback fields".into()); }
    open::that_detached(url).map_err(|e| e.to_string())
}

fn start_service(app: &tauri::AppHandle) -> Result<(MusicService, tauri::Url), Box<dyn std::error::Error>> {
    let resource_root = app.path().resource_dir()?.join("runtime");
    let runtime: PathBuf = if resource_root.join("node.exe").is_file() { resource_root }
        else {
            #[cfg(debug_assertions)]
            { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../desktop-runtime") }
            #[cfg(not(debug_assertions))]
            { return Err("缺少 runtime 文件夹，请完整解压便携包后启动".into()); }
        };
    let data = std::env::var_os("RHINE_DESKTOP_DATA_DIR").map(PathBuf::from)
        .unwrap_or(app.path().app_local_data_dir()?.join("music-data"));
    std::fs::create_dir_all(&data)?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(data.join("service.log"))?;
    let mut command = Command::new(runtime.join("node.exe"));
    command.arg("scripts/desktop-server.mjs").current_dir(&runtime)
        .env("MUSIC_DATA_DIR", &data).env_remove("MUSIC_ROOTS")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log));
    // Node and FFmpeg must never open console windows behind the player.
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or("Missing service output")?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(address) = line.strip_prefix("RHINE_READY ") { let _ = send.send(address.to_owned()); }
        }
    });
    let service = MusicService(Mutex::new(Some(child)));
    let address = receive.recv_timeout(Duration::from_secs(25)).map_err(|_| "音乐服务启动超时，请查看本地数据目录中的 service.log")?;
    let mut url: tauri::Url = address.parse()?;
    url.set_query(Some("desktop=1"));
    Ok((service, url))
}

/// 建系统托盘：左键点图标恢复窗口，右键出菜单。
///
/// 图标直接复用 `bundle.icon` 里那个（`default_window_icon()`），不额外塞一份
/// 资源 —— 否则打包体积变大，还容易出现托盘图标和任务栏图标不一致。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Rhine Music", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("rhine-tray")
        .tooltip("Rhine Music")
        .menu(&menu)
        // 左键直接开窗口，不弹菜单；菜单交给右键。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 只响应左键抬起：Windows 上双击会连发两次 Click，这里用 Up 更稳。
            if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
    // 托盘图标：优先用窗口图标；程序化建窗时 default_window_icon() 可能为空，
    // 那就退回 build.rs 内嵌的 icons/icon.ico（含 16/32px 帧，正合托盘尺寸），
    // 保证托盘上一定有个看得见的图标，而不是空白。
    let icon = app.default_window_icon().cloned()
        .or_else(|| tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico")).ok());
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// 前端把「关闭时最小化到托盘」开关同步过来。
#[tauri::command]
fn desktop_tray_preference(enabled: bool) {
    MINIMIZE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

fn main() {
    request_high_performance_gpu();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_window_state::Builder::default()
            // Ignore fullscreen saved by older previews and retain the integrated chrome.
            .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE
                | tauri_plugin_window_state::StateFlags::POSITION
                | tauri_plugin_window_state::StateFlags::MAXIMIZED)
            .build())
        .invoke_handler(tauri::generate_handler![desktop_window_action, desktop_window_state, desktop_pick_folder, desktop_open_link, desktop_open_feedback, desktop_tray_preference, desktop_app_info, desktop_update_install])
        .setup(|app| {
            let (service, url) = start_service(app.handle())?;
            app.manage(service);
            let origin = url.origin().ascii_serialization();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Rhine Music").inner_size(1280.0, 800.0).min_inner_size(800.0, 560.0)
                .decorations(false).resizable(true).fullscreen(false)
                .initialization_script("Object.defineProperty(window, '__RHINE_GPU_REQUEST__', { value: 'prefer-discrete-with-integrated-fallback' });")
                .background_color(tauri::window::Color(232, 229, 225, 255))
                .on_navigation(move |target| target.origin().ascii_serialization() == origin)
                .build()?;
            setup_tray(app.handle())?;
            // OS visibility explicitly suspends only rendering. Audio remains independent.
            let view = window.clone();
            window.on_window_event(move |event| {
                match event {
                    // 关闭 → 藏到托盘，不退出。音频由 WebView2 自己维持，
                    // 窗口 hide() 只停渲染，歌继续放（这正是用户要的效果）。
                    // 托盘菜单「退出」会先把 QUITTING 置位，那种情况放行。
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        if MINIMIZE_TO_TRAY.load(Ordering::SeqCst) && !QUITTING.load(Ordering::SeqCst) {
                            api.prevent_close();
                            let _ = view.hide();
                            // 任务栏图标随 hide() 一起消失，不用额外调 API。
                        }
                    }
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) => {
                        let hidden = view.is_minimized().unwrap_or(false);
                        let _ = view.eval(&format!("window.dispatchEvent(new CustomEvent('rhine-desktop-visibility',{{detail:{{hidden:{hidden}}}}}))"));
                        let fullscreen = view.is_fullscreen().unwrap_or(false);
                        let maximized = view.is_maximized().unwrap_or(false);
                        let _ = view.eval(&format!("window.dispatchEvent(new CustomEvent('rhine-desktop-window-state',{{detail:{{fullscreen:{fullscreen},maximized:{maximized}}}}}))"));
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Rhine Music desktop initialization failed")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) { app.state::<MusicService>().stop(); }
        });
}
