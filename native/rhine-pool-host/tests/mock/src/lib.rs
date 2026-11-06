use serde_json::{json, Value};

#[no_mangle]
pub extern "C" fn rhine_pool_version() -> u32 { if mode() == "bad-version" { 99 } else { 1 } }
fn mode() -> String { std::env::var("RHINE_POOL_MOCK_MODE").unwrap_or_default() }
#[no_mangle]
pub unsafe extern "C" fn rhine_pool_call(input: *const u8, len: usize, output: *mut *mut u8, output_len: *mut usize) -> i32 {
    if input.is_null() || output.is_null() || output_len.is_null() || len > 1024 * 1024 { return 1; }
    if mode() == "crash" { std::process::exit(71); }
    if mode() == "oversize" { *output = std::ptr::dangling_mut(); *output_len = 2 * 1024 * 1024 + 1; return 0; }
    let request: Value = serde_json::from_slice(std::slice::from_raw_parts(input, len)).unwrap();
    let response = if mode() == "raw-error" { json!({"ok":false,"error":{"code":"https://never-output.invalid/private","message":"DO_NOT_OUTPUT"}}) }
    else if request["method"] == "status" { json!({"ok":true,"result":{"configured":true,"expiresAt":null,"moduleVersion":1}}) }
    else { json!({"ok":true,"result":{"method":request["method"],"args":request["args"]}}) };
    let bytes = if mode() == "bad-json" { b"invalid".to_vec() } else { serde_json::to_vec(&response).unwrap() };
    let bytes = bytes.into_boxed_slice();
    *output_len = bytes.len(); *output = Box::into_raw(bytes) as *mut u8;
    0
}
#[no_mangle]
pub unsafe extern "C" fn rhine_pool_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len))); }
}
