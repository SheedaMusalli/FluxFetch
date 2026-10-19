//! Elevated, controlled ETW verification. No launcher or driver configuration is changed.
use omnilink_tray::traffic_observer::{FlowKey, TrafficObserver};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::process::{Command, Stdio};
use std::time::Duration;

const TCP_BYTES: usize = 2 * 1024 * 1024;
const UDP_PACKETS: usize = 128;
const UDP_SIZE: usize = 2048;

fn receiver(kind: &str, address: &str) -> Result<(), Box<dyn std::error::Error>> {
    if kind.starts_with("tcp") {
        let mut stream = TcpStream::connect(address)?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        println!("READY");
        std::io::stdout().flush()?;
        let mut signal = String::new();
        std::io::stdin().read_line(&mut signal)?;
        let mut data = Vec::new();
        stream.read_to_end(&mut data)?;
        if data.len() != TCP_BYTES || data.iter().any(|&b| b != 17) {
            return Err("Incorrect TCP payload".into());
        }
    } else {
        let socket = UdpSocket::bind(address)?;
        socket.set_read_timeout(Some(Duration::from_secs(10)))?;
        println!("{}", socket.local_addr()?);
        std::io::stdout().flush()?;
        let mut signal = String::new();
        std::io::stdin().read_line(&mut signal)?;
        let mut buffer = [0u8; 4096];
        for _ in 0..UDP_PACKETS {
            let size = socket.recv(&mut buffer)?;
            if size != UDP_SIZE || buffer[..size].iter().any(|&b| b != 17) {
                return Err("Incorrect UDP payload".into());
            }
        }
    }
    Ok(())
}

fn scenario(kind: &str, proxy: bool) -> Result<String, Box<dyn std::error::Error>> {
    let host = if kind.ends_with('6') {
        "[::1]:0"
    } else {
        "127.0.0.1:0"
    };
    let tcp = kind.starts_with("tcp");
    let listener = TcpListener::bind(host)?;
    let mut child = Command::new(std::env::current_exe()?)
        .args([
            "--receiver",
            kind,
            &if tcp {
                listener.local_addr()?.to_string()
            } else {
                host.into()
            },
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready)?;
    if ready.is_empty() {
        return Err("Receiver did not start".into());
    }
    let client = if tcp {
        Some(listener.accept()?.0)
    } else {
        None
    };
    // For TCP, the connection deliberately exists BEFORE the trace is started.
    let observer = TrafficObserver::with_options(HashSet::from([child.id()]), true);
    std::thread::sleep(Duration::from_millis(1500));
    let baseline = observer.sample();
    if !baseline.healthy {
        let _ = child.kill();
        return Err(baseline.status.into());
    }
    let mut guard = None;
    let mut relay_thread = None;
    let sender = if let Some(mut client) = client {
        if proxy {
            let source = TcpListener::bind(host)?;
            let mut upstream = TcpStream::connect(source.local_addr()?)?;
            let source_peer = source.accept()?.0;
            guard = Some(observer.register_proxy(
                Some(FlowKey {
                    protocol: 6,
                    local: client.peer_addr()?,
                    remote: client.local_addr()?,
                }),
                FlowKey {
                    protocol: 6,
                    local: upstream.local_addr()?,
                    remote: source.local_addr()?,
                },
            ));
            relay_thread = Some(std::thread::spawn(move || {
                std::io::copy(&mut upstream, &mut client).unwrap()
            }));
            Some(source_peer)
        } else {
            Some(client)
        }
    } else {
        None
    };
    child.stdin.as_mut().unwrap().write_all(b"GO\n")?;
    let destination = ready.trim().to_owned();
    let send_thread = std::thread::spawn(move || {
        if let Some(mut sender) = sender {
            for _ in 0..32 {
                sender.write_all(&vec![17u8; TCP_BYTES / 32]).unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
        } else {
            let socket = UdpSocket::bind(host).unwrap();
            for _ in 0..UDP_PACKETS {
                socket.send_to(&[17u8; UDP_SIZE], &destination).unwrap();
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    });
    let mut bytes = 0;
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(500));
        let sample = observer.sample();
        if !sample.healthy {
            let _ = child.kill();
            return Err(sample.status.into());
        }
        bytes += sample.bytes;
    }
    send_thread.join().unwrap();
    if let Some(thread) = relay_thread {
        thread.join().unwrap();
    }
    drop(guard);
    if !child.wait()?.success() {
        return Err("Receiver payload validation failed".into());
    }
    observer.stop();
    let expected = if tcp {
        TCP_BYTES
    } else {
        UDP_PACKETS * UDP_SIZE
    } as u64;
    // Packet accounting may include transport overhead; reject missing or doubled traffic.
    if bytes < expected * 95 / 100 || bytes > expected * 120 / 100 {
        return Err(format!(
            "{kind} proxy={proxy}: expected approximately {expected}, observed {bytes}"
        )
        .into());
    }
    Ok(format!(
        "PASS {kind} proxy={proxy}: payload={expected}, observed={bytes}"
    ))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--receiver") {
        if let Err(error) = receiver(&args[2], &args[3]) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let path = args
        .get(1)
        .map(String::as_str)
        .unwrap_or("observer-verification.txt");
    let mut report = String::new();
    for (kind, proxy) in [
        ("tcp4", false),
        ("tcp6", false),
        ("udp4", false),
        ("udp6", false),
        ("tcp4", true),
    ] {
        match scenario(kind, proxy) {
            Ok(line) => {
                report.push_str(&format!("{line}\n"));
                let _ = std::fs::write(path, &report);
            }
            Err(error) => {
                report.push_str(&format!("FAIL {error}\n"));
                let _ = std::fs::write(path, report);
                std::process::exit(1);
            }
        }
    }
}
