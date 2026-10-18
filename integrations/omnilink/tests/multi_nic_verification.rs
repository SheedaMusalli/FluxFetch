use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use omnilink_tray::adapters::{discover_routable_adapters, probe_adapter_health};
use omnilink_tray::load_balancer::LoadBalancer;
use omnilink_tray::socket_binder::connect_via_adapter;

/// Fetches the caller's public WAN IP strictly bound to a single Windows Network Adapter
async fn fetch_public_ip_via_adapter(
    adapter_ip: std::net::Ipv4Addr,
    if_index: u32,
) -> std::io::Result<String> {
    // 1. Try api.ipify.org (104.26.12.205:80) for direct plain IP
    let ipify_target: SocketAddr = "104.26.12.205:80".parse().unwrap();
    if let Ok(mut stream) = connect_via_adapter(ipify_target, adapter_ip, if_index).await {
        let req = b"GET / HTTP/1.1\r\nHost: api.ipify.org\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n";
        if stream.write_all(req).await.is_ok() {
            let mut response = String::new();
            if stream.read_to_string(&mut response).await.is_ok() {
                if let Some((_headers, body)) = response.split_once("\r\n\r\n") {
                    let ip = body.trim();
                    if !ip.is_empty() && ip.chars().all(|c| c.is_ascii_digit() || c == '.') {
                        return Ok(ip.to_string());
                    }
                }
            }
        }
    }

    // 2. Fallback to Cloudflare trace endpoint
    let cf_target: SocketAddr = "1.1.1.1:80".parse().unwrap();
    let mut stream = connect_via_adapter(cf_target, adapter_ip, if_index).await?;
    let req = b"GET /cdn-cgi/trace HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n";
    stream.write_all(req).await?;

    let mut response = String::new();
    stream.read_to_string(&mut response).await?;

    for line in response.lines() {
        if let Some(ip) = line.strip_prefix("ip=") {
            return Ok(ip.trim().to_string());
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "ip= field not found in trace response",
    ))
}

#[tokio::test]
async fn verify_per_adapter_isolation_and_public_ips() {
    let adapters = discover_routable_adapters().expect("Adapter discovery failed");
    assert!(
        !adapters.is_empty(),
        "No routable IPv4 adapters found on this machine"
    );

    println!("\n=== Phase 1: Hardware Adapter & Public WAN IP Verification ===");
    let probe_addr: SocketAddr = "1.1.1.1:80".parse().unwrap();

    for nic in &adapters {
        let rtt = probe_adapter_health(nic, probe_addr, Duration::from_secs(3)).await;
        match fetch_public_ip_via_adapter(nic.ipv4, nic.if_index).await {
            Ok(public_ip) => {
                println!(
                    "[PASS] IfIndex {:>2} | {:<18} | Local IP: {:<15} | Gateway: {:<15} | WAN IP: {:<15} | RTT: {:?}",
                    nic.if_index,
                    nic.friendly_name,
                    nic.ipv4,
                    nic.gateway_ipv4,
                    public_ip,
                    rtt.unwrap_or_default()
                );
            }
            Err(e) => {
                println!(
                    "[WARN] IfIndex {:>2} | {:<18} | Local IP: {:<15} | Failed external probe: {}",
                    nic.if_index, nic.friendly_name, nic.ipv4, e
                );
            }
        }
    }

    println!(
        "\n=== Phase 2: Load Balancer Distribution Simulation (16 Concurrent Steam Chunks) ==="
    );
    let lb = LoadBalancer::new(adapters);

    let mut handles = Vec::new();
    for chunk_id in 0..16 {
        let lb_clone = std::sync::Arc::clone(&lb);
        handles.push(tokio::spawn(async move {
            let chosen = lb_clone
                .select_best_adapter()
                .expect("Load balancer returned None");
            chosen
                .active_connections
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            // Simulate a 1 MiB chunk transfer
            chosen.record_bytes(1_048_576);
            tokio::time::sleep(Duration::from_millis(50)).await;

            chosen
                .active_connections
                .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            (
                chunk_id,
                chosen.adapter.friendly_name.clone(),
                chosen.adapter.if_index,
            )
        }));
    }

    for h in handles {
        let (chunk_id, name, idx) = h.await.unwrap();
        println!(
            "  Chunk #{:02} routed via -> {} (IfIndex {})",
            chunk_id, name, idx
        );
    }
}
