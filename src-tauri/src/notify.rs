//! 系统通知和提示音（docs/提醒与属性.md §1.3、§2.3）。核心只管「弹一条、收一条、放一声、现在该不该出声」，
//! 弹什么、什么时候弹由用它的那一方定（日程的提醒：plugins/journal/reminders.rs）。
//!
//! - Windows：WinRT 的 ToastNotification。应用标识（AUMID）用 tauri.conf.json 的 identifier：安装包给开始菜单的
//!   快捷方式登记了它（Tauri 的 NSIS 模板 `SetLnkAppUserModelId`）；没有快捷方式的（开发版、直接跑 exe）在
//!   `HKCU\Software\Classes\AppUserModelId\<identifier>` 登记名字和图标（prepare）。
//!   按钮的回调在本进程里（Activated 事件），应用开着才接得到 —— 所以退出时把还挂着的都收掉（clear）
//! - 声音：Windows 的通知不让没打包的应用挂自己的声音文件（只认 ms-appx、ms-resource），所以通知本身不出声，
//!   由这里放（PlaySound，内存里的 WAV）。「勿扰」因此要自己看（quiet）
//! - macOS / Linux：没有按钮。macOS 用 osascript 发、afplay 放；Linux 用 notify-send 发、pw-play / paplay / aplay 放。
//!   都没在真机上走过
#![cfg_attr(not(feature = "desktop-runtime"), allow(dead_code))]

use std::sync::Arc;

/// 一条通知
#[derive(Debug, Clone, Default)]
pub struct Toast {
    /// 认它用（收掉、点了以后交回来的参数里也带着它）
    pub tag: String,
    /// 第一行，粗体
    pub title: String,
    /// 下面的一两行
    pub lines: Vec<String>,
    /// 最下面一行小字（Windows 的 attribution）
    pub attribution: Option<String>,
    /// 点通知本身交回来的参数
    pub launch: String,
    pub buttons: Vec<Button>,
    /// 一直停在屏幕上，点掉才走（Windows 的 reminder 场景：要有一个后台激活的按钮，否则这个场景不算数）
    pub sticky: bool,
    /// 声音交给通知自己（系统的提醒声，勿扰由系统管）。false 是通知不出声
    pub system_sound: bool,
}

#[derive(Debug, Clone)]
pub struct Button {
    pub label: String,
    /// 点了交回来的参数
    pub argument: String,
    /// 点了不把应用提到前面（完成、稍后）
    pub background: bool,
}

/// 点了通知或者按钮：交回来的参数（launch 或者 Button::argument）
pub type Activate = Arc<dyn Fn(String) + Send + Sync>;

// 不带桌面端编（CI 跑单测）时只有提醒设置对话框的 quiet 用得到
#[cfg_attr(not(feature = "desktop-runtime"), allow(unused_imports))]
pub use imp::{clear, play, play_system, prepare, quiet, remove, show};

/// 通知里的字是 XML：转义
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // 控制字符在 XML 里不合法（标题里贴进来的怪字符）
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Windows 的通知内容（Toast XML，ToastGeneric 模板）
fn toast_xml(toast: &Toast) -> String {
    let mut xml = format!(
        "<toast launch=\"{}\"{}><visual><binding template=\"ToastGeneric\"><text hint-maxLines=\"2\">{}</text>",
        escape(&toast.launch),
        if toast.sticky { " scenario=\"reminder\"" } else { "" },
        escape(&toast.title),
    );
    for line in toast.lines.iter().take(2) {
        xml.push_str(&format!("<text>{}</text>", escape(line)));
    }
    if let Some(attribution) = &toast.attribution {
        xml.push_str(&format!("<text placement=\"attribution\">{}</text>", escape(attribution)));
    }
    xml.push_str("</binding></visual>");
    if !toast.buttons.is_empty() {
        xml.push_str("<actions>");
        for button in &toast.buttons {
            xml.push_str(&format!(
                "<action content=\"{}\" arguments=\"{}\" activationType=\"{}\"/>",
                escape(&button.label),
                escape(&button.argument),
                if button.background { "background" } else { "foreground" },
            ));
        }
        xml.push_str("</actions>");
    }
    if toast.system_sound {
        xml.push_str("<audio src=\"ms-winsoundevent:Notification.Reminder\"/>");
    } else {
        xml.push_str("<audio silent=\"true\"/>");
    }
    xml.push_str("</toast>");
    xml
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;

    use windows::core::{IInspectable, Interface, HSTRING, PCWSTR};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastDismissalReason, ToastDismissedEventArgs, ToastNotification,
        ToastNotificationManager,
    };
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    use super::{toast_xml, Activate, Toast};

    /// 我们的通知都在这一组里（收的时候按组、按 tag 认）
    const GROUP: &str = "odea";

    /// 挂着的通知：留着引用，点了才找得到回调（通知中心里的也算）。点了、被划掉了就放掉
    static LIVE: Mutex<Option<HashMap<String, ToastNotification>>> = Mutex::new(None);

    fn live() -> std::sync::MutexGuard<'static, Option<HashMap<String, ToastNotification>>> {
        LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// WinRT 要这个线程进过 COM。已经进过（不管哪种）都没关系
    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    /// 在注册表登记应用标识的名字和图标，通知上才显示「Odea」和图标、才会弹出来
    /// （[微软：没打包的应用发通知](https://learn.microsoft.com/en-us/windows/apps/design/shell/tiles-and-notifications/send-local-toast-other-apps)）。
    /// 装好的版本开始菜单的快捷方式也带着这个标识，但不能只认快捷方式：同名的「Odea.lnk」可能是别的构建的
    /// （开发版、换了 identifier 的测试版），2026-11-12 实测就这样漏了登记。值没变不重写
    pub fn prepare(app_id: &str, name: &str, icon_png: &[u8], data_dir: &Path) {
        let icon = data_dir.join("notification-icon.png");
        if std::fs::read(&icon).map(|old| old != icon_png).unwrap_or(true) {
            if let Err(error) = std::fs::write(&icon, icon_png) {
                eprintln!("写通知图标失败: {error}");
            }
        }
        let icon = icon.to_string_lossy().into_owned();
        let key = format!(r"Software\Classes\AppUserModelId\{app_id}");
        let registered = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(&key)
            .and_then(|(key, _)| {
                let same = |value: &str, wanted: &str| key.get_value::<String, _>(value).is_ok_and(|old| old == wanted);
                if !same("DisplayName", name) {
                    key.set_value("DisplayName", &name.to_string())?;
                }
                if !same("IconUri", &icon) {
                    key.set_value("IconUri", &icon)?;
                }
                Ok(())
            });
        if let Err(error) = registered {
            eprintln!("登记通知用的应用标识失败: {error}");
        }
    }

    pub fn show(app_id: &str, toast: &Toast, on_activate: Activate) -> Result<(), String> {
        com();
        let built = (|| -> windows::core::Result<ToastNotification> {
            let xml = XmlDocument::new()?;
            xml.LoadXml(&HSTRING::from(toast_xml(toast)))?;
            let notification = ToastNotification::CreateToastNotification(&xml)?;
            notification.SetTag(&HSTRING::from(toast.tag.as_str()))?;
            notification.SetGroup(&HSTRING::from(GROUP))?;
            let tag = toast.tag.clone();
            notification.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
                let argument = args
                    .as_ref()
                    .and_then(|args| args.cast::<ToastActivatedEventArgs>().ok())
                    .and_then(|args| args.Arguments().ok())
                    .map(|argument| argument.to_string());
                live().as_mut().map(|live| live.remove(&tag));
                if let Some(argument) = argument {
                    on_activate(argument);
                }
                Ok(())
            }))?;
            let tag = toast.tag.clone();
            notification.Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(
                move |_, args| {
                    // 自己超时进了通知中心的还点得到，留着；被划掉、被应用收掉的放掉
                    let reason = args.as_ref().and_then(|args| args.Reason().ok());
                    if reason != Some(ToastDismissalReason::TimedOut) {
                        live().as_mut().map(|live| live.remove(&tag));
                    }
                    Ok(())
                },
            ))?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&notification)?;
            Ok(notification)
        })();
        let notification = built.map_err(|error| format!("弹通知失败: {error}"))?;
        live().get_or_insert_with(HashMap::new).insert(toast.tag.clone(), notification);
        Ok(())
    }

    /// 收掉一条（任务在别处勾掉了、那个仓库窗口关了）
    pub fn remove(app_id: &str, tag: &str) {
        com();
        live().as_mut().map(|live| live.remove(tag));
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.RemoveGroupedTagWithId(&HSTRING::from(tag), &HSTRING::from(GROUP), &HSTRING::from(app_id));
        }
    }

    /// 应用要退出了：屏幕上、通知中心里的全收掉（按钮点了也没人接）
    pub fn clear(app_id: &str) {
        com();
        live().take();
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.ClearWithId(&HSTRING::from(app_id));
        }
    }

    /// 放一段内存里的 WAV（不等它放完）。wav 要一直在（'static），开头按 2 字节对齐（PlaySound 当 WCHAR 指针收）
    pub fn play(wav: &'static [u8]) {
        unsafe {
            let _ = PlaySoundW(PCWSTR(wav.as_ptr().cast()), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
        }
    }

    /// 放系统的提醒声（设置里试听「系统提示音」）
    pub fn play_system() {
        unsafe {
            let _ = PlaySoundW(&HSTRING::from("Notification.Reminder"), None, SND_ALIAS | SND_ASYNC | SND_NODEFAULT);
        }
    }

    // 用户开的「勿扰」只能读没公开的 WNF 状态（Windows 10 1803 起一直是这个名字）：0 是没开，1 是仅优先通知，2 是仅闹钟
    windows_link::link!("ntdll.dll" "system" fn NtQueryWnfStateData(
        state_name: *const u64,
        type_id: *const core::ffi::c_void,
        explicit_scope: *const core::ffi::c_void,
        change_stamp: *mut u32,
        buffer: *mut core::ffi::c_void,
        buffer_size: *mut u32
    ) -> i32);
    const WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: u64 = 0x0D83_063E_A3BF_1C75;

    fn do_not_disturb() -> bool {
        let mut stamp = 0u32;
        let mut profile = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            NtQueryWnfStateData(
                &WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED,
                std::ptr::null(),
                std::ptr::null(),
                &mut stamp,
                (&mut profile as *mut u32).cast(),
                &mut size,
            )
        };
        status >= 0 && size as usize >= std::mem::size_of::<u32>() && profile != 0
    }

    /// 现在该不该出声：开着勿扰、有程序全屏（游戏、看视频）、在演示、锁屏了都不出声。读不到就当可以
    pub fn quiet() -> bool {
        use windows::Win32::UI::Shell::{
            SHQueryUserNotificationState, QUNS_ACCEPTS_NOTIFICATIONS, QUNS_QUIET_TIME,
        };
        // QUNS_QUIET_TIME 不是勿扰：是新用户第一次登录后的那一小时
        let busy = unsafe { SHQueryUserNotificationState() }
            .is_ok_and(|state| state != QUNS_ACCEPTS_NOTIFICATIONS && state != QUNS_QUIET_TIME);
        busy || do_not_disturb()
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;
    use std::process::{Command, Stdio};

    use super::{Activate, Toast};

    pub fn prepare(_app_id: &str, _name: &str, _icon_png: &[u8], _data_dir: &Path) {}

    fn spawn(program: &str, args: &[&str]) -> bool {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
    }

    /// 没有按钮：只是告诉一声。点了也不会回来
    pub fn show(_app_id: &str, toast: &Toast, _on_activate: Activate) -> Result<(), String> {
        let body = toast.lines.join("\n");
        #[cfg(target_os = "macos")]
        let shown = {
            let quote = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!(
                "display notification \"{}\" with title \"Odea\" subtitle \"{}\"",
                quote(&body),
                quote(&toast.title)
            );
            spawn("osascript", &["-e", &script])
        };
        #[cfg(not(target_os = "macos"))]
        let shown = spawn("notify-send", &["-a", "Odea", &toast.title, &body]);
        if shown {
            Ok(())
        } else {
            Err("这台电脑上发不了系统通知".into())
        }
    }

    pub fn remove(_app_id: &str, _tag: &str) {}

    pub fn clear(_app_id: &str) {}

    /// 写到临时文件夹（同一段只写一次），交给系统自带的播放程序
    pub fn play(wav: &'static [u8]) {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        wav.hash(&mut hasher);
        let file = std::env::temp_dir().join(format!("odea-sound-{:x}.wav", hasher.finish()));
        if !file.exists() && std::fs::write(&file, wav).is_err() {
            return;
        }
        let path = file.to_string_lossy().into_owned();
        #[cfg(target_os = "macos")]
        let _ = spawn("afplay", &[&path]);
        #[cfg(not(target_os = "macos"))]
        let _ = ["pw-play", "paplay", "aplay"].iter().any(|player| spawn(player, &[&path]));
    }

    pub fn play_system() {}

    /// 读不到系统的勿扰：一律当可以出声
    pub fn quiet() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_xml_escapes_text_and_keeps_buttons() {
        let toast = Toast {
            tag: "r1".into(),
            title: "交 <周报> & \"总结\"".into(),
            lines: vec!["18:00 · 这周要做的".into()],
            attribution: Some("个人笔记".into()),
            launch: "open:r1".into(),
            buttons: vec![
                Button { label: "完成".into(), argument: "done:r1".into(), background: true },
                Button { label: "打开".into(), argument: "open:r1".into(), background: false },
            ],
            sticky: true,
            system_sound: false,
        };
        let xml = toast_xml(&toast);
        assert!(xml.contains("scenario=\"reminder\""));
        assert!(xml.contains("交 &lt;周报&gt; &amp; &quot;总结&quot;"));
        assert!(xml.contains("<action content=\"完成\" arguments=\"done:r1\" activationType=\"background\"/>"));
        assert!(xml.contains("activationType=\"foreground\""));
        assert!(xml.contains("<text placement=\"attribution\">个人笔记</text>"));
        assert!(xml.contains("<audio silent=\"true\"/>"));
        let system = toast_xml(&Toast { system_sound: true, ..toast });
        assert!(system.contains("ms-winsoundevent:Notification.Reminder"));
    }
}
