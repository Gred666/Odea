/* ============================================================
用户自己配的中继（docs/协同编辑.md §6）。我们不提供中继，代码里也不出现 n0 的。

- 一台中继 = 地址 + 可选的令牌 + 可选的证书指纹（自签名证书时）+ 可选的名字
- 中继码 `odea://relay/<票据>`：一个人架好，把码发给全组，每人粘贴一次。它决定了以后连接的
  元数据经过谁的机器，所以添加之前一定要用户确认（前端问）
- 地址、名字、指纹记在应用数据目录的 config.json，令牌放系统钥匙串（命令层管存取，这里不碰）
- 证书：带了指纹的只认那一张（自签名），没带的照常按内置的 CA 根证书校验（Let's Encrypt）
- 测试：单独起一个只连这一台的端点，报告连没连上、延迟、令牌对不对、UDP 7842 通不通
- 版本对不上（§6.6）：iroh-relay 不认 Odea 说的协议版本时回 400（正文里说它支持哪几版），
  或者回一个 Odea 认不出的版本。认出来直接说，不说成泛泛的「连不上」
============================================================ */

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use iroh::endpoint::presets;
use iroh::tls::CaTlsConfig;
use iroh::unstable_net_report::Probe;
use iroh::{Endpoint, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey, Watcher};
use iroh_relay::RelayQuicConfig;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};

use super::ticket::{self, LinkError};

const CODE_PREFIX: &str = "odea://relay/";
const CODE_VERSION: u8 = 1;

/// 一台中继
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Relay {
    /// 规范化过的地址（`https://relay.example.com/`），也是它的身份
    pub url: String,
    pub token: Option<String>,
    /// 自签名证书（DER）的 SHA-256
    pub fingerprint: Option<[u8; 32]>,
    /// 给人看的名字（「公司的中继」），没有就显示主机名
    pub name: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RelayError {
    #[error("中继地址不对：{0}")]
    BadUrl(String),
    #[error("证书指纹不对：要 64 位十六进制（SHA-256），可以带冒号")]
    BadFingerprint,
}

impl Relay {
    /// 用户填的：地址可以不写 https://，指纹是十六进制（带不带冒号都行）
    pub fn new(
        url: &str,
        token: Option<String>,
        fingerprint: Option<&str>,
        name: Option<String>,
    ) -> Result<Relay, RelayError> {
        let fingerprint = match fingerprint.map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => Some(parse_fingerprint(text).ok_or(RelayError::BadFingerprint)?),
            None => None,
        };
        let clean = |text: Option<String>| {
            text.map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
        };
        Ok(Relay {
            url: normalize_url(url)?,
            token: clean(token),
            fingerprint,
            name: clean(name).map(|name| name.chars().take(40).collect()),
        })
    }

    pub fn relay_url(&self) -> Result<RelayUrl, RelayError> {
        self.url
            .parse()
            .map_err(|_| RelayError::BadUrl(self.url.clone()))
    }

    /// 给人看的：`relay.example.com`（不是默认端口的带上端口）
    pub fn host(&self) -> String {
        display_host(&self.url)
    }

    pub fn label(&self) -> String {
        self.name.clone().unwrap_or_else(|| self.host())
    }

    pub fn to_code(&self) -> String {
        let mut bytes = vec![CODE_VERSION];
        bytes.extend(super::protocol::encode(self));
        ticket::encode_link(CODE_PREFIX, &bytes)
    }

    pub fn parse_code(text: &str) -> Result<Relay, LinkError> {
        let bytes = ticket::decode_link(text, CODE_PREFIX, &["odea:relay/"])?;
        match bytes.split_first() {
            Some((&CODE_VERSION, rest)) => {
                let relay: Relay =
                    super::protocol::decode(rest).map_err(|_| LinkError::Malformed)?;
                // 码是别人给的：照用户填的一样再规范化、校验一遍
                let fingerprint = relay
                    .fingerprint
                    .map(|pin| data_encoding::HEXLOWER.encode(&pin));
                Relay::new(&relay.url, relay.token, fingerprint.as_deref(), relay.name)
                    .map_err(|_| LinkError::Malformed)
            }
            Some((version, _)) if *version > CODE_VERSION => Err(LinkError::TooNew),
            _ => Err(LinkError::Malformed),
        }
    }

    pub fn config(&self) -> Option<RelayConfig> {
        let url = self.relay_url().ok()?;
        // QUIC 地址发现走 UDP 7842（官方 iroh-relay 的默认端口）：通的话打洞才有人介绍
        let config = RelayConfig::new(url, Some(RelayQuicConfig::default()));
        Some(match &self.token {
            Some(token) => config.with_auth_token(token.clone()),
            None => config,
        })
    }
}

/// `relay.example.com` → `https://relay.example.com/`。只认 https：中继本身就是 TLS 上的
fn normalize_url(text: &str) -> Result<String, RelayError> {
    let text = text.trim().trim_end_matches('/');
    if text.is_empty() {
        return Err(RelayError::BadUrl("没填".into()));
    }
    let with_scheme = if text.contains("://") {
        text.to_string()
    } else {
        format!("https://{text}")
    };
    let url = url_parse(&with_scheme).ok_or_else(|| RelayError::BadUrl(text.to_string()))?;
    if url.scheme() != "https" {
        return Err(RelayError::BadUrl("要 https:// 开头".into()));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(RelayError::BadUrl(text.to_string()));
    }
    // 路径、查询、用户名这些中继用不上，去掉；主机名统一小写（Url 已经做了）
    let mut clean = url.clone();
    clean.set_path("/");
    clean.set_query(None);
    clean.set_fragment(None);
    let _ = clean.set_username("");
    let _ = clean.set_password(None);
    Ok(clean.to_string())
}

fn url_parse(text: &str) -> Option<url::Url> {
    url::Url::parse(text).ok()
}

pub fn display_host(url: &str) -> String {
    match url_parse(url) {
        Some(url) => {
            let host = url.host_str().unwrap_or_default().trim_end_matches('.');
            match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            }
        }
        None => url.to_string(),
    }
}

/// 十六进制的 SHA-256，冒号、空格、大小写都不管
pub fn parse_fingerprint(text: &str) -> Option<[u8; 32]> {
    let hex: String = text
        .chars()
        .filter(|c| !matches!(c, ':' | ' ' | '-'))
        .collect::<String>()
        .to_ascii_lowercase();
    let bytes = data_encoding::HEXLOWER.decode(hex.as_bytes()).ok()?;
    <[u8; 32]>::try_from(bytes.as_slice()).ok()
}

pub fn fingerprint_of(der: &[u8]) -> [u8; 32] {
    let digest = ring::digest::digest(&ring::digest::SHA256, der);
    let mut out = [0; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

/* ---------------- 接到 iroh 端点上 ---------------- */

pub fn relay_mode(relays: &[Relay]) -> RelayMode {
    let configs: Vec<RelayConfig> = relays.iter().filter_map(Relay::config).collect();
    if configs.is_empty() {
        RelayMode::Disabled
    } else {
        RelayMode::Custom(configs.into_iter().collect::<RelayMap>())
    }
}

/// 按主机名记的证书指纹。主持人中途按回连链接加进来的中继也要认，所以做成能往里加的
pub type Pins = Arc<RwLock<HashMap<String, [u8; 32]>>>;

pub fn pins(relays: &[Relay]) -> Pins {
    let pins = Pins::default();
    for relay in relays {
        add_pin(&pins, relay);
    }
    pins
}

pub fn add_pin(pins: &Pins, relay: &Relay) {
    let host = url_parse(&relay.url).and_then(|url| url.host_str().map(clean_host));
    if let (Some(host), Some(pin)) = (host, relay.fingerprint) {
        pins.write().unwrap().insert(host, pin);
    }
}

/// 证书校验：带了指纹的主机只认那一张证书，其余的照常按内置的 CA 根证书（和 iroh 默认的一样）
pub fn tls_config(pins: Pins) -> CaTlsConfig {
    CaTlsConfig::custom_server_cert_verifier(Arc::new(move |provider: Arc<CryptoProvider>| {
        let fallback = CaTlsConfig::embedded().server_cert_verifier(provider.clone())?;
        Ok(Arc::new(PinnedVerifier {
            pins: pins.clone(),
            fallback,
            provider,
        }) as Arc<dyn ServerCertVerifier>)
    }))
}

/// 主机名比较前：小写、去掉末尾的点、IPv6 去掉方括号
fn clean_host(host: &str) -> String {
    host.trim_end_matches('.')
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

#[derive(Debug)]
struct PinnedVerifier {
    pins: Pins,
    fallback: Arc<dyn ServerCertVerifier>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let host = match server_name {
            ServerName::DnsName(name) => clean_host(name.as_ref()),
            ServerName::IpAddress(ip) => std::net::IpAddr::from(*ip).to_string(),
            _ => String::new(),
        };
        let pin = self.pins.read().unwrap().get(&host).copied();
        match pin {
            // 只认这一张：自签名证书没有 CA，有效期、主机名也不再看（指纹就是全部的信任）
            Some(pin) if fingerprint_of(end_entity.as_ref()) == pin => {
                Ok(ServerCertVerified::assertion())
            }
            Some(_) => Err(rustls::Error::General(
                "中继的证书和中继码里的指纹对不上".into(),
            )),
            None => self.fallback.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            ),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/* ---------------- 测试一台中继（设计 §6.4 第 3 条） ---------------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RelayCheck {
    pub connected: bool,
    /// 到它的延迟（毫秒，网络报告量的）
    pub latency_ms: Option<u32>,
    /// 令牌被拒：中继给的原因
    pub denied: Option<String>,
    /// 连不上：最近一次的错误
    pub error: Option<String>,
    /// QUIC 地址发现（UDP 7842）通不通。不通的话转发照样能用，但打洞没人介绍了。None = 没量出来
    pub udp: Option<bool>,
    /// 中继的版本和 Odea 不配套（§6.6）：它支持的协议版本（问出来了的话，比如 `iroh-relay-v3`），
    /// 问不出来是空串
    pub outdated: Option<String>,
}

/// 连中继的错误连同起因：iroh 最外层只说「Failed to connect to relay server」，为什么在里面
pub fn error_text(error: &dyn std::fmt::Display) -> String {
    format!("{error:#}")
}

/// 连中继时的错误是不是「版本对不上」那一类：回了认不出的协议版本，或者拒了 WebSocket 升级（400）。
/// Odea 发的升级请求头都是对的，iroh-relay 回 400 剩下的原因只有协议版本对不上 —— 或者中继前面的
/// 反向代理没把升级请求原样转过去。「测试中继」时再问一次，按它的原话分清（probe_upgrade）
pub fn upgrade_refused(error: &str) -> bool {
    error.contains("invalid iroh-relay version header")
        // 实测（2026-10-18，iroh 1.3）是 WebSocket 库先报的：…got status code 400；iroh 自己的检查是后一种
        || error.contains("got status code 400")
        || error.contains("Unexpected status during upgrade: 400")
}

/// 中继拒了升级时再问一次、读回它的原话。不带令牌（只为把话说准）；自签名的中继这一下不校验证书
/// （正式连接照样按指纹认）。返回：Ok(Some(它支持的版本)) = 版本对不上；Ok(None) = 不是版本的事；
/// Err = 问不出来
pub fn probe_upgrade(relay: &Relay, offer: &str) -> Result<Option<String>, String> {
    let url = format!("{}relay", relay.url);
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .disable_verification(relay.fingerprint.is_some())
        .build();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .into();
    let mut response = agent
        .get(&url)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "b2RlYS1yZWxheS1wcm9iZQ==")
        .header("Sec-WebSocket-Protocol", offer)
        .call()
        .map_err(|error| error.to_string())?;
    if response.status() != 400 {
        return Ok(None);
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(4096)
        .read_to_string()
        .map_err(|error| error.to_string())?;
    // iroh-relay 的原话：…unsupported relay version: we support iroh-relay-v3 but you only provide …
    Ok(body.find("unsupported relay version").map(|at| {
        let rest = &body[at..];
        rest.split_once("we support ")
            .and_then(|(_, tail)| tail.split_once(" but"))
            .map(|(theirs, _)| theirs.trim().to_string())
            .unwrap_or_default()
    }))
}

/// Odea 这一版的 iroh 会说的中继协议版本（升级请求里的 Sec-WebSocket-Protocol）
pub fn offered_versions() -> String {
    iroh_relay::http::ProtocolVersion::all_joined()
}

/// 网络报告里这台中继的情况：延迟（取最快的一种探测）、UDP 通不通
pub fn latency_of(
    report: &iroh::unstable_net_report::NetReport,
    url: &RelayUrl,
) -> (Option<u32>, bool) {
    let mut best: Option<Duration> = None;
    let mut udp = false;
    for (probe, relay, latency) in report.relay_latency.iter() {
        if relay != url {
            continue;
        }
        if matches!(probe, Probe::QadIpv4 | Probe::QadIpv6) {
            udp = true;
        }
        best = Some(best.map_or(latency, |best| best.min(latency)));
    }
    (
        best.map(|latency| latency.as_millis().min(u32::MAX as u128) as u32),
        udp,
    )
}

/// 连一下：最多等 `wait`。连上以后再等一会儿网络报告（延迟、UDP）
pub async fn check(relay: &Relay, wait: Duration) -> RelayCheck {
    let mut result = RelayCheck {
        connected: false,
        latency_ms: None,
        denied: None,
        error: None,
        udp: None,
        outdated: None,
    };
    let url = match relay.relay_url() {
        Ok(url) => url,
        Err(error) => {
            result.error = Some(error.to_string());
            return result;
        }
    };
    let endpoint = match Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(relay_mode(std::slice::from_ref(relay)))
        .ca_tls_config(tls_config(pins(std::slice::from_ref(relay))))
        .bind()
        .await
    {
        Ok(endpoint) => endpoint,
        Err(error) => {
            result.error = Some(format!("打不开网络端口：{error}"));
            return result;
        }
    };
    let deadline = Instant::now() + wait;
    let mut status = endpoint.home_relay_status();
    loop {
        let current = status.get();
        if let Some(relay) = current.iter().find(|status| status.url() == &url) {
            if relay.is_connected() {
                result.connected = true;
                result.error = None;
                break;
            }
            if let Some(reason) = relay.auth_denied_reason() {
                result.denied = Some(reason.to_string());
                break;
            }
            if let Some(error) = relay.last_error() {
                let error = error_text(error);
                // 版本对不上：再等也连不上，别干等到时限
                let refused = upgrade_refused(&error);
                result.error = Some(error);
                if refused {
                    break;
                }
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || tokio::time::timeout(left, status.updated()).await.is_err() {
            break;
        }
    }
    // 延迟和 UDP 在网络报告里：连上的时候多半已经有了，没有的话再等一小会儿
    let mut reports = endpoint.net_report();
    let report_deadline = Instant::now() + Duration::from_secs(3).min(wait);
    loop {
        if let Some(report) = reports.get() {
            let (latency, udp) = latency_of(&report, &url);
            if latency.is_some() {
                result.latency_ms = latency;
                result.udp = Some(udp);
                break;
            }
        }
        let left = report_deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || tokio::time::timeout(left, reports.updated()).await.is_err() {
            break;
        }
    }
    if !result.connected && result.denied.is_none() && result.error.is_none() {
        result.error = Some(format!("等了 {} 秒还没连上", wait.as_secs()));
    }
    endpoint.close().await;
    if let Some(error) = result.error.clone().filter(|error| upgrade_refused(error)) {
        let probe = relay.clone();
        let answer =
            tokio::task::spawn_blocking(move || probe_upgrade(&probe, &offered_versions())).await;
        match answer {
            Ok(Ok(Some(theirs))) => {
                result.outdated = Some(theirs);
                result.error = None;
            }
            // 认不出的版本头也是版本对不上，只是不知道它支持哪几版
            _ if error.contains("invalid iroh-relay version header") => {
                result.outdated = Some(String::new());
                result.error = None;
            }
            // 不是版本的事（多半是前面的反向代理没转发 WebSocket 升级）：原话留着
            _ => {}
        }
    }
    result
}
