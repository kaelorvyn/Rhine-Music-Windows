use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use base64::Engine;

fn proxy_identity(label: &str, request: &tauri::http::Request<Vec<u8>>) -> Option<(String, String, String)> {
    let url = tauri::Url::parse(&request.uri().to_string()).ok()?;
    if url.path() != "/request" || request.headers().get("origin")?.to_str().ok()? != "https://api.qishui.com" || request.body().len() > 65536 { return None; }
    let query: std::collections::HashMap<_, _> = url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
    let id = query.get("id")?;
    let nonce = query.get("nonce")?;
    let target = query.get("url")?;
    if id.len() != 36 || nonce.len() != 36 || !id.chars().chain(nonce.chars()).all(|character| character.is_ascii_hexdigit() || character == '-')
        || (label != format!("qishui-verification-{id}") && label != format!("qishui-passport-{id}")) || target.len() > 32768 { return None; }
    Some((id.clone(), nonce.clone(), target.clone()))
}

pub fn proxy_request(context: tauri::UriSchemeContext<'_, tauri::Wry>, request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let identity = proxy_identity(context.webview_label(), &request);
    let app = context.app_handle().clone();
    std::thread::spawn(move || {
        let mut response = tauri::http::Response::builder().header("Cache-Control", "no-store");
        let Some((id, nonce, url)) = identity else { responder.respond(response.status(403).body(Vec::new()).unwrap()); return; };
        response = response.header("Access-Control-Allow-Origin", "https://api.qishui.com").header("Access-Control-Allow-Credentials", "true")
            .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            .header("Access-Control-Allow-Headers", "accept, content-type, x-tt-passport-verify-portrait, x-ss-stub, bdturing-verify, x-vc-bdturing-parameters, x-tt-trace-id, x-tt-passport-trace-id")
            .header("Access-Control-Expose-Headers", "x-ms-token, x-ms-resp, bdturing-verify, x-vc-bdturing-parameters");
        if request.method() == tauri::http::Method::OPTIONS { responder.respond(response.status(204).body(Vec::new()).unwrap()); return; }
        if !matches!(request.method().as_str(), "GET" | "POST") { responder.respond(response.status(405).body(Vec::new()).unwrap()); return; }
        let Ok(body) = std::str::from_utf8(request.body()) else { responder.respond(response.status(400).body(Vec::new()).unwrap()); return; };
        let headers: serde_json::Map<String, serde_json::Value> = request.headers().iter().filter_map(|(name, value)| value.to_str().ok().map(|value| (name.to_string(), serde_json::json!(value)))).collect();
        let result = app.state::<crate::MusicService>().request("verification-http", serde_json::json!({"id":id,"nonce":nonce,"request":{"url":url,"method":request.method().as_str(),"headers":headers,"body":body}}));
        match result {
            Ok(result) => {
                let status = result["status"].as_u64().filter(|status| (200..=599).contains(status) && !(300..=399).contains(status));
                let body = result["bodyBase64"].as_str().filter(|value| value.len() <= 2796204).and_then(|value| base64::engine::general_purpose::STANDARD.decode(value).ok());
                if let (Some(status), Some(body)) = (status, body) {
                    if let Some(headers) = result["headers"].as_object() {
                        for name in ["content-type", "x-ms-token", "x-ms-resp", "bdturing-verify", "x-vc-bdturing-parameters"] {
                            if let Some(value) = headers.get(name).and_then(|value| value.as_str()).and_then(|value| tauri::http::HeaderValue::from_str(value).ok()) { response = response.header(name, value); }
                        }
                    }
                    responder.respond(response.status(status as u16).body(body).unwrap()); return;
                }
                responder.respond(response.status(502).body(Vec::new()).unwrap());
            }
            Err(_) => responder.respond(response.status(502).body(Vec::new()).unwrap()),
        }
    });
}

fn allowed(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && url.host_str().is_some_and(|host| ["qishui.com", "snssdk.com", "zijieapi.com"].iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}"))))
}
fn notify(app: &tauri::AppHandle, id: &str, purpose: &str, success: bool, retry_after: u64, error: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let detail = serde_json::json!({"id":id,"purpose":purpose,"success":success,"retryAfter":retry_after,"error":error});
        let _ = window.eval(&format!("window.dispatchEvent(new CustomEvent('rhine-qishui-verification',{{detail:{detail}}}))"));
    }
}
#[tauri::command]
pub async fn desktop_qishui_verify(app: tauri::AppHandle, window: WebviewWindow, id: String, purpose: Option<String>) -> Result<(), String> {
    if window.label() != "main" || id.len() != 36 || !id.chars().all(|character| character.is_ascii_hexdigit() || character == '-') { return Err("无效的验证请求".into()); }
    let purpose = purpose.unwrap_or_else(|| "verification".into());
    if purpose == "request" { return crate::qishui_passport::open(app, id).await; }
    let label = format!("qishui-verification-{id}");
    if purpose == "cancel" {
        for label in [label, format!("qishui-passport-{id}")] { if let Some(view) = app.get_webview_window(&label) { let _ = view.close(); } }
        return Ok(());
    }
    if purpose != "session" && purpose != "verification" { return Err("无效的验证阶段".into()); }
    if let Some(previous) = app.webview_windows().values().find(|view| view.label().starts_with("qishui-verification-")) { let _ = previous.set_focus(); return Err("请先完成已打开的安全验证".into()); }
    let handle = app.clone();
    let challenge = id.clone();
    let action = if purpose == "session" { "session-context" } else { "verification-context" };
    let mut context = tauri::async_runtime::spawn_blocking(move || handle.state::<crate::MusicService>().request(action, serde_json::json!({"id":challenge})))
        .await.map_err(|_| "无法读取验证上下文")??;
    let page = context["kind"] == "page";
    let target: tauri::Url = if page { context["url"].as_str().ok_or("缺少官方验证地址")? } else { "https://api.qishui.com/passport/web/region/?aid=386088" }.parse().map_err(|_| "官方验证地址无效")?;
    if !allowed(&target) { return Err("不支持的验证地址".into()); }
    let nonce = context["nonce"].as_str().ok_or("缺少验证会话标识")?.to_owned();
    context["origin"] = serde_json::json!(target.origin().ascii_serialization());
    let user_agent = context["userAgent"].as_str().ok_or("缺少登录客户端信息")?.to_owned();
    let script = include_str!("qishui_webview.js").replacen("__RHINE_QISHUI_CONTEXT__", &context.to_string(), 1);
    let completed = Arc::new(AtomicBool::new(false));
    let navigation_done = completed.clone();
    let navigation_app = app.clone();
    let navigation_id = id.clone();
    let navigation_purpose = purpose.clone();
    let navigation_label = label.clone();
    let verification = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External("about:blank".parse().map_err(|_| "验证地址无效")?))
        .title("汽水音乐安全验证").inner_size(560.0, 600.0).min_inner_size(360.0, 400.0)
        .visible(!page).use_https_scheme(true).user_agent(&user_agent).initialization_script(&script)
        .on_navigation(move |url| {
            if url.scheme() == "rhine-qishui" {
                let callback_nonce = url.query_pairs().find(|(key, _)| key == "nonce").map(|(_, value)| value.into_owned());
                if callback_nonce.as_deref() != Some(nonce.as_str()) { return false; }
                let action = url.host_str().unwrap_or("");
                if page && action == "page-ready" {
                    if let Some(view) = navigation_app.get_webview_window(&navigation_label) { let _ = view.show(); let _ = view.set_focus(); }
                    return false;
                }
                let success = (navigation_purpose == "session" && action == "session-ready") || (navigation_purpose == "verification" && action == "verified");
                if !success && !["failed", "timeout", "invalid-page"].contains(&action) { return false; }
                if navigation_done.swap(true, Ordering::SeqCst) { return false; }
                let handle = navigation_app.clone(); let challenge = navigation_id.clone();
                let purpose = navigation_purpose.clone(); let nonce = nonce.clone();
                let label = navigation_label.clone();
                let token = url.query_pairs().find(|(key, _)| key == "token").map(|(_, value)| value.into_owned()).unwrap_or_default();
                let stage = url.query_pairs().find(|(key, _)| key == "stage").map(|(_, value)| value.into_owned()).unwrap_or_default();
                let error = match action {
                    "timeout" => "官方安全组件响应超时，请稍后重试。", "invalid-page" => "官方验证入口未返回网页，已停止加载。",
                    _ => match stage.as_str() {
                        "react" | "react-dom" => "二次验证界面依赖加载失败，请检查网络后重试。",
                        "glue" | "session" => "二次验证安全会话初始化失败，请检查网络后重试。",
                        "decision" => "官方二次验证决策获取失败，请稍后重新登录。",
                        "component" => "官方二次验证组件不可用，请稍后重试。",
                        "verification" => "官方二次验证未通过或已取消，本次未继续登录。",
                        _ => "官方安全组件加载失败，请检查网络后重试。",
                    }
                };
                std::thread::spawn(move || {
                    if let Some(view) = handle.get_webview_window(&label) {
                        let origin = "https://api.qishui.com/".parse().unwrap();
                        let cookies: Vec<serde_json::Value> = view.cookies_for_url(origin).unwrap_or_default().iter().map(|cookie|
                            serde_json::json!({"name":cookie.name(),"value":cookie.value(),"domain":cookie.domain().unwrap_or("api.qishui.com")})).collect();
                        let result = if success { handle.state::<crate::MusicService>().request(if purpose == "session" { "session-result" } else { "verification-result" }, serde_json::json!({"id":challenge,"cookies":cookies,"nonce":nonce,"token":token})) }
                            else { let _ = handle.state::<crate::MusicService>().request("verification-cancel", serde_json::json!({"id":challenge})); Err(error.to_string()) };
                        let retry_after = result.as_ref().ok().and_then(|value| value["retryAfter"].as_u64()).unwrap_or(0);
                        let message = result.as_ref().err().map(String::as_str).unwrap_or("");
                        notify(&handle, &challenge, &purpose, result.is_ok(), retry_after, message); let _ = view.close();
                    }
                });
                return false;
            }
            allowed(url) || url.as_str() == "about:blank"
        }).build().map_err(|_| "无法打开安全验证窗口")?;
    if let Some(cookies) = context["cookies"].as_array() {
        for value in cookies {
            if let (Some(name), Some(content)) = (value["name"].as_str(), value["value"].as_str()) {
                let cookie = tauri::webview::Cookie::build((name.to_owned(), content.to_owned())).domain(".qishui.com").path("/").secure(true)
                    .http_only(name.starts_with("session") || name.starts_with("sid_")).build();
                if verification.set_cookie(cookie).is_err() { let _ = verification.close(); return Err("无法载入官方验证会话".into()); }
            }
        }
    }
    let close_app = app.clone();
    let close_id = id.clone();
    verification.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) && !completed.swap(true, Ordering::SeqCst) {
            let handle = close_app.clone(); let challenge = close_id.clone(); let purpose = purpose.clone();
            std::thread::spawn(move || { let _ = handle.state::<crate::MusicService>().request("verification-cancel", serde_json::json!({"id":challenge})); notify(&handle, &challenge, &purpose, false, 0, "安全验证已取消，请重新获取验证码。"); });
        }
    });
    if verification.navigate(target).is_err() { let _ = verification.close(); return Err("无法加载官方验证".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn proxy_is_bound_to_the_current_window_and_origin() {
        let id = "11111111-1111-4111-8111-111111111111";
        let address = format!("https://rhine-qishui-http.localhost/request?id={id}&nonce=22222222-2222-4222-8222-222222222222&url=https%3A%2F%2Fmssdk.bytedance.com%2Fweb%2Fcommon");
        let label = format!("qishui-verification-{id}");
        let request = |origin: &str, size| tauri::http::Request::builder().uri(&address).header("Origin", origin).body(vec![0; size]).unwrap();
        assert!(super::proxy_identity(&label, &request("https://api.qishui.com", 0)).is_some());
        assert!(super::proxy_identity("main", &request("https://api.qishui.com", 0)).is_none());
        assert!(super::proxy_identity(&label, &request("https://evil.test", 0)).is_none());
        assert!(super::proxy_identity(&label, &request("https://api.qishui.com", 65537)).is_none());
    }
    #[test]
    fn verification_origins_are_restricted() {
        for url in ["https://api.qishui.com/verify", "https://verify.snssdk.com/captcha", "https://verify.zijieapi.com/"] { assert!(super::allowed(&url.parse().unwrap())); }
        for url in ["http://api.qishui.com/", "https://qishui.com.evil.test/", "https://evil.test/", "https://user@api.qishui.com/", "https://api.qishui.com:8443/"] { assert!(!super::allowed(&url.parse().unwrap())); }
    }
}
