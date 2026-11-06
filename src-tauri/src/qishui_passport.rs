use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn notify(app: &tauri::AppHandle, id: &str, success: bool) {
    if let Some(main) = app.get_webview_window("main") {
        let detail = serde_json::json!({"id":id,"purpose":"request","success":success,"error":if success {""} else {"汽水安全请求未完成，请重新开始登录。"}});
        let _ = main.eval(&format!("window.dispatchEvent(new CustomEvent('rhine-qishui-verification',{{detail:{detail}}}))"));
    }
}

pub fn result_request(context: tauri::UriSchemeContext<'_, tauri::Wry>, request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let app = context.app_handle().clone();
    let label = context.webview_label().to_owned();
    std::thread::spawn(move || {
        let mut response = tauri::http::Response::builder().header("Cache-Control", "no-store");
        let origin = request.headers().get("origin").and_then(|value| value.to_str().ok());
        let url = tauri::Url::parse(&request.uri().to_string()).ok();
        let query: std::collections::HashMap<String, String> = url.as_ref().map(|url| url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect()).unwrap_or_default();
        let id = query.get("id").cloned().unwrap_or_default();
        let nonce = query.get("nonce").cloned().unwrap_or_default();
        let retry = url.as_ref().is_some_and(|url| url.path() == "/retry");
        if origin != Some("https://api.qishui.com") || !url.as_ref().is_some_and(|url| ["/result", "/retry"].contains(&url.path())) || label != format!("qishui-passport-{id}")
            || id.len() != 36 || nonce.len() != 36 || !id.chars().chain(nonce.chars()).all(|character| character.is_ascii_hexdigit() || character == '-') || request.body().len() > 1100000 {
            responder.respond(response.status(403).body(Vec::new()).unwrap()); return;
        }
        response = response.header("Access-Control-Allow-Origin", "https://api.qishui.com").header("Access-Control-Allow-Methods", "POST, OPTIONS").header("Access-Control-Allow-Headers", "content-type");
        if request.method() == tauri::http::Method::OPTIONS { responder.respond(response.status(204).body(Vec::new()).unwrap()); return; }
        if request.method() != tauri::http::Method::POST { responder.respond(response.status(405).body(Vec::new()).unwrap()); return; }
        let Ok(result) = serde_json::from_slice::<serde_json::Value>(request.body()) else { responder.respond(response.status(400).body(Vec::new()).unwrap()); return; };
        if retry {
            let result = app.state::<crate::MusicService>().request("passport-retry", serde_json::json!({"id":id,"nonce":nonce,"operationId":result["operationId"],"params":result["params"]}));
            responder.respond(response.header("Content-Type", "application/json").status(if result.is_ok() {200} else {409}).body(result.ok().map(|value| value.to_string().into_bytes()).unwrap_or_default()).unwrap()); return;
        }
        let Some(view) = app.get_webview_window(&label) else { responder.respond(response.status(409).body(Vec::new()).unwrap()); return; };
        let origin = "https://api.qishui.com/".parse().unwrap();
        let cookies: Vec<serde_json::Value> = view.cookies_for_url(origin).unwrap_or_default().iter().map(|cookie|
            serde_json::json!({"name":cookie.name(),"value":cookie.value(),"domain":cookie.domain().unwrap_or("api.qishui.com")})).collect();
        let accepted = app.state::<crate::MusicService>().request("passport-result", serde_json::json!({"id":id,"nonce":nonce,"result":result,"cookies":cookies})).is_ok();
        responder.respond(response.status(if accepted {200} else {409}).body(Vec::new()).unwrap());
    });
}

pub async fn open(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let handle = app.clone(); let challenge = id.clone();
    let context = tauri::async_runtime::spawn_blocking(move || handle.state::<crate::MusicService>().request("passport-context", serde_json::json!({"id":challenge})))
        .await.map_err(|_| "无法读取安全请求")??;
    let label = format!("qishui-passport-{id}");
    if let Some(view) = app.get_webview_window(&label) {
        return view.eval(&format!("window.__rhineQishuiPassport({context})")).map_err(|_| "无法继续安全请求".into());
    }
    let nonce = context["nonce"].as_str().ok_or("缺少请求标识")?.to_owned();
    let user_agent = context["userAgent"].as_str().ok_or("缺少客户端信息")?;
    let script = include_str!("qishui_webview.js").replacen("__RHINE_QISHUI_CONTEXT__", &context.to_string(), 1);
    let navigation_app = app.clone(); let navigation_id = id.clone(); let navigation_label = label.clone();
    let closed = Arc::new(AtomicBool::new(false)); let navigation_closed = closed.clone();
    let view = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External("https://api.qishui.com/passport/web/region/?aid=386088".parse().unwrap()))
        .visible(false).title("汽水音乐安全验证").inner_size(760.0, 640.0).min_inner_size(360.0, 400.0).use_https_scheme(true).user_agent(user_agent).initialization_script(&script)
        .on_navigation(move |url| {
            if url.scheme() == "rhine-qishui" {
                let query: std::collections::HashMap<_, _> = url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
                if query.get("nonce") != Some(&nonce) { return false; }
                if url.host_str() == Some("show") { if let Some(view) = navigation_app.get_webview_window(&navigation_label) { let _ = view.show(); let _ = view.set_focus(); } return false; }
                let action = url.host_str().unwrap_or("");
                if !["request-ready", "failed", "timeout"].contains(&action) { return false; }
                let handle = navigation_app.clone(); let id = navigation_id.clone(); let label = navigation_label.clone(); let nonce = nonce.clone(); let closed = navigation_closed.clone();
                let operation = query.get("operationId").cloned().unwrap_or_default(); let ready = action == "request-ready";
                std::thread::spawn(move || {
                    let success = ready && handle.state::<crate::MusicService>().request("passport-ready", serde_json::json!({"id":id,"nonce":nonce,"operationId":operation})).is_ok();
                    if !success { let _ = handle.state::<crate::MusicService>().request("verification-cancel", serde_json::json!({"id":id})); closed.store(true, Ordering::SeqCst); }
                    notify(&handle, &id, success);
                    if let Some(view) = handle.get_webview_window(&label) { if success { let _ = view.hide(); } else { let _ = view.close(); } }
                });
                return false;
            }
            url.scheme() == "https" && url.port().is_none() && url.username().is_empty() && url.password().is_none()
                && url.host_str().is_some_and(|host| ["qishui.com", "snssdk.com", "zijieapi.com"].iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}"))))
        }).build().map_err(|_| "无法创建汽水安全会话")?;
    view.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) && !closed.swap(true, Ordering::SeqCst) {
            let handle = app.clone(); let id = id.clone();
            std::thread::spawn(move || { let _ = handle.state::<crate::MusicService>().request("verification-cancel", serde_json::json!({"id":id})); notify(&handle, &id, false); });
        }
    });
    Ok(())
}
