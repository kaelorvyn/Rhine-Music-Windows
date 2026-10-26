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
use tauri::{AppHandle, Emitter};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// 问服务器要总大小。拿不到就返回 None —— 后面只做「能解开」的校验。
fn remote_total(url: &str, proxy: Option<&str>) -> Option<u64> {
    let mut head = Command::new("curl");
    head.args(["-sIL", "--fail", "--max-time", "25"]);
    if let Some(proxy) = proxy {
        head.arg("--proxy").arg(proxy);
    }
    head.arg(url);
    let output = spawn_hidden(&mut head).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // 逐跳重定向会给出多个头，取最后一个 content-length。
    text.lines()
        .filter_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<u64>().ok())
        })
        .next_back()
}

/// 读出本机代理。
///
/// 这是个必须解决的问题：curl.exe **不读** Windows 的「Internet 选项」代理，
/// 代理开着时它会直连然后卡到超时（用户看到的就是一个空黑框，永远不动）。
/// 顺序：HTTPS_PROXY / https_proxy / ALL_PROXY 环境变量 → 注册表 WinINET。
/// 注册表 ProxyServer 可能是 "host:port"，也可能是 "http=h:p;https=h:p"，都要认。
fn system_proxy() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(if value.contains("://") { value } else { format!("http://{value}") });
            }
        }
    }
    let output = spawn_hidden(Command::new("reg").args([
        "query",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
    ]))
    .output()
    .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut enabled = false;
    let mut server = String::new();
    for line in text.lines() {
        if line.contains("ProxyEnable") {
            enabled = line.trim_end().ends_with("0x1") || line.trim_end().ends_with('1');
        }
        if line.contains("ProxyServer") {
            if let Some((_, value)) = line.split_once("REG_SZ") {
                server = value.trim().to_string();
            }
        }
    }
    if !enabled || server.is_empty() {
        return None;
    }
    // "http=h:p;https=h:p" → 取 https（我们只下 https）
    let picked = server
        .split(';')
        .find_map(|part| part.trim().strip_prefix("https=").map(|value| value.to_string()))
        .or_else(|| server.split(';').find_map(|part| part.trim().strip_prefix("http=").map(|value| value.to_string())))
        .unwrap_or(server);
    let picked = picked.trim();
    if picked.is_empty() { None } else { Some(format!("http://{picked}")) }
}

/// 以「无窗口」方式启动外部程序。
///
/// 这是个 GUI 程序：直接 spawn curl / tar / cmd 时，Windows 会给每个控制台
/// 程序新开一个黑色命令行窗口 —— 用户看到的就是「弹一个空框又消失」。
/// 加上 CREATE_NO_WINDOW 后它们彻底在后台跑。
fn spawn_hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 更新进度事件：前端据此在对话框里画进度条。
#[derive(Clone, Serialize)]
struct UpdateProgress {
    /// download / unpack / apply / restart
    phase: &'static str,
    downloaded: u64,
    total: u64,
}

fn report(app: &AppHandle, phase: &'static str, downloaded: u64, total: u64) {
    let _ = app.emit("rhine-update-progress", UpdateProgress { phase, downloaded, total });
}

/// 只允许从这些域下载。否则「传一个 URL 过来就能覆盖程序目录」会变成一个
/// 任意写入入口。
const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
];

/// 走指定通道（`proxy` 为 None 就是直连）把更新包下到 `zip`。
///
/// 断点续传最多试 4 次。抽成独立函数是为了让调用方能「换一条通道重来」——
/// 代理不通时不该让整次更新失败，直连往往反而是通的。
fn download_package(
    app: &AppHandle,
    url: &str,
    zip: &Path,
    total: u64,
    proxy: Option<&str>,
) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let have = fs::metadata(zip).map(|meta| meta.len()).unwrap_or(0);
        if total > 0 && have >= total {
            return Ok(());
        }
        let mut curl = Command::new("curl");
        curl.args([
            "-L",
            "--fail",
            "--silent",
            "--show-error",
            // 断了从断点接着下，不要把 300 MB 重来一遍。
            "-C",
            "-",
            "--connect-timeout",
            "20",
            // 代理「连得上但不动」比连不上更难受：进度条会永远停在 0%。
            // 低于 1 KB/s 连续 30 秒就判这条通道废了，交给调用方换直连。
            "--speed-limit",
            "1024",
            "--speed-time",
            "30",
            "-o",
        ])
        .arg(zip)
        .arg(url);
        if let Some(proxy) = proxy {
            curl.arg("--proxy").arg(proxy);
        }
        let mut child = spawn_hidden(&mut curl)
            .spawn()
            .map_err(|e| format!("无法启动 curl：{e}"))?;
        let mut last_reported = have;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {
                    let done = fs::metadata(zip).map(|meta| meta.len()).unwrap_or(0);
                    if done != last_reported {
                        last_reported = done;
                        report(app, "download", done, total.max(done));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Err(error) => break Err(error),
            }
        };
        let finished = match status {
            Ok(status) => status.success(),
            Err(error) => return Err(format!("下载过程出错：{error}")),
        };
        let done = fs::metadata(zip).map(|meta| meta.len()).unwrap_or(0);
        if finished && (total == 0 || done >= total) {
            return Ok(());
        }
        // 没下完：保留已有字节，退避后再接着下。最多试 4 次。
        if attempt >= 4 {
            let where_ = if proxy.is_some() { "（经代理）" } else { "（直连）" };
            return Err(format!(
                "更新包下载失败{where_}：{done} / {total} 字节。请检查网络后重试。",
            ));
        }
        report(app, "download", done, total.max(done));
        std::thread::sleep(std::time::Duration::from_millis(600 * attempt as u64));
    }
}

fn app_directory() -> Result<PathBuf, String> {    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序位置：{e}"))?;
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
///
/// 【为什么要退一步认「顶层任意 exe」】
/// 用户实际启动的程序名不一定和发布包里的文件名一模一样 —— 比如直接双击
/// 构建产物 `rhine-music-windows.exe`（和 `Rhine Music.exe` 是同一个程序，
/// 只是文件名不同）。严格按当前 exe 名去找，会得出「更新包里没有找到主程序」
/// 这种明明是同一个程序却更新不了的结论。所以按名字找不到时，退一步看顶层
/// 有没有任何 exe：有，就认为这一层就是程序目录。
fn find_payload_root(root: &Path, exe_name: &str, depth: usize) -> Option<PathBuf> {
    if root.join(exe_name).is_file() {
        return Some(root.to_path_buf());
    }
    // 顶层任意 .exe（runtime/ 里的 node.exe、bin/ffmpeg.exe 都在子目录，不会误判）
    if let Ok(entries) = fs::read_dir(root) {
        let has_exe = entries.flatten().any(|entry| {
            let path = entry.path();
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("exe"))
                    .unwrap_or(false)
        });
        if has_exe {
            return Some(root.to_path_buf());
        }
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
pub async fn desktop_update_install(app: tauri::AppHandle, url: String, size: Option<f64>) -> Result<String, String> {
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

    // 1) 下载：断点续传 + 完整性校验。
    //    这里必须自己校验大小 —— 代理掐断连接时 curl 可能「干净地」退出 0，
    //    留下半截 zip，然后解压才报「文件已损坏」，用户完全看不出是下载的锅。
    //
    // 【代理挂了必须能直连】
    // system_proxy() 只是读注册表，它不知道那个代理程序现在有没有在跑。
    // 现实里「Internet 选项里开着代理、代理客户端却没启动」是常态 —— 这时
    // curl 连 127.0.0.1 直接 exit 7，两秒就失败，用户看到的就是「更新失败」，
    // 而且完全没有退路。所以这里按「先走代理、整体失败再直连重来」的顺序试。
    let candidates: Vec<Option<String>> = match system_proxy() {
        Some(proxy) => vec![Some(proxy), None],
        None => vec![None],
    };
    let mut total = size.filter(|value| *value > 0.0).map(|value| value as u64).unwrap_or(0);
    if total == 0 {
        for proxy in candidates.iter() {
            total = remote_total(&url, proxy.as_deref()).unwrap_or(0);
            if total > 0 {
                break;
            }
        }
    }
    report(&app, "download", 0, total);

    let mut last_error = String::new();
    let mut downloaded = false;
    for (index, proxy) in candidates.iter().enumerate() {
        if index > 0 {
            // 换通道前把半截文件清掉：代理直连两边的 Range 不一定对得上，
            // 留着旧字节反而会让续传拼出坏包。
            let _ = fs::remove_file(&zip);
            last_error.clear();
        }
        match download_package(&app, &url, &zip, total, proxy.as_deref()) {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(error) => last_error = error,
        }
    }
    if !downloaded {
        let _ = report(&app, "error", 0, total);
        return Err(last_error);
    }
    // 收尾对齐：让进度条停到 100%。
    let final_size = fs::metadata(&zip).map(|meta| meta.len()).unwrap_or(0);
    if total > 0 && final_size < total {
        let _ = report(&app, "error", final_size, total);
        return Err("更新包下载不完整。已保留临时文件，稍后可重试。".to_string());
    }
    report(&app, "download", final_size, final_size);

    // 2) 解压（Windows 自带 bsdtar，能直接解 zip）。
    //
    // 【为什么不看 success()】
    // bsdtar 的退出码 1 表示「解完了，但有条目被跳过」，2 才是真正的致命错误。
    // 触发 1 的场景很常见：某个音源插件的文件名带非常规 Unicode（比如
    // `[V260907] 𝖧౿ᥣᥣ𝗈 Ԝ𝗈𝗋ᥣᑯ260809.js` 里的星形平面字符），bsdtar 在
    // Windows 上转不出文件名就跳过它 —— 其余 4835 个文件全都正常解出。
    //
    // 旧实现只看 success()，于是把「跳过一个可选插件」判成「整包已损坏」，
    // 直接把临时目录删了，用户看到的就是「更新失败」。一个插件文件不该
    // 让整次更新作废 —— 解压结果后面还会核对主程序在不在。
    report(&app, "unpack", 0, 0);
    let unpacked = spawn_hidden(
        Command::new("tar").arg("-xf").arg(&zip).arg("-C").arg(&staging),
    )
    .status()
    .map_err(|e| format!("无法启动 tar：{e}"))?;
    if unpacked.code().unwrap_or(2) >= 2 {
        let _ = fs::remove_dir_all(&work);
        return Err("更新包解压失败，文件可能已损坏。".to_string());
    }

    // 3) 定位真正的程序目录。
    let payload = find_payload_root(&staging, &exe_name, 3)
        .ok_or_else(|| "更新包里没有找到主程序。".to_string())?;

    // 4) 写替换脚本。等 2 秒让本进程彻底退出、文件句柄释放。
    //
    // `/XD music-data-v3`：包里带了一份默认的 music-data-v3（配置与流派规则），
    // 但那是**用户数据目录** —— 更新程序不该把人家的歌单索引覆盖成出厂状态。
    let script = work.join("apply-update.cmd");
    let body = format!(
        "@echo off\r\n\
chcp 65001 >nul\r\n\
ping -n 3 127.0.0.1 >nul\r\n\
robocopy \"{payload}\" \"{target}\" /E /IS /MOVE /XD music-data-v3 /R:2 /W:1 /NFL /NDL /NJH /NJS >nul\r\n\
start \"\" \"{exe}\"\r\n\
rd /s /q \"{work}\"\r\n\
del \"%~f0\"\r\n",
        payload = payload.display(),
        target = target_dir.display(),
        exe = target_dir.join(&exe_name).display(),
        work = work.display(),
    );
    fs::write(&script, body).map_err(|e| format!("无法写入更新脚本：{e}"))?;

    // 5) 以完全独立的进程启动替换脚本，随后自己退出。
    //
    // 这里必须是 DETACHED_PROCESS 而不是 start /b：
    //   · start /b 起的是控制台程序，会**新开一个黑窗口**（就是用户说的那个
    //     「弹出命令提示符又消失」）；
    //   · DETACHED_PROCESS 干脆不给它分配控制台，全程静默；
    //   · 再加 CREATE_BREAKAWAY_FROM_JOB，避免它被当前进程的作业对象连带收走。
    report(&app, "apply", 0, 0);
    let mut apply = Command::new("cmd");
    apply.args(["/C"]).arg(&script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        apply.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    }
    apply
        .spawn()
        .map_err(|e| format!("无法启动更新脚本：{e}"))?;

    report(&app, "restart", 0, 0);
    // 让「正在重启应用…」和 100% 的进度条停留一下再关，别一闪而过。
    std::thread::sleep(std::time::Duration::from_millis(900));
    app.exit(0);
    Ok("更新已开始，应用会自动重启。".to_string())
}
