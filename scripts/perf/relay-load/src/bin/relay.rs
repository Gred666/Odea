//! 本机起一台中继给 load 压（docs/协同编辑.md 附录 A.2）：官方 iroh-relay 的服务端，自签名证书。
//! 真实云主机上用官方程序 + relay.toml（docs/自建中继.md），不用这个。
//!
//!   cargo run --release --bin relay -- [--port 3443] [--token 令牌] [--quic]
//!
//! 打印地址和证书指纹；Ctrl+C 停。限定核数（模拟 2 核机器）：Linux 上 `taskset -c 0,1`，
//! Windows 上 `start /affinity 3`，再设 `TOKIO_WORKER_THREADS=2`。

use std::net::Ipv4Addr;
use std::sync::Arc;

use iroh_relay::server::{
    Access, AccessControl, ClientRequest, CertConfig, QuicConfig, RelayConfig, Server,
    ServerConfig, TlsConfig,
};

#[derive(Debug)]
struct TokenGate(Option<String>);

impl AccessControl for TokenGate {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        match &self.0 {
            Some(token) if request.auth_token().as_deref() != Some(token) => Access::Deny {
                reason: None,
            },
            _ => Access::Allow,
        }
    }
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
    let port: u16 = value("--port").and_then(|text| text.parse().ok()).unwrap_or(3443);
    let token = value("--token");
    let quic = args.iter().any(|arg| arg == "--quic");

    let (certs, server_config) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
    let mut relay = RelayConfig::new((Ipv4Addr::LOCALHOST, 0));
    relay.tls = Some(TlsConfig::new(
        (Ipv4Addr::UNSPECIFIED, port),
        CertConfig::Manual { server_config },
    ));
    relay.access = Arc::new(TokenGate(token.clone()));
    relay.key_cache_capacity = Some(65536);
    let mut config = ServerConfig::default();
    config.relay = Some(relay);
    if quic {
        config.quic = Some(QuicConfig::new((Ipv4Addr::UNSPECIFIED, 7842)));
    }
    let server = Server::spawn(config).await.expect("中继起不来");
    let digest = ring::digest::digest(&ring::digest::SHA256, certs[0].as_ref());
    // 绑的是所有网卡：别的机器用这台的 IP 连（本机就是 127.0.0.1）
    println!(
        "中继：https://<这台的地址>:{}  令牌：{}  证书指纹：{}",
        server.https_addr().expect("有 https 地址").port(),
        token.as_deref().unwrap_or("（不要令牌）"),
        data_encoding::HEXLOWER.encode(digest.as_ref())
    );
    tokio::signal::ctrl_c().await.ok();
    server.shutdown().await.ok();
}
