/* ============================================================
窗口和仓库（docs/仓库与启动器.md §3、§4）。

- 一个窗口一个仓库，同一个仓库只开一个窗口：AppState.workspaces（窗口标签 → Workspace）
- 启动器单独一个窗口（标签 launcher）：用过的仓库、新建、打开文件夹、加入协同编辑
- 冷启动打开上次开着的仓库（boot::startup）；已经在运行时再双击图标弹启动器（lib.rs 的单实例回调）
- 仓库窗口关了：还有别的仓库窗口开着就记成「没开着」，它是最后一个就照旧开着，下次启动回到它
============================================================ */

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_specta::Event;

use crate::boot::{self, SavedVault};
use crate::commands::{self, CollabLink, Indexing};
use crate::error::{AppError, Result};
use crate::domain::model::JournalVault;
use crate::state::{AppState, Caller, Workspace};
use crate::sync::engine::SyncHub;
use crate::sync::repo::{Net, SyncRepo};
use crate::sync::{account, proxy, setup};
use crate::vault::{layout, team, Vault};

/// 启动器窗口的标签
pub const LAUNCHER: &str = "launcher";
/// 协作访客窗口的标签（docs/仓库与启动器.md §13）：不开仓库，只有别人共享的那几篇。访客窗口只有一个，
/// 同时在好几个人那里做客时左边按会话分开（docs/协同编辑.md §25）
pub const GUEST: &str = "guest";

/// 窗口刚建好、前端还没起来时的底色（和 index.html 里浅色主题的底一致，窗口 ready 之前是藏着的）
const BACKGROUND: tauri::window::Color = tauri::window::Color(0xF1, 0xF1, 0xED, 0xFF);

/// 打开一个仓库的方式
#[derive(Debug, Clone, Copy)]
pub struct Open {
    /// 空文件夹里放使用指南（新建、旧库搬家、ODEA_VAULT）；打开别人的文件夹不放
    pub seed: bool,
    /// 记进仓库列表（ODEA_VAULT 不记）
    pub remember: bool,
    /// 不播开场：开场只在冷启动的第一个窗口里播
    pub quiet: bool,
    /// 空文件夹建成逻辑目录（启动器「新建」，docs/仓库与启动器.md §7）
    pub logical: bool,
}

/// 打开一个仓库，返回它的窗口标签。已经在某个窗口里开着就把那个窗口提到前面，不开第二份。
/// 文件读写都在这里（准备、扫描），从命令里调要放进阻塞线程
pub fn open_vault<R: Runtime>(app: &AppHandle<R>, root: &Path, how: Open) -> Result<(String, bool)> {
    let state = app.state::<AppState>();
    if let Some(label) = state.window_of(root) {
        focus(app, &label);
        return Ok((label, true));
    }
    let data_dir = state.data_dir.clone();

    // 第一次打开：旧库有东西就搬过来、空文件夹放指南（seed 时），最后写仓库标记。搬家失败不打开 ——
    // 带着一个空仓库启动，用户会以为笔记全没了（技术方案 §5.7）
    let saved = boot::edit_config(&data_dir, |config| {
        match boot::prepare(root, &data_dir, config, how.seed, how.logical)? {
            boot::Prepared::Imported(report) => eprintln!("旧数据已搬进 {}: {report:?}", root.display()),
            boot::Prepared::Existing | boot::Prepared::Seeded | boot::Prepared::Empty => {}
        }
        Ok(if how.remember {
            config.remember_vault(root, crate::db::now_ms())
        } else {
            config.saved_vault(root).cloned().unwrap_or(SavedVault { path: root.to_path_buf(), ..SavedVault::default() })
        })
    })?;
    let label = free_label(app, &state, boot::window_label(&saved));

    // 文件很多（第一次打开一个大文件夹、索引的结构升级了）的话剩下的在后台读，窗口不等它
    let (mut vault, backlog) = Vault::open_quick(root, &boot::index_path(&data_dir, root))?;
    // 应用升级了：用户没改过的使用指南换成这一版带的（vault/guide.rs）。前端还没起来，不用通知
    if let Err(error) = vault.guide_refresh() {
        eprintln!("更新使用指南失败: {error}");
    }
    vault.set_announcer(commands::announcer(app.clone(), label.clone()));
    let workspace = Arc::new(Workspace {
        label: label.clone(),
        root: Mutex::new(root.to_path_buf()),
        vault: Arc::new(Mutex::new(vault)),
        watcher: Mutex::new(None),
        sync: Arc::new(SyncHub::default()),
        indexing: Arc::new(Mutex::new(Indexing::default())),
    });
    // 先登记再建窗口：前端一起来就要拿着窗口标签找仓库
    lock(&state.workspaces)?.insert(label.clone(), workspace.clone());
    commands::start_services(app, &data_dir, &workspace, backlog);
    if let Err(error) = build_vault_window(app, &label, how.quiet, saved.placement) {
        lock(&state.workspaces)?.remove(&label);
        let _ = commands::stop_services(&workspace);
        return Err(error.into());
    }
    Ok((label, false))
}

/// 仓库窗口的标签：按仓库定（窗口位置插件按标签记位置，每个仓库记着自己的窗口）。
/// 这个标签已经被占了（某个窗口换过仓库）就加序号
fn free_label<R: Runtime>(app: &AppHandle<R>, state: &AppState, wanted: String) -> String {
    let taken = |label: &str| app.get_webview_window(label).is_some() || state.workspace(label).is_some();
    if !taken(&wanted) {
        return wanted;
    }
    (2..).map(|n| format!("{wanted}-{n}")).find(|label| !taken(label)).expect("总有一个没被占的")
}

/// 仓库窗口：和以前 tauri.conf.json 里那个一样（无边框、先藏着，前端首帧画完调 ready 才显示）。
/// 建好以后按上次的样子摆好（place_hidden）
fn build_vault_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    quiet: bool,
    placement: Option<boot::WindowPlacement>,
) -> tauri::Result<()> {
    let url = if quiet { "index.html?quiet" } else { "index.html" };
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Odea")
        .inner_size(1440.0, 900.0)
        .min_inner_size(940.0, 620.0)
        .resizable(true)
        .center()
        .decorations(false)
        .visible(false)
        .background_color(BACKGROUND);
    // 把标签拖成独立窗口（docs/标签页与分屏.md §16）：页面 window.open 的空白页由 popout 接住
    #[cfg(feature = "desktop-runtime")]
    let builder = builder.on_new_window({
        let app = app.clone();
        let owner = label.to_string();
        move |url, features| crate::popout::create(&app, &owner, &url, features, BACKGROUND)
    });
    let window = builder.build()?;
    place_hidden(&window, placement);
    Ok(())
}

/* ---------------- 仓库窗口的样子（docs/仓库与启动器.md §19） ----------------
   上次关的时候什么样就什么样；没记过的最大化开（像 Obsidian）。

   以前交给 tauri-plugin-window-state，两个毛病：它只在应用正常退出那一刻写盘，自动更新是 restart，
   走不到那一步 —— 记录一直停在 10 月 20 日，最大化过也记不住；它还原「最大化」「可见」是在窗口刚建好的
   时候，而最大化（SW_MAXIMIZE）会把藏着的窗口直接显示出来，前端还没画第一帧，先闪一个空窗口。

   现在自己记：关之前（lib.rs 的 CloseRequested）记下是不是最大化、不最大化时的位置大小（Windows 用
   GetWindowPlacement，最大化着也拿得到原来那个）；建窗口时（还藏着）摆好 —— 要最大化的先撑满它那块
   屏幕的工作区，前端第一帧就按最终的尺寸排，显示时不再重排一次；ready 时一步显示（show_placed）。 */

/// 建好、藏着、等 ready 的仓库窗口：显示时按这个摆
static PLACING: std::sync::LazyLock<Mutex<HashMap<String, boot::WindowPlacement>>> =
    std::sync::LazyLock::new(Mutex::default);

fn place_hidden<R: Runtime>(window: &tauri::WebviewWindow<R>, saved: Option<boot::WindowPlacement>) {
    // 没记过：最大化；不最大化时就是刚建好的样子（屏幕正中 1440×900）
    let fresh = || {
        current_placement(&window.as_ref().window()).map(|now| boot::WindowPlacement { maximized: true, ..now })
    };
    let Some(placement) = saved.or_else(fresh) else { return };
    if saved.is_some() {
        set_normal(window, placement);
    }
    // 先撑满工作区，前端按最大化的尺寸排第一帧。只在 Windows 上：显示时 SetWindowPlacement 把不最大化时的
    // 位置记回去；别的系统上撑满以后「还原」就还原成这么大了
    #[cfg(windows)]
    if placement.maximized {
        let monitor = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
        if let Some(monitor) = monitor {
            let area = monitor.work_area();
            let _ = window.set_position(tauri::Position::Physical(area.position));
            let _ = window.set_size(tauri::Size::Physical(area.size));
        }
    }
    if let Ok(mut placing) = PLACING.lock() {
        placing.insert(window.label().to_string(), placement);
    }
}

/// lib.rs 的 ready 在 show() 之前调：仓库窗口要最大化的，这时候最大化（一步显示出来）。
/// `jumped`：日程切换器已经给这个窗口摆好了（place_pending），只把记着的这份丢掉
pub fn show_placed<R: Runtime>(window: &tauri::WebviewWindow<R>, jumped: bool) {
    let placement = PLACING.lock().ok().and_then(|mut placing| placing.remove(window.label()));
    let Some(placement) = placement.filter(|placement| placement.maximized && !jumped) else { return };
    // Windows：最大化显示，同时把不最大化时的位置记回去（藏着时撑满了工作区）
    #[cfg(windows)]
    set_placement(window, placement, windows::Win32::UI::WindowsAndMessaging::SW_SHOWMAXIMIZED);
    // tao 自己记着窗口是不是最大化（标题栏的「还原」图标按它），也走一遍
    let _ = window.maximize();
}

/// 仓库窗口要关了（lib.rs 的 CloseRequested）：记下这时候的样子，下次打开这个仓库照样摆。
/// 已经藏起来的（关到一半又来一次）不算；最小化着的照样记（Windows 知道它最小化之前是不是最大化）
pub fn remember_placement<R: Runtime>(window: &tauri::Window<R>) {
    let state = window.state::<AppState>();
    let Some(workspace) = state.workspace(window.label()) else { return };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Some(placement) = current_placement(window) else { return };
    let root = workspace.root();
    if let Err(error) = boot::edit_config(&state.data_dir, |config| {
        config.set_vault_placement(&root, placement);
        Ok(())
    }) {
        eprintln!("保存配置失败: {error}");
    }
}

#[cfg(windows)]
fn current_placement<R: Runtime>(window: &tauri::Window<R>) -> Option<boot::WindowPlacement> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED, WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED,
    };
    let hwnd = window.hwnd().ok()?;
    let mut place = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
    unsafe { GetWindowPlacement(hwnd, &mut place) }.ok()?;
    let maximized = place.showCmd == SW_SHOWMAXIMIZED.0 as u32
        || (place.showCmd == SW_SHOWMINIMIZED.0 as u32 && place.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0);
    let rect = place.rcNormalPosition;
    Some(boot::WindowPlacement {
        maximized,
        x: rect.left,
        y: rect.top,
        width: (rect.right - rect.left).max(0) as u32,
        height: (rect.bottom - rect.top).max(0) as u32,
    })
}

/// 别的系统：最大化着拿不到原来的位置，只记是不是最大化，位置大小沿用刚建好时的
#[cfg(not(windows))]
fn current_placement<R: Runtime>(window: &tauri::Window<R>) -> Option<boot::WindowPlacement> {
    let maximized = window.is_maximized().ok()?;
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(boot::WindowPlacement { maximized, x: position.x, y: position.y, width: size.width, height: size.height })
}

/// 藏着的窗口摆到不最大化时的位置大小（还藏着）
fn set_normal<R: Runtime>(window: &tauri::WebviewWindow<R>, placement: boot::WindowPlacement) {
    #[cfg(windows)]
    set_placement(window, placement, windows::Win32::UI::WindowsAndMessaging::SW_HIDE);
    #[cfg(not(windows))]
    {
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(placement.width, placement.height)));
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(placement.x, placement.y)));
    }
}

/// SetWindowPlacement：不最大化时的位置大小 + 这一下怎么显示（SW_HIDE 是还藏着）。
/// 记下的那块屏幕拔掉了的话，系统自己把窗口挪回看得见的地方
#[cfg(windows)]
fn set_placement<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    placement: boot::WindowPlacement,
    show: windows::Win32::UI::WindowsAndMessaging::SHOW_WINDOW_CMD,
) {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPlacement, WINDOWPLACEMENT, WINDOWPLACEMENT_FLAGS};
    let Ok(hwnd) = window.hwnd() else { return };
    let place = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        flags: WINDOWPLACEMENT_FLAGS(0),
        showCmd: show.0 as u32,
        ptMinPosition: POINT { x: -1, y: -1 },
        ptMaxPosition: POINT { x: -1, y: -1 },
        rcNormalPosition: RECT {
            left: placement.x,
            top: placement.y,
            right: placement.x + placement.width as i32,
            bottom: placement.y + placement.height as i32,
        },
    };
    if let Err(error) = unsafe { SetWindowPlacement(hwnd, &place) } {
        eprintln!("摆窗口失败: {error}");
    }
}

/// 弹启动器：已经开着就提到前面
pub fn show_launcher<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    if app.get_webview_window(LAUNCHER).is_some() {
        focus(app, LAUNCHER);
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html?launcher".into()))
        .title("Odea")
        .inner_size(800.0, 560.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .decorations(false)
        .visible(false)
        .background_color(BACKGROUND)
        .build()?;
    Ok(())
}

pub fn focus<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if label == LAUNCHER {
        // 刚关上、还没销毁的启动器又被叫回来：不销毁了，淡到一半的复原
        LAUNCHER_RETIRING.store(0, Ordering::SeqCst);
    }
    if let Some(window) = app.get_webview_window(label) {
        if label == LAUNCHER {
            restore_opacity(&window);
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 冷启动：打开上次开着的仓库；一个都打不开就弹启动器
pub fn startup<R: Runtime>(app: &AppHandle<R>, plan: boot::Startup) {
    let mut opened = 0;
    if let boot::Startup::Open { roots, seed, remember } = plan {
        for root in roots {
            match open_vault(app, &root, Open { seed, remember, quiet: opened > 0, logical: false }) {
                Ok(_) => opened += 1,
                Err(error) => eprintln!("打开笔记文件夹 {} 失败: {error}", root.display()),
            }
        }
    }
    // 点团队仓库的链接冷启动的：在启动器里拉一份（仓库窗口照常打开）
    if let Some(link) = app.state::<AppState>().collab.take_pending_vault_link() {
        show_launcher_link(app, link);
        return;
    }
    if opened == 0 {
        // 一个仓库都没打开、点的是邀请链接：开访客窗口去加入，不用先建仓库
        let shown = if app.state::<AppState>().collab.has_pending_invite() {
            show_guest(app, None)
        } else {
            show_launcher(app)
        };
        if let Err(error) = shown {
            eprintln!("打开窗口失败: {error}");
        }
    }
}

/// 窗口获得焦点（lib.rs 的窗口事件）：记下最近用的仓库窗口
pub fn on_focused<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<AppState>();
    if state.workspace(label).is_some() {
        if let Ok(mut focused) = state.focused.lock() {
            *focused = Some(label.to_string());
        }
    }
}

/// 窗口没了：仓库的监听、同步停掉。还有别的仓库窗口开着就记成「没开着」；它是最后一个就照旧开着，
/// 下次启动回到它（docs/仓库与启动器.md §3.1）
pub fn on_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<AppState>();
    let (workspace, others) = match state.workspaces.lock() {
        Ok(mut map) => (map.remove(label), !map.is_empty()),
        Err(_) => return,
    };
    if let Ok(mut focused) = state.focused.lock() {
        if focused.as_deref() == Some(label) {
            *focused = None;
        }
    }
    let Some(workspace) = workspace else { return };
    let _ = commands::stop_services(&workspace);
    if others {
        let root = workspace.root();
        if let Err(error) = boot::edit_config(&state.data_dir, |config| {
            config.set_vault_open(&root, false);
            Ok(())
        }) {
            eprintln!("保存配置失败: {error}");
        }
    }
    // 启动器在等这个窗口出来才关（launcher_open）：它没出来就没了，启动器留着
    if let Ok(mut waiting) = state.launcher_waits_for.lock() {
        if waiting.as_deref() == Some(label) {
            *waiting = None;
        }
    };
}

/// 仓库窗口的前端起来了（lib.rs 的 ready）：启动器在等它的话，这时候才关 —— 不然启动器先没了、
/// 新窗口过半秒才出来，中间什么都没有
pub fn on_ready<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<AppState>();
    let waited = state
        .launcher_waits_for
        .lock()
        .map(|mut waiting| waiting.take_if(|waiting| waiting == label).is_some())
        .unwrap_or(false);
    if waited {
        close_launcher_behind(app);
    }
    deliver_jump(app, label);
}

/// 正在退场的那一次启动器（0 = 没在退场）：等着藏、藏起来了等着销毁。又被叫回来（focus）就作废
static LAUNCHER_RETIRING: AtomicU64 = AtomicU64::new(0);
static LAUNCHER_TICKET: AtomicU64 = AtomicU64::new(0);

/// 新窗口刚显示：系统正在给它播出现的淡入（Windows 11 上量到约 75ms），启动器等这么久再藏
const LAUNCHER_COVERED: Duration = Duration::from_millis(250);

/// 关启动器：先淡出、藏起来，过一会儿再销毁（关闭按钮、Alt+F4 走这里，见 lib.rs）。淡出是自己做的，
/// 不用系统的关窗动画（fade_out 说了为什么）。
/// 不直接 destroy：WebView 先被拆掉，淡出的是一块只剩底色的窗口；拆 WebView 还要在主线程上卡一下，
/// 这时候新开的仓库窗口可能正在画第一屏
pub fn close_launcher<R: Runtime>(app: &AppHandle<R>) {
    retire_launcher(app, Duration::ZERO);
}

/// 从启动器打开的窗口显示出来了（新开的画好了第一帧、已经开着的提到了前面）：它在上面淡入的时候
/// 启动器不动、垫在底下，等它整个盖上了再藏。
///
/// 以前是同时：新窗口淡入、启动器在它底下淡出，两个各淡各的（CLAUDE.md 规矩 8 的窗口版）——
/// 中间一段两个都只剩一半，后面的桌面透出来，启动器那一块先亮、再暗、再亮；新窗口淡入的头几帧
/// 也一顿一顿的（2026-10-29 逐帧抓屏：每帧亮度涨 10、14、6、0、18，后面才匀成 8、9）
fn close_launcher_behind<R: Runtime>(app: &AppHandle<R>) {
    retire_launcher(app, LAUNCHER_COVERED);
}

/// 等 `wait`（0 就是马上）、淡出、藏起来，再过 400ms 销毁。中途又被叫回来（focus 把号码清掉）就停下。
/// 淡出要一帧一帧地等合成器（DwmFlush 会阻塞），单开一个线程
fn retire_launcher<R: Runtime>(app: &AppHandle<R>, wait: Duration) {
    let Some(window) = app.get_webview_window(LAUNCHER) else { return };
    let ticket = LAUNCHER_TICKET.fetch_add(1, Ordering::SeqCst) + 1;
    LAUNCHER_RETIRING.store(ticket, Ordering::SeqCst);
    let retiring = move || LAUNCHER_RETIRING.load(Ordering::SeqCst) == ticket;
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        if !retiring() || !fade_out(&window, &retiring) {
            return;
        }
        let _ = window.hide();
        std::thread::sleep(Duration::from_millis(400));
        if LAUNCHER_RETIRING.compare_exchange(ticket, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            let _ = window.destroy();
        }
    });
}

/// 启动器退场的淡出有多长（和系统的关窗动画差不多）
const LAUNCHER_FADE: Duration = Duration::from_millis(150);

/// 启动器退场：整窗只淡透明度，不缩放；淡完由调用方藏起来。返回 false = 中途被叫回来了（已经复原）。
///
/// 以前交给系统的关窗动画，那是「缩到约 0.95 + 淡出」：缩放把整窗当位图拉，字发虚；缩放到最后一段
/// 猛地加速，一帧收 11px 然后停住、只剩淡 —— 用户说的「关启动器那个小窗口时掉了几帧」
/// （2026-10-29 逐帧抓屏，180Hz 下三次都是：每帧收 2–3px，到 772 一帧跳到 761，之后不动；
/// 普通的 Win32 窗口也是这个套路，只是那一跳分在三帧里）。CLAUDE.md 规矩 1：消失只淡 opacity。
///
/// 做法：关掉这个窗口的系统过渡（DWMWA_TRANSITIONS_FORCEDISABLED），改成分层窗口，按合成器的
/// 节奏（DwmFlush 每次等到下一次合成，60Hz、180Hz 都是一帧一步）把整窗透明度从 255 降到 0。
/// 分层窗口的透明度对 WebView2 画的内容一样有效（实测 50% 时正好是一半）；淡的时候点击穿过去
fn fade_out<R: Runtime>(window: &tauri::WebviewWindow<R>, retiring: &impl Fn() -> bool) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::COLORREF;
        use windows::Win32::Graphics::Dwm::DwmFlush;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongW, SetLayeredWindowAttributes, SetWindowLongW, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
            WS_EX_TRANSPARENT,
        };
        let Ok(hwnd) = window.hwnd() else { return true };
        set_transitions(hwnd, false);
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
            SetWindowLongW(hwnd, GWL_EXSTYLE, style | (WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0) as i32);
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        }
        let start = std::time::Instant::now();
        loop {
            if !retiring() {
                restore_opacity(window);
                return false;
            }
            let t = (start.elapsed().as_secs_f64() / LAUNCHER_FADE.as_secs_f64()).min(1.0);
            // ease-out cubic：一点下去就开始淡，收尾短
            let alpha = 255.0 * (1.0 - t).powi(3);
            unsafe {
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha.round() as u8, LWA_ALPHA);
            }
            if t >= 1.0 {
                return true;
            }
            if unsafe { DwmFlush() }.is_err() {
                std::thread::sleep(Duration::from_millis(4));
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, retiring);
        true
    }
}

/// 淡到一半、或者淡完藏起来了又被叫回来：整窗不透明、不再是分层窗口、系统过渡还回去
fn restore_opacity<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::COLORREF;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongW, SetLayeredWindowAttributes, SetWindowLongW, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
            WS_EX_TRANSPARENT,
        };
        let Ok(hwnd) = window.hwnd() else { return };
        // 藏起来的时候 tao 按它记的样式重设过扩展样式，那时已经不是分层窗口了
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
            if style & WS_EX_LAYERED.0 as i32 != 0 {
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
                SetWindowLongW(hwnd, GWL_EXSTYLE, style & !((WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0) as i32));
            }
        }
        set_transitions(hwnd, true);
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// 这个窗口显示、隐藏时要不要系统的过渡动画
#[cfg(windows)]
fn set_transitions(hwnd: windows::Win32::Foundation::HWND, on: bool) {
    use windows::core::BOOL;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    let disabled = BOOL::from(!on);
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            (&raw const disabled).cast(),
            std::mem::size_of::<BOOL>() as u32,
        );
    }
}

/// 点开了一个 odea:// 链接（协作邀请、回连、中继码）：交给最近用过的仓库窗口。一个都没开着就先打开
/// 最近的仓库，链接存着等它起来取（collab_pending_link）；一个仓库都没有就弹启动器
pub fn deliver_link<R: Runtime>(app: &AppHandle<R>, link: String) {
    // 团队仓库的链接：在启动器里拉一份
    if is_vault_link(&link) {
        show_launcher_link(app, link);
        return;
    }
    let state = app.state::<AppState>();
    let focused = state.focused.lock().ok().and_then(|focused| focused.clone());
    let target = focused
        .filter(|label| state.workspace(label).is_some())
        .or_else(|| state.all_workspaces().first().map(|workspace| workspace.label.clone()));
    if let Some(label) = target {
        focus(app, &label);
        if let Err(error) = CollabLink(link).emit_to(app, label.as_str()) {
            eprintln!("通知前端失败: {error}");
        }
        return;
    }
    // 一个仓库窗口都没开着：邀请链接交给访客窗口（不用开仓库），别的（回连、中继码）先打开最近的仓库
    if is_invite(&link) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = show_guest(&app, Some(link)) {
                eprintln!("打开访客窗口失败: {error}");
            }
        });
        return;
    }
    state.collab.set_pending_link(link);
    open_recent_or_launcher(app);
}

/// 协作的邀请链接（`odea://join/…`）；回连（`odea://back/…`）、中继码不算
pub fn is_invite(link: &str) -> bool {
    link.trim().to_ascii_lowercase().starts_with("odea://join")
}

/// 访客窗口：加入 link 那一次会话。已经开着就提到前面、把链接交给它（加入对话框里填好）
pub fn show_guest<R: Runtime>(app: &AppHandle<R>, link: Option<String>) -> Result<()> {
    if app.get_webview_window(GUEST).is_some() {
        focus(app, GUEST);
        if let Some(link) = link {
            if let Err(error) = CollabLink(link).emit_to(app, GUEST) {
                eprintln!("通知前端失败: {error}");
            }
        }
        return Ok(());
    }
    if let Some(link) = link {
        app.state::<AppState>().collab.set_pending_link(link);
    }
    WebviewWindowBuilder::new(app, GUEST, WebviewUrl::App("index.html?guest".into()))
        .title("Odea · 协作")
        .inner_size(1040.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .center()
        .decorations(false)
        .visible(false)
        .background_color(BACKGROUND)
        .build()?;
    Ok(())
}

/// 访客窗口要把共享的那篇存进仓库（commands::collab_copy_to_vault）：最近用过的仓库窗口；一个都没开着
/// 就打开最近的仓库（新窗口起来以后自己来取）。一个仓库都没有时报错
pub fn recent_vault_window<R: Runtime>(app: &AppHandle<R>) -> Result<String> {
    let state = app.state::<AppState>();
    let focused = state.focused.lock().ok().and_then(|focused| focused.clone());
    if let Some(label) = focused
        .filter(|label| state.workspace(label).is_some())
        .or_else(|| state.all_workspaces().first().map(|workspace| workspace.label.clone()))
    {
        focus(app, &label);
        return Ok(label);
    }
    let recent = boot::Config::load(&state.data_dir)
        .recent_vaults()
        .into_iter()
        .find(|saved| saved.path.is_dir())
        .ok_or_else(|| AppError::Invalid("还没有仓库：先在启动器里新建或者打开一个，再存进去".into()))?;
    let (label, _) = open_vault(app, &recent.path, Open { seed: false, remember: true, quiet: true, logical: false })?;
    Ok(label)
}

/// macOS 点 Dock、一个窗口都没有（`RunEvent::Reopen`）：有仓库窗口就提到前面，
/// 否则打开最近的仓库，一个都没有就弹启动器
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn reopen<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if let Some(workspace) = state.all_workspaces().first() {
        focus(app, &workspace.label);
        return;
    }
    if app.get_webview_window(LAUNCHER).is_some() {
        focus(app, LAUNCHER);
        return;
    }
    open_recent_or_launcher(app);
}

/// 打开最近用过、文件夹还在的那个仓库；一个都没有就弹启动器。
/// 单实例、深链接、Dock 的回调在主线程上：读文件、建窗口挪到别处
fn open_recent_or_launcher<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let recent = boot::Config::load(&state.data_dir)
        .recent_vaults()
        .into_iter()
        .find(|saved| saved.path.is_dir());
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let opened = match recent {
            Some(saved) => open_vault(&app, &saved.path, Open { seed: false, remember: true, quiet: true, logical: false }).map(|_| ()),
            None => show_launcher(&app),
        };
        if let Err(error) = opened {
            eprintln!("打开窗口失败: {error}");
        }
    });
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| AppError::Internal("窗口表的锁坏了".into()))
}

async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("任务panic: {e}")))?
}

/* ---------------- 启动器的命令 ---------------- */

/// 启动器左边的一条
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub path: String,
    /// 文件夹名
    pub name: String,
    /// 上次打开（Unix 毫秒）
    pub last_opened: f64,
    /// 正在某个窗口里开着
    pub open: bool,
    /// 文件夹找不到了（移动硬盘没插、被删了、被改名了）
    pub missing: bool,
    /// 逻辑目录（docs/仓库与启动器.md §7）：列表上前面一个小图标
    pub logical: bool,
}

fn entries(state: &AppState) -> Vec<VaultEntry> {
    boot::Config::load(&state.data_dir)
        .recent_vaults()
        .into_iter()
        .map(|saved| VaultEntry {
            name: saved
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| saved.path.to_string_lossy().into_owned()),
            open: state.window_of(&saved.path).is_some(),
            missing: !saved.path.is_dir(),
            logical: saved.path.is_dir() && layout::Layout::load(&saved.path).logical,
            last_opened: saved.last_opened as f64,
            path: saved.path.to_string_lossy().into_owned(),
        })
        .collect()
}

/// 用过的仓库，最近打开的在前
#[tauri::command]
#[specta::specta]
pub async fn launcher_vaults(state: State<'_, AppState>) -> Result<Vec<VaultEntry>> {
    Ok(entries(&state))
}

/// 打开（或者提到前面）一个仓库。新开的窗口画出来以后启动器自己关掉。
/// logical 只对新建的（seed）有用：建成逻辑目录还是真实文件夹，用户在「新建」里选的；打开的文件夹照它本来的样子
async fn open_from_launcher<R: Runtime>(app: AppHandle<R>, root: PathBuf, seed: bool, logical: bool) -> Result<()> {
    let handle = app.clone();
    let how = Open { seed, remember: true, quiet: true, logical: seed && logical };
    let (label, existing) = blocking(move || open_vault(&handle, &root, how)).await?;
    if existing {
        close_launcher_behind(&app);
    } else if let Ok(mut waiting) = app.state::<AppState>().launcher_waits_for.lock() {
        *waiting = Some(label);
    }
    Ok(())
}

/// 点了左边的一条
#[tauri::command]
#[specta::specta]
pub async fn launcher_open<R: Runtime>(app: AppHandle<R>, path: String) -> Result<()> {
    let root = PathBuf::from(&path);
    // 找不到的不打开：不在原处新建一个空仓库
    if !root.is_dir() {
        return Err(AppError::NotFound(format!("找不到这个文件夹了：{path}")));
    }
    open_from_launcher(app, root, false, false).await
}

/// 「打开文件夹」：系统的选择文件夹对话框，选了就打开（不往别人的文件夹里放指南）。取消了返回 false
#[tauri::command]
#[specta::specta]
pub async fn launcher_open_folder<R: Runtime>(app: AppHandle<R>) -> Result<bool> {
    let picker = app.clone();
    let picked = blocking(move || {
        let mut dialog = picker.dialog().file().set_title("打开文件夹");
        if let Some(window) = picker.get_webview_window(LAUNCHER) {
            dialog = dialog.set_parent(&window);
        }
        Ok(dialog.blocking_pick_folder())
    })
    .await?;
    let Some(picked) = picked else { return Ok(false) };
    let root = picked
        .into_path()
        .map_err(|error| AppError::Invalid(format!("这个位置用不了: {error}")))?;
    open_from_launcher(app, root, false, false).await?;
    Ok(true)
}

/// 新建时默认放在哪（「文档」）
#[tauri::command]
#[specta::specta]
pub async fn launcher_default_parent<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> Result<String> {
    Ok(boot::default_parent(app.path().document_dir().ok(), &state.data_dir)
        .to_string_lossy()
        .into_owned())
}

/// 新建时换个位置：选一个文件夹，新仓库建在它下面。取消了返回 null
#[tauri::command]
#[specta::specta]
pub async fn launcher_pick_parent<R: Runtime>(app: AppHandle<R>, from: String) -> Result<Option<String>> {
    let picker = app.clone();
    let picked = blocking(move || {
        let mut dialog = picker.dialog().file().set_title("新仓库放在哪个文件夹下").set_directory(from);
        if let Some(window) = picker.get_webview_window(LAUNCHER) {
            dialog = dialog.set_parent(&window);
        }
        Ok(dialog.blocking_pick_folder())
    })
    .await?;
    Ok(picked
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned()))
}

/// 新建：在 parent 下面建一个叫 name 的文件夹，放使用指南，打开。同名的文件夹已经有了、里面有东西就不建。
/// logical：建成逻辑目录（树记在清单里，笔记平放）；否则是真实文件夹（树就是硬盘上的文件夹）。
/// 两样的区别在启动器「新建」里说清楚、让用户选（docs/仓库与启动器.md §15）
#[tauri::command]
#[specta::specta]
pub async fn launcher_create<R: Runtime>(app: AppHandle<R>, parent: String, name: String, logical: bool) -> Result<()> {
    let root = new_vault_root(&parent, &name)?;
    std::fs::create_dir_all(&root)?;
    open_from_launcher(app, root, true, logical).await
}

/// 「从同步仓库拉一份」（换电脑时最常用，技术方案 §5.9.7）：用登录过的账号把云端的仓库 clone 到
/// parent 下面一个叫 name 的新文件夹，打开它（同步跟着开着）。云端还是空的不拉 ——
/// 那就用「新建」建一个，再在里面开启同步把它推上去
#[tauri::command]
#[specta::specta]
pub async fn launcher_clone<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    provider: String,
    clone_url: String,
    parent: String,
    name: String,
) -> Result<()> {
    let provider = commands::provider_of(&provider)?;
    let root = new_vault_root(&parent, &name)?;
    if let Some(drive) = setup::cloud_drive_of(&root) {
        return Err(AppError::Invalid(format!(
            "这个位置在{drive}的同步目录里。网盘和同步二选一：网盘会来回拷 .git，迟早把它弄坏。换一个位置"
        )));
    }
    let data_dir = state.data_dir.clone();
    let target = root.clone();
    blocking(move || {
        let login = commands::login_of(&data_dir, provider)?;
        let token = account::access_token(provider, &login, || commands::sync_http(&data_dir), false)?;
        let net = Net {
            credentials: Some((login.clone(), token)),
            proxy: proxy::resolve(boot::Config::load(&data_dir).sync_proxy.as_deref()),
        };
        if SyncRepo::remote_is_empty(&clone_url, &net)? {
            return Err(AppError::Invalid(
                "云端这个仓库还是空的。用「新建」建一个仓库，再在里面开启同步，把笔记推上去".into(),
            ));
        }
        let repo = SyncRepo::clone(&clone_url, &target, &net)?;
        setup::mark(&repo, provider, &login)?;
        Ok(())
    })
    .await?;
    open_from_launcher(app, root, false, false).await
}

/// 新建 / 拉一份时的新文件夹：parent 下面叫 name 的。同名的已经有了、里面有东西就不行
fn new_vault_root(parent: &str, name: &str) -> Result<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("给仓库起个名字".into()));
    }
    let parent = PathBuf::from(parent.trim());
    if !parent.is_dir() {
        return Err(AppError::NotFound(format!("找不到「{}」这个位置", parent.display())));
    }
    // 文件夹名和笔记文件名同一套规矩：非法字符换成相近的全角字符、去掉结尾的点和空格
    let folder = layout::folder_name(name).ok_or_else(|| AppError::Invalid("这个名字用不了，换一个".into()))?;
    let root = parent.join(folder);
    let occupied = std::fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_some());
    if occupied {
        return Err(AppError::Invalid(format!(
            "「{}」已经有了，里面还有东西。换个名字，或者用「打开文件夹」打开它",
            root.display()
        )));
    }
    Ok(root)
}

/// 从列表里拿掉（不碰文件）
#[tauri::command]
#[specta::specta]
pub async fn launcher_forget(state: State<'_, AppState>, path: String) -> Result<Vec<VaultEntry>> {
    let root = PathBuf::from(path);
    if state.window_of(&root).is_some() {
        return Err(AppError::Invalid("这个仓库正开着，先关掉它的窗口".into()));
    }
    boot::edit_config(&state.data_dir, |config| {
        config.forget_vault(&root);
        Ok(())
    })?;
    Ok(entries(&state))
}

/// 在资源管理器里打开这个仓库的文件夹
#[tauri::command]
#[specta::specta]
pub async fn launcher_reveal(path: String) -> Result<()> {
    blocking(move || {
        tauri_plugin_opener::open_path(&path, None::<&str>)
            .map_err(|error| AppError::Io(format!("打开文件夹失败: {error}")))
    })
    .await
}

/// 「加入协同编辑」：开一个不带仓库的访客窗口去加入（访客那篇本来就不落进仓库，docs/协同编辑.md §3）。
/// 访客窗口画出来以后启动器自己关
#[tauri::command]
#[specta::specta]
pub async fn launcher_join<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, link: String) -> Result<()> {
    let link = link.trim().to_string();
    if !is_invite(&link) {
        return Err(AppError::Invalid("这不是 Odea 的邀请链接（应该以 odea://join/ 开头）".into()));
    }
    let existing = app.get_webview_window(GUEST).is_some();
    let handle = app.clone();
    blocking(move || show_guest(&handle, Some(link))).await?;
    if existing {
        close_launcher_behind(&app);
    } else if let Ok(mut waiting) = state.launcher_waits_for.lock() {
        *waiting = Some(GUEST.to_string());
    }
    Ok(())
}

/// 仓库窗口里「打开别的仓库…」：弹启动器
#[tauri::command]
#[specta::specta]
pub async fn launcher_show<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    show_launcher(&app)
}

/* ---------------- 日程切换器（docs/协同编辑.md §22.6） ----------------
团队仓库的日程是团队的，个人的日程在个人仓库：今日TODO、目标、日历那一行日期后面能在这台电脑上
开着日程的几个仓库之间跳。一个窗口一个仓库，跳 = 那个仓库的窗口提到前面、停在同一页同一天；
它摆在当前窗口的位置和大小上，看着就像同一个窗口里换了内容 */

/// 跳过去之后那个窗口停在哪一页（前端收到 JournalGoto 再翻过去）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalGoto {
    /// `today` / `goal` / `calendar`
    pub page: String,
    /// 日历选中的那一天（YYYY-MM-DD）
    pub date: String,
}

/// 窗口的位置和大小
#[derive(Debug, Clone, Copy)]
pub struct Place {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    maximized: bool,
}

/// 刚打开、前端还没起来的窗口：起来以后（ready）摆到这里、翻到这一页
pub struct Jump {
    place: Option<Place>,
    goto: JournalGoto,
}

fn place_of<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<Place> {
    Some(Place {
        position: window.outer_position().ok()?,
        size: window.inner_size().ok()?,
        maximized: window.is_maximized().unwrap_or(false),
    })
}

fn apply_place<R: Runtime>(window: &tauri::WebviewWindow<R>, place: Place) {
    if place.maximized {
        let _ = window.maximize();
        return;
    }
    let _ = window.unmaximize();
    let _ = window.set_size(tauri::Size::Physical(place.size));
    let _ = window.set_position(tauri::Position::Physical(place.position));
}

/// lib.rs 的 ready 在显示窗口之前调：日程切换器打开的窗口先摆好位置。摆了返回 true
pub fn place_pending<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let state = window.state::<AppState>();
    let place = state
        .journal_jumps
        .lock()
        .ok()
        .and_then(|jumps| jumps.get(window.label()).and_then(|jump| jump.place));
    if let Some(place) = place {
        apply_place(window, place);
    }
    place.is_some()
}

/// 窗口起来了：日程切换器在等它的话，翻到那一页
fn deliver_jump<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<AppState>();
    let jump = state.journal_jumps.lock().ok().and_then(|mut jumps| jumps.remove(label));
    if let Some(jump) = jump {
        if let Err(error) = jump.goto.emit_to(app, label) {
            eprintln!("通知前端失败: {error}");
        }
    }
}

/// 这台电脑上开着日程的仓库：个人的在前，再按名字
#[tauri::command]
#[specta::specta]
pub async fn journal_vaults(caller: Caller, state: State<'_, AppState>) -> Result<Vec<JournalVault>> {
    let current = caller.workspace.map(|workspace| workspace.root());
    // 开着窗口的仓库也算（ODEA_VAULT 打开的、刚打开还没记进列表的）
    let open: Vec<PathBuf> = state.all_workspaces().iter().map(|workspace| workspace.root()).collect();
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let mut paths: Vec<PathBuf> = boot::Config::load(&data_dir)
            .recent_vaults()
            .into_iter()
            .map(|saved| saved.path)
            .collect();
        for root in open.into_iter().chain(current.clone()) {
            if !paths.iter().any(|path| boot::same_vault(path, &root)) {
                paths.push(root);
            }
        }
        let mut vaults: Vec<JournalVault> = paths
            .into_iter()
            .filter(|path| path.is_dir() && layout::Layout::load(path).journal)
            .map(|path| JournalVault {
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned()),
                team: team::team_id(&path).is_some(),
                current: current.as_deref().is_some_and(|current| boot::same_vault(current, &path)),
                path: path.to_string_lossy().into_owned(),
            })
            .collect();
        vaults.sort_by(|a, b| a.team.cmp(&b.team).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(vaults)
    })
    .await
}

/// 跳到另一个仓库的日程：它的窗口提到前面（没开着就打开），摆在当前窗口的位置和大小上，停在同一页
#[tauri::command]
#[specta::specta]
pub async fn journal_switch<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    path: String,
    page: String,
    date: String,
) -> Result<()> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::Invalid("找不到这个仓库的文件夹了（移动硬盘没插、被改名了）".into()));
    }
    let place = place_of(&window);
    let goto = JournalGoto { page, date };
    let handle = app.clone();
    let (label, existed) = blocking(move || {
        open_vault(&handle, &root, Open { seed: false, remember: true, quiet: true, logical: false })
    })
    .await?;
    if existed {
        if let (Some(target), Some(place)) = (app.get_webview_window(&label), place) {
            apply_place(&target, place);
        }
        if let Err(error) = goto.emit_to(&app, label.as_str()) {
            eprintln!("通知前端失败: {error}");
        }
    } else if let Ok(mut jumps) = app.state::<AppState>().journal_jumps.lock() {
        jumps.insert(label, Jump { place, goto });
    }
    Ok(())
}

/* ---------------- 团队仓库的链接（docs/协同编辑.md §22.3） ----------------
`odea://vault/<托管方>/<owner>/<repo>`：邀请成员时发给对方，点开在启动器里拉一份 */

/// 启动器收到一个团队仓库的链接（它已经开着时）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct LauncherLink(pub String);

pub fn is_vault_link(link: &str) -> bool {
    link.trim().to_ascii_lowercase().starts_with("odea://vault/")
}

/// 交给启动器：开着就直接给，没开着先存着（launcher_take_link）、把它打开
pub fn show_launcher_link<R: Runtime>(app: &AppHandle<R>, link: String) {
    if app.get_webview_window(LAUNCHER).is_some() {
        focus(app, LAUNCHER);
        if let Err(error) = LauncherLink(link).emit_to(app, LAUNCHER) {
            eprintln!("通知前端失败: {error}");
        }
        return;
    }
    if let Ok(mut slot) = app.state::<AppState>().launcher_link.lock() {
        *slot = Some(link);
    }
    if let Err(error) = show_launcher(app) {
        eprintln!("打开启动器失败: {error}");
    }
}

/// 启动器起来时取：打开它的那个团队仓库链接
#[tauri::command]
#[specta::specta]
pub async fn launcher_take_link(state: State<'_, AppState>) -> Result<Option<String>> {
    Ok(lock(&state.launcher_link)?.take())
}

/// 仓库窗口里点了团队仓库的链接（冷启动时它先被交给了最近的仓库窗口）：交给启动器
#[tauri::command]
#[specta::specta]
pub async fn launcher_open_link<R: Runtime>(app: AppHandle<R>, link: String) -> Result<()> {
    if !is_vault_link(&link) {
        return Err(AppError::Invalid("这不是团队仓库的链接".into()));
    }
    show_launcher_link(&app, link);
    Ok(())
}
