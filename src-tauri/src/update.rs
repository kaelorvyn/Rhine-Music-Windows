//! 应用自更新：下载 GitHub Release 里的便携包，退出后覆盖自身再自动拉起。
//!
//! 为什么必须「退出后替换」：Windows 上正在运行的 exe 不能被覆盖，所以这里
//! 只负责下载与解压，然后写一个 detached 的 .cmd —— 它等本进程退出后
//! robocopy 覆盖安装目录、重新启动新版本、删掉自己。用户看到的就是
//! 「关一下又自动打开，已经是最新版」，不需要重新跑安装器。
//!
//! 刻意不引入 HTTP / zip 依赖：Windows 10+ 自带 curl.exe 与 bsdtar（tar.exe，
//! 能解 zip）。少一个 crate 少一份编译时间与供应链面。

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// 只允许从这些域下载。否则「传一个 URL 过来就能覆盖程序目录」会变成一个
/// 任意写入入口。
const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
];

fn app_directory() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序位置：{e}"))?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位程序目录".to_string())
}

/// 目录是否可写：装在 Program Files 时是 false，前端据此降级成「打开下载页」。
fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".rhine-write-probe");
    match fs::write(&probe, b"1") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 从 URL 里取主机名（不引入 url crate，够用即可）。
fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let authority = rest.split('/').next()?;
    // 去掉 userinfo（user@host）与端口。
    let host = authority.rsplit('@').next()?;
    Some(host.split(':').next()?.to_ascii_lowercase())
}

fn host_allowed(host: &str) -> bool {
    ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

#[derive(Serialize)]
pub struct AppInfo {
    /// 当前运行版本（来自 Cargo.toml / tauri.conf.json）。
    version: String,
    /// 程序所在目录，前端展示用。
    directory: String,
    /// 这个目录能不能被自己覆盖：决定「下载更新」还是「打开下载页」。
    writable: bool,
}

#[tauri::command]
pub fn desktop_app_info() -> Result<AppInfo, String> {
    let dir = app_directory()?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        directory: dir.to_string_lossy().to_string(),
        writable: is_writable(&dir),
    })
}

/// 在解压结果里找「真正的那一层」：Release 的 zip 通常把可执行文件包在
/// `Rhine-Music-x.y.z-Portable/` 里，也可能直接躺在根上。
fn find_payload_root(root: &Path, exe_name: &str, depth: usize) -> Option<PathBuf> {
    if root.join(exe_name).is_file() {
        return Some(root.to_path_buf());
    }
    if depth == 0 {
        return None;
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_payload_root(&path, exe_name, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

/// 下载并准备好更新，然后让进程退出以完成替换。
///
/// 返回 Ok 表示「脚本已经排上队、应用即将重启」，前端不必等它回来。
#[tauri::command]
pub async fn desktop_update_install(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let host = host_of(&url).ok_or_else(|| "更新地址无法解析。".to_string())?;
    if !host_allowed(&host) {
        return Err(format!("更新地址不在允许的范围（{host}）。"));
    }
    // 只接受 https：更新包是要覆盖程序目录的，不能走明文。
    if !url.starts_with("https://") {
        return Err("更新地址必须是 https。".to_string());
    }

    let target_dir = app_directory()?;
    if !is_writable(&target_dir) {
        return Err("当前安装目录不可写，请从 GitHub 下载新版安装包。".to_string());
    }
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .ok_or_else(|| "无法确定主程序文件名。".to_string())?;

    let work = std::env::temp_dir().join("rhine-update");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| format!("无法创建临时目录：{e}"))?;
    let zip = work.join("update.zip");
    let staging = work.join("staging");
    fs::create_dir_all(&staging).map_err(|e| format!("无法创建解压目录：{e}"))?;

    // 1) 下载（curl 自带进度与重定向处理，比手写 socket 稳）。
    let downloaded = Command::new("curl")
        .args(["-L", "--fail", "--silent", "--show-error", "-o"])
        .arg(&zip)
        .arg(&url)
        .status()
        .map_err(|e| format!("无法启动 curl：{e}"))?;
    if !downloaded.success() {
        let _ = fs::remove_dir_all(&work);
        return Err("更新包下载失败，请检查网络或改用 GitHub 页面下载。".to_string());
    }

    // 2) 解压（Windows 自带 bsdtar，能直接解 zip）。
    let unpacked = Command::new("tar")
        .arg("-xf")
        .arg(&zip)
        .arg("-C")
        .arg(&staging)
        .status()
        .map_err(|e| format!("无法启动 tar：{e}"))?;
    if !unpacked.success() {
        let _ = fs::remove_dir_all(&work);
        return Err("更新包解压失败，文件可能已损坏。".to_string());
    }

    // 3) 定位真正的程序目录。
    let payload = find_payload_root(&staging, &exe_name, 3)
        .ok_or_else(|| "更新包里没有找到主程序。".to_string())?;

    // 4) 写替换脚本。等 2 秒让本进程彻底退出、文件句柄释放。
    let script = work.join("apply-update.cmd");
    let body = format!(
        "@echo off\r\n\
chcp 65001 >nul\r\n\
timeout /t 2 /nobreak >nul\r\n\
robocopy \"{payload}\" \"{target}\" /E /IS /MOVE /R:2 /W:1 /NFL /NDL /NJH /NJS >nul\r\n\
start \"\" \"{exe}\"\r\n\
rd /s /q \"{work}\"\r\n\
del \"%~f0\"\r\n",
        payload = payload.display(),
        target = target_dir.display(),
        exe = target_dir.join(&exe_name).display(),
        work = work.display(),
    );
    fs::write(&script, body).map_err(|e| format!("无法写入更新脚本：{e}"))?;

    // 5) 以独立进程启动脚本（不继承本进程生命周期），随后退出。
    Command::new("cmd")
        .args(["/C", "start", "/b", ""])
        .arg(&script)
        .spawn()
        .map_err(|e| format!("无法启动更新脚本：{e}"))?;

    app.exit(0);
    Ok("更新已开始，应用会自动重启。".to_string())
}
