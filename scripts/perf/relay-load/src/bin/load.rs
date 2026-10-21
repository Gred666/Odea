//! 中继压测（docs/协同编辑.md 附录 A.2）：N 个中继客户端两两配对，按固定频率互发小包（前 8 字节是
//! 发出的时刻），量收到率和延迟。先空闲一会儿（这时看服务器的内存），再发。
//!
//!   cargo run --release --bin load -- --url https://relay.example.com [--token 令牌] [--insecure]
//!       [--clients 1000] [--rate 2] [--size 100] [--idle 10] [--secs 20]
//!
//! --rate 是每个客户端每秒发几个；--insecure 不校验证书（本机的 relay 是自签名的）。
//! 压测程序和中继别放在同一台机器上（除非就是想量本机回环），离中继近一点，延迟里才主要是中继自己的。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use iroh_base::{RelayUrl, SecretKey};
use iroh_dns::dns::DnsResolver;
use iroh_relay::client::ClientBuilder;
use iroh_relay::protos::relay::{ClientToRelayMsg, Datagrams, RelayToClientMsg};
use iroh_relay::tls::CaTlsConfig;
use n0_future::{SinkExt, StreamExt};

struct Stats {
    sent: AtomicU64,
    received: AtomicU64,
    /// 微秒
    latencies: Mutex<Vec<u64>>,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let number = |name: &str, default: u64| {
        value(name)
            .and_then(|text| text.parse::<u64>().ok())
            .unwrap_or(default)
    };
    let url: RelayUrl = value("--url")
        .expect("要 --url https://…")
        .parse()
        .expect("--url 不对");
    let token = value("--token");
    let insecure = args.iter().any(|arg| arg == "--insecure");
    let clients = (number("--clients", 100) as usize / 2 * 2).max(2);
    let rate = number("--rate", 2).max(1);
    let size = (number("--size", 100) as usize).max(8);
    let idle = number("--idle", 10);
    let secs = number("--secs", 20);

    let provider = iroh_relay::tls::default_provider();
    let tls = if insecure {
        CaTlsConfig::insecure_skip_verify()
    } else {
        CaTlsConfig::embedded()
    }
    .client_config(provider)
    .expect("TLS 配置");
    let dns = DnsResolver::new();

    // 连上：一次 50 个，免得同一刻上千个 TLS 握手
    let started = Instant::now();
    let keys: Vec<SecretKey> = (0..clients).map(|_| SecretKey::generate()).collect();
    let mut connected = Vec::with_capacity(clients);
    for batch in keys.chunks(50) {
        let tasks: Vec<_> = batch
            .iter()
            .cloned()
            .map(|key| {
                let mut builder = ClientBuilder::new(url.clone(), key, dns.clone())
                    .tls_client_config(tls.clone());
                if let Some(token) = &token {
                    builder = builder.auth_token(token.clone());
                }
                tokio::spawn(async move { builder.connect().await })
            })
            .collect();
        for task in tasks {
            match task.await.expect("任务崩了") {
                Ok(client) => connected.push(client),
                Err(error) => {
                    eprintln!("连不上中继：{error}");
                    std::process::exit(1);
                }
            }
        }
    }
    println!(
        "{clients} 个客户端连上了，用了 {:.1} 秒；空闲 {idle} 秒（这时看服务器的内存）",
        started.elapsed().as_secs_f64()
    );
    tokio::time::sleep(Duration::from_secs(idle)).await;

    let stats = Arc::new(Stats {
        sent: AtomicU64::new(0),
        received: AtomicU64::new(0),
        latencies: Mutex::new(Vec::new()),
    });
    let epoch = Instant::now();
    let until = epoch + Duration::from_secs(secs);
    let mut tasks = Vec::new();
    for (index, client) in connected.into_iter().enumerate() {
        // 0↔1、2↔3……
        let partner = keys[index ^ 1].public();
        let (mut stream, mut sink) = client.split();
        let stats_rx = stats.clone();
        tasks.push(tokio::spawn(async move {
            while let Ok(Some(Ok(message))) =
                tokio::time::timeout(Duration::from_secs(3), stream.next()).await
            {
                if let RelayToClientMsg::Datagrams { datagrams, .. } = message {
                    let bytes = datagrams.contents;
                    if bytes.len() >= 8 {
                        let sent = u64::from_le_bytes(bytes[..8].try_into().unwrap());
                        let now = epoch.elapsed().as_micros() as u64;
                        stats_rx.received.fetch_add(1, Ordering::Relaxed);
                        stats_rx
                            .latencies
                            .lock()
                            .unwrap()
                            .push(now.saturating_sub(sent));
                    }
                }
                if Instant::now() > until + Duration::from_secs(2) {
                    break;
                }
            }
        }));
        let stats_tx = stats.clone();
        tasks.push(tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_micros(1_000_000 / rate));
            // 各自错开起步，免得所有人在同一个毫秒发
            tokio::time::sleep(Duration::from_micros(index as u64 * 997 % (1_000_000 / rate))).await;
            while Instant::now() < until {
                tick.tick().await;
                let mut payload = vec![0u8; size];
                let now = epoch.elapsed().as_micros() as u64;
                payload[..8].copy_from_slice(&now.to_le_bytes());
                let message = ClientToRelayMsg::Datagrams {
                    dst_endpoint_id: partner,
                    datagrams: Datagrams::from(payload),
                };
                if sink.send(message).await.is_err() {
                    break;
                }
                stats_tx.sent.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }
    for task in tasks {
        let _ = task.await;
    }

    let sent = stats.sent.load(Ordering::Relaxed);
    let received = stats.received.load(Ordering::Relaxed);
    let mut latencies = std::mem::take(&mut *stats.latencies.lock().unwrap());
    latencies.sort_unstable();
    let pick = |q: f64| {
        latencies
            .get(((latencies.len() as f64 - 1.0) * q).round() as usize)
            .map_or(f64::NAN, |micros| *micros as f64 / 1000.0)
    };
    println!(
        "客户端 {clients} · 每个每秒 {rate} · 合计每秒 {:.0} · 包 {size} 字节",
        sent as f64 / secs as f64
    );
    println!(
        "收到 {received} / 发出 {sent}（丢 {:.1}%）· 延迟 中位 {:.2} / p99 {:.2} / 最大 {:.2} ms",
        if sent == 0 {
            0.0
        } else {
            100.0 * (1.0 - received as f64 / sent as f64)
        },
        pick(0.5),
        pick(0.99),
        pick(1.0),
    );
}
