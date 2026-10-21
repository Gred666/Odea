/* ============================================================
主持人这边的 Windows 防火墙（docs/协同编辑.md §10 第 1 条）。

应用第一次在网络上接受连接时 Windows 弹窗问「允许 Odea 在这些网络上通信吗」，两个勾：专用、公用。
只勾了「专用」、而当前网络被标成了「公用」（或者干脆点了取消）：Windows 给另一种网络建一条
「阻止」规则，局域网里的人连不进来，Odea 自己一点都看不出来。所以在分享前自检里查一下：

- 当前生效的是哪种网络（INetFwPolicy2::CurrentProfileTypes：域、专用、公用的位掩码）
- 这种网络上防火墙开没开
- 有没有给这个 exe 的入站规则：有「阻止」就是挡着（阻止优先），只有「允许」就是放行了，
  都没有就是还没问过（等会儿 Windows 会弹窗）

判断本身是纯函数（evaluate），规则从 COM 里读（只在 Windows 上编）。查一次要枚举全部防火墙规则，
几十到几百毫秒，放在阻塞线程里；弹窗可能晚几秒才被回答，所以开始后的头一分钟每 5 秒查一次。
============================================================ */

use serde::{Deserialize, Serialize};

/// 域、专用、公用（和 NET_FW_PROFILE2_* 一样的位）
pub const DOMAIN: i32 = 1;
pub const PRIVATE: i32 = 2;
pub const PUBLIC: i32 = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Firewall {
    /// 不是 Windows，或者查不了
    Unknown,
    /// 防火墙关着，或者这种网络上放行了 Odea。public：当前网络是「公用」
    Allowed { public: bool },
    /// 这种网络上 Odea 被挡着（只勾了另一种，或者点了取消）：局域网里的人连不进来
    Blocked { public: bool },
    /// 还没问过：Windows 会弹窗问
    NotAsked { public: bool },
}

/// 一条入站规则里要看的
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub allow: bool,
    /// 适用于哪些网络（位掩码）
    pub profiles: i32,
    /// 管不管 UDP（iroh 走 UDP；协议是「任何」也算）
    pub udp: bool,
}

/// current：当前生效的网络（位掩码）；enabled：每种网络上防火墙开没开；rules：这个 exe 的、
/// 启用着的入站规则
pub fn evaluate(current: i32, enabled: impl Fn(i32) -> bool, rules: &[Rule]) -> Firewall {
    let public = current & PUBLIC != 0;
    let active: Vec<i32> = [DOMAIN, PRIVATE, PUBLIC]
        .into_iter()
        .filter(|profile| current & profile != 0)
        .collect();
    if active.is_empty() {
        return Firewall::Unknown;
    }
    let mut asked = true;
    for profile in active {
        if !enabled(profile) {
            continue;
        }
        let applies = |rule: &&Rule| rule.udp && rule.profiles & profile != 0;
        if rules.iter().filter(applies).any(|rule| !rule.allow) {
            return Firewall::Blocked { public };
        }
        if !rules.iter().filter(applies).any(|rule| rule.allow) {
            asked = false;
        }
    }
    if asked {
        Firewall::Allowed { public }
    } else {
        Firewall::NotAsked { public }
    }
}

/// 查一次（阻塞，几十到几百毫秒）
pub fn check() -> Firewall {
    #[cfg(windows)]
    {
        windows_impl::check().unwrap_or(Firewall::Unknown)
    }
    #[cfg(not(windows))]
    {
        Firewall::Unknown
    }
}

/// 开始协作以后盯着：头一分钟每 5 秒查一次（等用户回答弹窗），之后每分钟一次
pub fn watch() -> (
    tokio::sync::watch::Receiver<Firewall>,
    tokio::task::JoinHandle<()>,
) {
    let (sender, receiver) = tokio::sync::watch::channel(Firewall::Unknown);
    let task = tokio::spawn(async move {
        if !cfg!(windows) {
            return;
        }
        let started = std::time::Instant::now();
        loop {
            let Ok(next) = tokio::task::spawn_blocking(check).await else {
                return;
            };
            sender.send_if_modified(|value| {
                let changed = *value != next;
                *value = next;
                changed
            });
            let wait = if started.elapsed() < std::time::Duration::from_secs(60) {
                5
            } else {
                60
            };
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
        }
    });
    (receiver, task)
}

#[cfg(windows)]
mod windows_impl {
    use windows::core::Interface;
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        INetFwPolicy2, INetFwRule, NetFwPolicy2, NET_FW_ACTION_ALLOW, NET_FW_PROFILE_TYPE2,
        NET_FW_RULE_DIR_IN,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Ole::IEnumVARIANT;
    use windows::Win32::System::Variant::{VARIANT, VT_DISPATCH};

    use super::{evaluate, Firewall, Rule};

    /// 这个线程上的 COM：用完退掉（阻塞线程池里的线程会被别的任务复用）
    struct Com;

    impl Com {
        fn init() -> Option<Com> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()? };
            Some(Com)
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn normalize(path: &str) -> String {
        path.replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }

    pub fn check() -> Option<Firewall> {
        let _com = Com::init()?;
        let exe = normalize(&std::env::current_exe().ok()?.to_string_lossy());
        unsafe {
            let policy: INetFwPolicy2 =
                CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER).ok()?;
            let current = policy.CurrentProfileTypes().ok()?;
            let mut rules = Vec::new();
            let all = policy.Rules().ok()?;
            let items: IEnumVARIANT = all._NewEnum().ok()?.cast().ok()?;
            loop {
                let mut slot = [VARIANT::default()];
                let mut fetched = 0u32;
                if items.Next(&mut slot, &mut fetched).is_err() || fetched == 0 {
                    break;
                }
                let variant = &slot[0];
                if variant.Anonymous.Anonymous.vt != VT_DISPATCH {
                    continue;
                }
                let dispatch: &Option<IDispatch> = &variant.Anonymous.Anonymous.Anonymous.pdispVal;
                let Some(rule) = dispatch.as_ref().and_then(|d| d.cast::<INetFwRule>().ok()) else {
                    continue;
                };
                if rule.Direction().ok() != Some(NET_FW_RULE_DIR_IN)
                    || !rule
                        .Enabled()
                        .map(|enabled| enabled.as_bool())
                        .unwrap_or(false)
                {
                    continue;
                }
                let Ok(application) = rule.ApplicationName() else {
                    continue;
                };
                if normalize(&application.to_string()) != exe {
                    continue;
                }
                let protocol = rule.Protocol().unwrap_or(256);
                rules.push(Rule {
                    allow: rule.Action().ok() == Some(NET_FW_ACTION_ALLOW),
                    profiles: rule.Profiles().unwrap_or(0),
                    // 17 = UDP，256 = 任何协议
                    udp: protocol == 17 || protocol == 256,
                });
            }
            let enabled = |profile: i32| {
                policy
                    .get_FirewallEnabled(NET_FW_PROFILE_TYPE2(profile))
                    .map(|on| on.as_bool())
                    .unwrap_or(true)
            };
            Some(evaluate(current, enabled, &rules))
        }
    }
}
