use super::*;

#[test]
fn update_script_quotes_paths_and_cleans_only_after_restart() {
    assert_eq!(ps_literal(Path::new("D:\\a'b")), "'D:\\a''b'");
    let script = apply_script(Path::new("C:\\Temp\\rhine-update\\run-1-2"), Path::new("C:\\Temp\\rhine-update\\run-1-2\\staging"), Path::new("D:\\Music"), Path::new("D:\\Music\\app.exe"), 123);
    assert!(script.contains("-WindowStyle Hidden -Wait -PassThru"));
    assert!(!script.contains("cmd /"));
    assert!(script.find("Remove-Item -LiteralPath $work").unwrap() > script.find("$restarted.WaitForExit(2000)").unwrap());
    assert!(script.contains("Assert-OwnedWork"));
    assert!(script.contains("/XJ"));
    assert!(script.find("File-Digest $exe").unwrap() < script.find("$restarted = Start-Process").unwrap());
}

#[cfg(windows)]
#[test]
fn hidden_update_worker_copies_restarts_and_removes_its_download() {
    run_update_fixture("app.exe");
}

#[cfg(windows)]
#[test]
fn hidden_update_worker_replaces_original_entry_when_package_name_differs() {
    run_update_fixture("Rhine Music.exe");
}

#[cfg(windows)]
fn run_update_fixture(package_name: &str) {
    let work = create_update_work().unwrap();
    let fixture = std::env::temp_dir().join(format!("rhine-update-test-{}", work.file_name().unwrap().to_string_lossy()));
    let payload = work.join("staging");
    let target = fixture.join("app");
    fs::create_dir_all(&payload).unwrap(); fs::create_dir_all(&target).unwrap();
    let source = fixture.join("probe.rs");
    fs::write(&source, r##"#![windows_subsystem = "windows"]
fn main() {
 let path = std::env::current_exe().unwrap().parent().unwrap().join("restarted.txt");
 std::fs::write(path, "ok").unwrap();
 std::thread::sleep(std::time::Duration::from_secs(6));
}"##).unwrap();
    let result = spawn_hidden(Command::new("rustc").arg("--crate-name").arg("update_probe").arg(&source).arg("-o").arg(payload.join(package_name))).output().unwrap();
    assert!(result.status.success(), "synthetic GUI helper did not compile");
    let expected = fs::read(payload.join(package_name)).unwrap();
    fs::write(target.join("app.exe"), "old-program-version").unwrap();
    prepare_payload_executable(&payload, "app.exe").unwrap();
    fs::write(work.join("update.zip"), "synthetic-package").unwrap();
    let script = work.join("apply.ps1");
    fs::write(&script, format!("\u{feff}{}", apply_script(&work, &payload, &target, &target.join("app.exe"), 2147483647))).unwrap();
    let mut child = apply_command(&script, &work.join("worker.log")).unwrap().spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(status.success(), "worker failed; diagnostic files preserved"); break; }
        if std::time::Instant::now() > deadline { child.kill().unwrap(); panic!("update worker timeout"); }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(fs::read_to_string(target.join("restarted.txt")).unwrap(), "ok");
    assert_eq!(fs::read(target.join("app.exe")).unwrap(), expected);
    assert!(!work.exists(), "successful update must remove its ZIP and staging");
    // The synthetic app directory is retained, never confused with updater-owned cleanup.
}
