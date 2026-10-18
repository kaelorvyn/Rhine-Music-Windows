// 设备探测：确认本机 cpal 能打开 WASAPI 输出设备、并真正消费到样本。
// 这是「用 Rust 原生播放」这条路的 go/no-go —— 只要 cpal 能回调，
// 后面 symphonia 解码 + rodio 播放就有落点。
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

fn main() {
    let host = cpal::default_host();
    println!("host = {:?}", host.id());

    match host.default_output_device() {
        None => println!("NO_DEFAULT_DEVICE"),
        Some(dev) => {
            println!("default = {}", dev.name().unwrap_or_else(|_| "?".into()));
            match dev.default_output_config() {
                Err(e) => println!("NO_CONFIG: {e}"),
                Ok(cfg) => {
                    println!(
                        "config = {:?} rate={} ch={}",
                        cfg.sample_format(),
                        cfg.sample_rate().0,
                        cfg.channels()
                    );
                    let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
                    let seen = counter.clone();
                    let conf: cpal::StreamConfig = cfg.clone().into();
                    let stream = dev.build_output_stream(
                        &conf,
                        move |data: &mut [f32], _| {
                            for s in data.iter_mut() {
                                *s = 0.0;
                            }
                            seen.fetch_add(data.len(), std::sync::atomic::Ordering::Relaxed);
                        },
                        |e| eprintln!("stream err: {e}"),
                        None,
                    );
                    match stream {
                        Err(e) => println!("BUILD_FAIL: {e}"),
                        Ok(s) => {
                            match s.play() {
                                Ok(_) => println!("PLAY_OK"),
                                Err(e) => println!("PLAY_FAIL: {e}"),
                            }
                            std::thread::sleep(std::time::Duration::from_millis(700));
                            let consumed = counter.load(std::sync::atomic::Ordering::Relaxed);
                            println!("consumed_frames = {consumed}");
                            println!(
                                "RESULT = {}",
                                if consumed > 0 { "OK" } else { "NO_CALLBACK" }
                            );
                        }
                    }
                }
            }
        }
    }

    println!("--- all output devices ---");
    if let Ok(list) = host.output_devices() {
        for (i, d) in list.enumerate() {
            let n = d.name().unwrap_or_else(|_| "?".into());
            let c = d
                .default_output_config()
                .map(|c| format!("{}Hz/{}ch", c.sample_rate().0, c.channels()))
                .unwrap_or_else(|_| "?".into());
            println!("  [{i}] {n}  {c}");
        }
    }
}
