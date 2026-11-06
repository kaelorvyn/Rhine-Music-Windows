use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const MAX_INPUT: usize = 1024 * 1024;
const MAX_OUTPUT: usize = 2 * 1024 * 1024;
const METHODS: &[&str] = &["status", "lines", "probeLines", "probeUpstreams", "resolve", "invalidate", "shutdown"];

fn failure(id: Value, code: &str) -> Value {
    json!({"id":id,"ok":false,"error":{"code":code,"message":"Pool module unavailable"}})
}

// Read at most one bounded frame; drain oversized frames without allocating them.
fn frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return if out.is_empty() && !oversized { Ok(None) } else { Ok(Some(if oversized { Vec::new() } else { out })) };
        }
        let end = chunk.iter().position(|&b| b == b'\n');
        let take = end.unwrap_or(chunk.len());
        if !oversized && out.len() + take <= MAX_INPUT { out.extend_from_slice(&chunk[..take]); }
        else { oversized = true; out.clear(); }
        reader.consume(take + usize::from(end.is_some()));
        if end.is_some() { return Ok(Some(if oversized { Vec::new() } else { out })); }
    }
}

#[cfg(windows)]
mod dll {
    use super::*;
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path};
    use windows_sys::Win32::{Foundation::HMODULE, System::{LibraryLoader::*, Diagnostics::Debug::*}};
    type Call = unsafe extern "C" fn(*const u8, usize, *mut *mut u8, *mut usize) -> i32;
    type Free = unsafe extern "C" fn(*mut u8, usize);
    pub struct Module { handle: HMODULE, call: Call, free: Free }
    impl Drop for Module { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::FreeLibrary(self.handle); } } }
    impl Module {
        pub fn load(path: &OsStr) -> Result<Self, &'static str> {
            let path = Path::new(path);
            // is_absolute alone accepts root-relative paths on some platforms; canonicalize only after checking it.
            if !path.is_absolute() || !path.is_file() || !path.extension().is_some_and(|x| x.eq_ignore_ascii_case("dll")) { return Err("invalid_module_path"); }
            let path = path.canonicalize().map_err(|_| "invalid_module_path")?;
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            unsafe {
                SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
                if SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) == 0 { return Err("module_load_failed"); }
                // Only this absolute module directory and Windows System32 can supply dependencies.
                let handle = LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
                if handle.is_null() { return Err("module_load_failed"); }
                let result = (|| {
                    let version: unsafe extern "C" fn() -> u32 = std::mem::transmute(GetProcAddress(handle, c"rhine_pool_version".as_ptr().cast()).ok_or("module_abi_invalid")?);
                    if version() != 1 { return Err("module_abi_invalid"); }
                    let call: Call = std::mem::transmute(GetProcAddress(handle, c"rhine_pool_call".as_ptr().cast()).ok_or("module_abi_invalid")?);
                    let free: Free = std::mem::transmute(GetProcAddress(handle, c"rhine_pool_free".as_ptr().cast()).ok_or("module_abi_invalid")?);
                    Ok(Self { handle, call, free })
                })();
                if result.is_err() { windows_sys::Win32::Foundation::FreeLibrary(handle); }
                result
            }
        }
        pub fn call(&self, request: &[u8]) -> Result<Value, &'static str> {
            unsafe {
                let mut ptr = std::ptr::null_mut();
                let mut len = 0;
                let rc = (self.call)(request.as_ptr(), request.len(), &mut ptr, &mut len);
                // A foreign pointer/length cannot be made safe in-process. Bad ABI terminates this child.
                if ptr.is_null() || len == 0 || len > MAX_OUTPUT || len > isize::MAX as usize {
                    std::process::exit(70);
                }
                let parsed = if rc == 0 { serde_json::from_slice(std::slice::from_raw_parts(ptr, len)).ok() } else { None };
                (self.free)(ptr, len);
                parsed.ok_or("module_response_invalid")
            }
        }
    }
}

fn reply(module: &dll::Module, bytes: &[u8]) -> (Value, bool) {
    let request: Value = match serde_json::from_slice(bytes) { Ok(v) => v, Err(_) => return (failure(Value::Null, if bytes.is_empty() { "invalid_request_or_size" } else { "invalid_request" }), false) };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    if !(id.is_string() || id.is_number()) || !request.is_object() || !args.is_object() {
        return (failure(id, "invalid_request"), false);
    }
    if !METHODS.contains(&method) { return (failure(id, "unsupported_method"), false); }
    let input = serde_json::to_vec(&json!({"method":method,"args":args})).unwrap();
    if input.len() > MAX_INPUT { return (failure(id, "request_too_large"), false); }
    let result = match module.call(&input) {
        Ok(v) if v.get("ok") == Some(&Value::Bool(true)) && v.get("result").is_some_and(Value::is_object) => json!({"id":id,"ok":true,"result":v["result"]}),
        Ok(v) if v.get("ok") == Some(&Value::Bool(false)) => {
            let code = v["error"]["code"].as_str().unwrap_or("");
            let allowed = ["module_expired", "module_unconfigured", "module_stopped", "invalid_args", "unsupported_method", "pool_unavailable", "no_audio", "internal_error"];
            failure(id, if allowed.contains(&code) { code } else { "module_call_failed" })
        }
        _ => failure(id, "module_response_invalid"),
    };
    (result, method == "shutdown")
}

#[cfg(windows)]
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut args = std::env::args_os().skip(1);
    let path = args.next();
    let module = path.filter(|_| args.next().is_none()).ok_or("invalid_module_path").and_then(|p| dll::Module::load(&p));
    let module = match module {
        Ok(m) => m,
        Err(code) => { let _ = writeln!(io::stdout(), "{}", failure(Value::Null, code)); std::process::exit(64); }
    };
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Ok(Some(bytes)) = frame(&mut input) {
        let (mut result, stop) = reply(&module, &bytes);
        let mut encoded = serde_json::to_vec(&result).unwrap();
        if encoded.len() + 1 > MAX_OUTPUT {
            result = failure(result["id"].clone(), "module_response_too_large");
            encoded = serde_json::to_vec(&result).unwrap();
        }
        if output.write_all(&encoded).and_then(|_| output.write_all(b"\n")).and_then(|_| output.flush()).is_err() { break; }
        if stop { break; }
    }
}

#[cfg(not(windows))]
compile_error!("rhine-pool-host requires Windows");

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_frames_recover_and_accept_exact_limit() {
        let mut stream = vec![b'x'; MAX_INPUT + 1];
        stream.extend_from_slice(b"\n{}\n");
        let mut reader = io::Cursor::new(stream);
        assert_eq!(frame(&mut reader).unwrap(), Some(vec![]));
        assert_eq!(frame(&mut reader).unwrap(), Some(b"{}".to_vec()));
        assert_eq!(frame(&mut reader).unwrap(), None);
        assert_eq!(frame(&mut io::Cursor::new(vec![b'x'; MAX_INPUT])).unwrap().unwrap().len(), MAX_INPUT);
    }
}
