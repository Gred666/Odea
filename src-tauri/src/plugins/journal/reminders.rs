/* ============================================================
到点提醒（docs/提醒与属性.md §1）：没勾的任务写了日期和几点（或者 ⏰），到点弹一条系统通知、响一声。

- 哪些会响：task 表里没做完的、所在文档没归档的；时间是钟点（上午、下午这种不响）。写了 ⏰ 就是那个时刻，
  没写的是「日期 几点」减去提前量。只看开着日程的仓库窗口；应用关了不响
- 计时：一个应用一个线程，每分钟的整点前后醒，按墙上的时钟看「上次看过到现在」之间有哪些到点了。
  睡眠醒来一次跨过好几条的合成一条（只补 12 小时内的）；刚打开应用不补（关着时到点的不算）
- 去重：仓库窗口 + 文档 id + 那一行的原文 + 响的时刻。行号会漂，原文不漂；改了几点是新的一条
- 通知、声音由核心的 notify.rs 发和放；「完成」「打开」交给那个仓库窗口的前端（ReminderAction），
  「10 分钟后」这里记着。在别处勾掉了，还挂着的那条自己收掉
- 设置存在本机（数据目录的 reminders.json），不跟仓库同步

这一半（算哪些到点了、通知上写什么）不依赖 Tauri，有单测；计时线程、命令在 runtime 里。
============================================================ */

use std::path::Path;

use chrono::{Duration, NaiveDate, NaiveDateTime};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::domain::model::DocRef;
use crate::error::Result;

use super::tasks::{self, task_row, TaskRow, TASK_COLUMNS};
use super::vault::source_of;

/// 设置文件（数据目录里）
const FILE: &str = "reminders.json";
/// 可选的提前量（分钟）
pub const LEADS: [u32; 6] = [0, 5, 10, 15, 30, 60];
/// 可选的声音：清泉、木铃、系统的提醒声、不响
pub const SOUNDS: [&str; 4] = ["chime", "marimba", "system", "off"];
/// 睡眠醒来最多补多久以前的
pub const CATCH_UP_HOURS: i64 = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ReminderSettings {
    /// 到点提醒
    pub enabled: bool,
    /// 提前几分钟（LEADS 里的一个）。写了 ⏰ 的不管它
    pub lead_minutes: u32,
    /// SOUNDS 里的一个
    pub sound: String,
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self { enabled: true, lead_minutes: 0, sound: "chime".into() }
    }
}

impl ReminderSettings {
    /// 不认得的值换成默认的（手改坏了的配置、以后版本加的选项）
    pub fn sanitized(mut self) -> Self {
        if !LEADS.contains(&self.lead_minutes) {
            self.lead_minutes = 0;
        }
        if !SOUNDS.contains(&self.sound.as_str()) {
            self.sound = "chime".into();
        }
        self
    }
}

pub fn load(data_dir: &Path) -> ReminderSettings {
    std::fs::read(data_dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ReminderSettings>(&bytes).ok())
        .unwrap_or_default()
        .sanitized()
}

pub fn save(data_dir: &Path, settings: &ReminderSettings) -> Result<()> {
    let json = serde_json::to_vec_pretty(settings).map_err(|error| crate::error::AppError::Internal(error.to_string()))?;
    let tmp = data_dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, data_dir.join(FILE))?;
    Ok(())
}

/// 到点的一条
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub doc_id: String,
    pub line: usize,
    pub raw: String,
    pub title: String,
    pub source: DocRef,
    /// 出处：笔记的标题、「11月12日」「第 46 周目标」
    pub source_label: String,
    /// 任务写的那个时刻（通知上写的「18:00」）
    pub at: NaiveDateTime,
    /// 响的时刻：写了 ⏰ 是它，没写是 at 减去提前量
    pub fire: NaiveDateTime,
}

fn parse_at(date: &str, time: &str) -> Option<NaiveDateTime> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let time = chrono::NaiveTime::parse_from_str(&tasks::clock(time)?, "%H:%M").ok()?;
    Some(date.and_time(time))
}

/// 这条任务几点、几点响。不响的（没写钟点、⏰ 写坏了）是 None
pub fn fire_time(row: &TaskRow, lead_minutes: u32) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let at = row.time_label.as_deref().and_then(|time| parse_at(&row.due_date, time));
    if let Some(remind) = row.remind_at.as_deref() {
        let (date, time) = remind.split_once(' ')?;
        let fire = parse_at(date, time)?;
        return Some((at.unwrap_or(fire), fire));
    }
    let at = at?;
    Some((at, at - Duration::minutes(i64::from(lead_minutes))))
}

/// 响的时刻落在 (from, to] 里的那几条，按响的先后排
pub fn due_between(conn: &Connection, from: NaiveDateTime, to: NaiveDateTime, lead_minutes: u32) -> Result<Vec<Due>> {
    // 提前量会把明天凌晨的任务拉到今天响：日期往后多看提前量那么久；往前多看一天（⏰ 可以写在任务日期之前）
    let first = (from - Duration::days(1)).date().format("%Y-%m-%d").to_string();
    let last = (to + Duration::minutes(i64::from(lead_minutes)) + Duration::days(1)).date().format("%Y-%m-%d").to_string();
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_COLUMNS} FROM task t JOIN doc d ON d.id = t.doc_id
         WHERE t.done = 0 AND d.is_archived = 0
           AND (t.due_date BETWEEN ?1 AND ?2 OR substr(t.remind_at, 1, 10) BETWEEN ?1 AND ?2)"
    ))?;
    let rows = stmt.query_map(params![first, last], task_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut due: Vec<Due> = rows
        .iter()
        .filter_map(|row| {
            let (at, fire) = fire_time(row, lead_minutes)?;
            (fire > from && fire <= to).then(|| {
                let (source, source_label) = source_of(row);
                Due {
                    doc_id: row.doc_id.clone(),
                    line: row.line,
                    raw: row.raw.clone(),
                    title: row.title.clone(),
                    source,
                    source_label,
                    at,
                    fire,
                }
            })
        })
        .collect();
    due.sort_by(|a, b| a.fire.cmp(&b.fire).then_with(|| a.doc_id.cmp(&b.doc_id)).then(a.line.cmp(&b.line)));
    Ok(due)
}

/// 这一条还没做完（还在、没勾、没归档）：挂着的通知要不要收、稍后的还响不响
pub fn still_open(conn: &Connection, doc_id: &str, raw: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task t JOIN doc d ON d.id = t.doc_id
         WHERE t.doc_id = ?1 AND t.raw = ?2 AND t.done = 0 AND d.is_archived = 0",
        params![doc_id, raw],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 去重的键：同一个仓库窗口里、同一行原文、同一个响的时刻只响一次
pub fn fired_key(window: &str, due: &Due) -> String {
    format!("{window}\u{1f}{}\u{1f}{}\u{1f}{}", due.doc_id, due.raw, due.fire.format("%Y-%m-%d %H:%M"))
}

/// 「今天」「明天」「11月14日」：不是今天的时候放在钟点前面
fn day_word(at: NaiveDateTime, now: NaiveDateTime) -> String {
    use chrono::Datelike;
    let days = (at.date() - now.date()).num_days();
    match days {
        0 => String::new(),
        1 => "明天 ".into(),
        -1 => "昨天 ".into(),
        _ => format!("{}月{}日 ", at.month(), at.day()),
    }
}

/// 一条的通知：第一行是任务，第二行「还有 10 分钟 · 18:00 · 这周要做的」
pub fn single_lines(due: &Due, now: NaiveDateTime, snoozed: bool) -> (String, String) {
    let mut second = String::new();
    if snoozed {
        second.push_str("稍后提醒 · ");
    } else {
        let left = (due.at - now).num_minutes();
        if left > 0 {
            if left >= 60 && left % 60 == 0 {
                second.push_str(&format!("还有 {} 小时 · ", left / 60));
            } else {
                second.push_str(&format!("还有 {left} 分钟 · "));
            }
        }
    }
    second.push_str(&day_word(due.at, now));
    second.push_str(&due.at.format("%H:%M").to_string());
    if !due.source_label.is_empty() {
        second.push_str(" · ");
        second.push_str(&due.source_label);
    }
    (due.title.clone(), second)
}

/// 好几条合成一条：标题、下面两行（前两条，再多的说还有几条）
pub fn group_lines(items: &[Due], away: bool, now: NaiveDateTime) -> (String, Vec<String>) {
    let title = if away {
        format!("你不在的时候有 {} 条到点了", items.len())
    } else {
        format!("有 {} 条到点了", items.len())
    };
    let line = |due: &Due| format!("{}{} {}", day_word(due.at, now), due.at.format("%H:%M"), due.title);
    let lines = match items {
        [] => Vec::new(),
        [one] => vec![line(one)],
        [one, two] => vec![line(one), line(two)],
        // 正好三条：第二行放两条；再多的说还有几条
        [one, two, three] => vec![line(one), format!("{} · {}", line(two), line(three))],
        [one, two, rest @ ..] => vec![line(one), format!("{} · 还有 {} 条", line(two), rest.len())],
    };
    (title, lines)
}

#[cfg(feature = "desktop-runtime")]
pub use runtime::start;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
pub use runtime_types::*;

/// 跨 IPC 的类型和命令（导出绑定时也要有）
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod runtime_types {
    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Runtime, State};

    use super::*;
    use crate::state::AppState;

    /// 提醒设置对话框要的：设置，加上现在是不是在勿扰（提示一句「现在不会出声」）
    #[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ReminderState {
        pub settings: ReminderSettings,
        /// 现在开着勿扰、全屏、演示：我们的提示音不出声
        pub quiet: bool,
        /// 这个平台的通知有按钮（Windows）；没有的只是告诉一声
        pub actions: bool,
    }

    /// 交给仓库窗口的前端：done 把那一行勾上（开着编辑器的经编辑器改），open 打开那一篇、停在那一行
    #[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
    #[serde(rename_all = "camelCase")]
    pub struct ReminderAction {
        pub action: String,
        pub doc_id: String,
        pub line: u32,
        pub raw: String,
        pub source: DocRef,
    }

    fn state_of(settings: ReminderSettings) -> ReminderState {
        ReminderState { settings, quiet: crate::notify::quiet(), actions: cfg!(windows) }
    }

    #[tauri::command]
    #[specta::specta]
    pub async fn reminder_settings(state: State<'_, AppState>) -> Result<ReminderState> {
        Ok(state_of(load(&state.data_dir)))
    }

    #[tauri::command]
    #[specta::specta]
    pub async fn reminder_configure(state: State<'_, AppState>, settings: ReminderSettings) -> Result<ReminderState> {
        let settings = settings.sanitized();
        save(&state.data_dir, &settings)?;
        Ok(state_of(settings))
    }

    /// 试听：不管勿扰（是人点的）
    #[tauri::command]
    #[specta::specta]
    pub async fn reminder_preview(sound: String) -> Result<()> {
        #[cfg(feature = "desktop-runtime")]
        super::runtime::play(&sound);
        let _ = sound;
        Ok(())
    }

    /// 「发一条试试」：照现在的设置弹一条、响一声（不管勿扰）
    #[tauri::command]
    #[specta::specta]
    pub async fn reminder_test<R: Runtime>(app: AppHandle<R>, window: tauri::WebviewWindow<R>) -> Result<()> {
        #[cfg(feature = "desktop-runtime")]
        super::runtime::test(&app, window.label())?;
        let _ = (app, window);
        Ok(())
    }
}

#[cfg(feature = "desktop-runtime")]
mod runtime {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use chrono::{Local, NaiveDateTime, Timelike};
    use tauri::{AppHandle, Manager, Runtime};
    use tauri_specta::Event;

    use super::*;
    use crate::notify::{self, Button, Toast};
    use crate::state::AppState;

    /// 提示音。开头按 4 字节对齐：PlaySound 把它当 WCHAR 指针收
    #[repr(C, align(4))]
    struct Wav<T: ?Sized>(T);
    static CHIME: &Wav<[u8]> = &Wav(*include_bytes!("../../../sounds/reminder-chime.wav"));
    static MARIMBA: &Wav<[u8]> = &Wav(*include_bytes!("../../../sounds/reminder-marimba.wav"));
    /// 通知上的图标（没装的版本登记应用标识时用）
    const ICON: &[u8] = include_bytes!("../../../icons/128x128.png");

    /// 挂着的一条通知：是谁的、点了做什么
    #[derive(Clone)]
    enum Shown {
        Task { window: String, due: Due },
        /// 合成的一条：点了翻到日历的这一天
        Group { window: String, date: String },
        Test { window: String },
    }

    #[derive(Default)]
    struct State {
        /// 上次看到哪个时刻
        last: Option<NaiveDateTime>,
        /// 响过的（键 → 响的时刻），两天前的扔掉
        fired: HashMap<String, NaiveDateTime>,
        /// 「10 分钟后」：到时候再响
        snoozes: Vec<(NaiveDateTime, String, Due)>,
        shown: HashMap<String, Shown>,
        next: u64,
        last_sound: Option<Instant>,
    }

    static STATE: Mutex<Option<State>> = Mutex::new(None);

    fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
        let mut guard = STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(guard.get_or_insert_with(State::default))
    }

    fn now() -> NaiveDateTime {
        Local::now().naive_local().with_nanosecond(0).unwrap_or_else(|| Local::now().naive_local())
    }

    fn app_id<R: Runtime>(app: &AppHandle<R>) -> String {
        app.config().identifier.clone()
    }

    /// 启动时（lib.rs 的 setup）：起计时线程
    pub fn start<R: Runtime>(app: &AppHandle<R>) {
        let app = app.clone();
        let spawned = std::thread::Builder::new().name("reminders".into()).spawn(move || {
            let data_dir = app.state::<AppState>().data_dir.clone();
            let name = app.config().product_name.clone().unwrap_or_else(|| "Odea".into());
            notify::prepare(&app_id(&app), &name, ICON, &data_dir);
            with_state(|state| state.last = Some(now()));
            loop {
                // 睡到下一分钟的整点后 0.3 秒，最多睡 20 秒：睡眠醒来、改了系统时间都很快对上
                let wall = Local::now().naive_local();
                let into = std::time::Duration::from_millis(u64::from(wall.second()) * 1000 + u64::from(wall.nanosecond() / 1_000_000));
                let wait = std::time::Duration::from_millis(60_300).saturating_sub(into).min(std::time::Duration::from_secs(20));
                std::thread::sleep(wait.max(std::time::Duration::from_millis(200)));
                tick(&app);
            }
        });
        if let Err(error) = spawned {
            eprintln!("起提醒线程失败: {error}");
        }
    }

    /// 仓库的名字（开着好几个仓库时写在通知最下面）
    fn vault_name(workspace: &crate::state::Workspace) -> String {
        let root = workspace.root();
        root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
    }

    fn tick<R: Runtime>(app: &AppHandle<R>) {
        let settings = load(&app.state::<AppState>().data_dir);
        let now = now();
        let last = with_state(|state| state.last.replace(now)).unwrap_or(now);
        if now <= last {
            return;
        }
        // 隔了 3 分钟以上（平时 20 秒一次）：电脑睡了一觉
        let away = now - last > Duration::minutes(3);
        let from = last.max(now - Duration::hours(CATCH_UP_HOURS));

        let workspaces: Vec<_> = app
            .state::<AppState>()
            .all_workspaces()
            .into_iter()
            .filter(|workspace| workspace.vault.lock().map(|vault| vault.layout().has_plugin(super::super::ID)).unwrap_or(false))
            .collect();
        let several = workspaces.len() > 1;

        // 挂着的通知：任务在别处勾掉了、仓库窗口关了，收掉
        let shown: Vec<(String, Shown)> = with_state(|state| state.shown.iter().map(|(tag, shown)| (tag.clone(), shown.clone())).collect());
        let mut stale = Vec::new();
        for (tag, shown) in &shown {
            let window = match shown {
                Shown::Task { window, .. } | Shown::Group { window, .. } | Shown::Test { window } => window,
            };
            let Some(workspace) = workspaces.iter().find(|workspace| &workspace.label == window) else {
                stale.push(tag.clone());
                continue;
            };
            if let Shown::Task { due, .. } = shown {
                let open = workspace.vault.lock().ok().map(|vault| still_open(vault.db(), &due.doc_id, &due.raw).unwrap_or(true));
                if open == Some(false) {
                    stale.push(tag.clone());
                }
            }
        }
        if !stale.is_empty() {
            let id = app_id(app);
            with_state(|state| {
                for tag in &stale {
                    state.shown.remove(tag);
                }
            });
            for tag in &stale {
                notify::remove(&id, tag);
            }
        }

        if !settings.enabled {
            return;
        }

        // 到点的
        let mut found: Vec<(String, String, Due)> = Vec::new();
        for workspace in &workspaces {
            let Ok(vault) = workspace.vault.lock() else { continue };
            match due_between(vault.db(), from, now, settings.lead_minutes) {
                Ok(items) => found.extend(items.into_iter().map(|due| (workspace.label.clone(), vault_name(workspace), due))),
                Err(error) => eprintln!("查到点的任务失败: {error}"),
            }
        }
        // 稍后的：到时候还没做完才响
        let snoozed: Vec<(String, Due)> = with_state(|state| {
            let (ready, waiting): (Vec<_>, Vec<_>) = state.snoozes.drain(..).partition(|(at, _, _)| *at <= now);
            state.snoozes = waiting;
            ready.into_iter().map(|(_, window, due)| (window, due)).collect()
        });
        let mut items: Vec<Item> = Vec::new();
        for (window, due) in snoozed {
            let Some(workspace) = workspaces.iter().find(|workspace| workspace.label == window) else { continue };
            let open = workspace.vault.lock().ok().is_some_and(|vault| still_open(vault.db(), &due.doc_id, &due.raw).unwrap_or(false));
            if open {
                items.push(Item { window, vault: vault_name(workspace), due, snoozed: true });
            }
        }
        with_state(|state| {
            for (window, vault, due) in found {
                let key = fired_key(&window, &due);
                if state.fired.contains_key(&key) {
                    continue;
                }
                state.fired.insert(key, due.fire);
                items.push(Item { window, vault, due, snoozed: false });
            }
            let cutoff = now - Duration::days(2);
            state.fired.retain(|_, fire| *fire > cutoff);
        });
        if !items.is_empty() {
            deliver(app, &settings, items, away, several, now);
        }
    }

    struct Item {
        window: String,
        vault: String,
        due: Due,
        snoozed: bool,
    }

    fn next_tag(prefix: &str) -> String {
        with_state(|state| {
            state.next += 1;
            format!("{prefix}{}", state.next)
        })
    }

    fn deliver<R: Runtime>(app: &AppHandle<R>, settings: &ReminderSettings, items: Vec<Item>, away: bool, several: bool, now: NaiveDateTime) {
        let id = app_id(app);
        let system_sound = settings.sound == "system";
        let mut toasts: Vec<(Toast, Shown)> = Vec::new();
        // 好几条一下子到点：睡醒补的两条以上、平时超过三条，合成一条
        if (away && items.len() > 1) || items.len() > 3 {
            let dues: Vec<Due> = items.iter().map(|item| item.due.clone()).collect();
            let (title, lines) = group_lines(&dues, away, now);
            let tag = next_tag("g");
            let first = &items[0];
            let vaults: std::collections::BTreeSet<&str> = items.iter().map(|item| item.vault.as_str()).collect();
            toasts.push((
                Toast {
                    tag: tag.clone(),
                    title,
                    lines,
                    attribution: several.then(|| vaults.into_iter().collect::<Vec<_>>().join("、")),
                    launch: format!("day:{tag}"),
                    buttons: vec![
                        Button { label: "知道了".into(), argument: format!("dismiss:{tag}"), background: true },
                        Button { label: "看今天的安排".into(), argument: format!("day:{tag}"), background: false },
                    ],
                    sticky: true,
                    system_sound: false,
                },
                Shown::Group { window: first.window.clone(), date: now.format("%Y-%m-%d").to_string() },
            ));
        } else {
            for item in items {
                let (title, line) = single_lines(&item.due, now, item.snoozed);
                let tag = next_tag("r");
                toasts.push((task_toast(&tag, title, line, several.then(|| item.vault.clone())), Shown::Task { window: item.window, due: item.due }));
            }
        }
        if let Some((first, _)) = toasts.first_mut() {
            first.system_sound = system_sound;
        }
        for (toast, shown) in toasts {
            let handle = app.clone();
            with_state(|state| state.shown.insert(toast.tag.clone(), shown));
            if let Err(error) = notify::show(&id, &toast, Arc::new(move |argument| on_activate(&handle, &argument))) {
                eprintln!("{error}");
                with_state(|state| state.shown.remove(&toast.tag));
            }
        }
        if !notify::quiet() {
            ring(settings);
        }
    }

    fn task_toast(tag: &str, title: String, line: String, attribution: Option<String>) -> Toast {
        Toast {
            tag: tag.into(),
            title,
            lines: vec![line],
            attribution,
            launch: format!("open:{tag}"),
            buttons: vec![
                Button { label: "完成".into(), argument: format!("done:{tag}"), background: true },
                Button { label: "10 分钟后".into(), argument: format!("snooze:{tag}"), background: true },
                Button { label: "打开".into(), argument: format!("open:{tag}"), background: false },
            ],
            sticky: true,
            system_sound: false,
        }
    }

    /// 响一声。上一声还没完（3 秒内）不再响；「系统提示音」由通知自己响
    fn ring(settings: &ReminderSettings) {
        let recent = with_state(|state| {
            let recent = state.last_sound.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(3));
            if !recent {
                state.last_sound = Some(Instant::now());
            }
            recent
        });
        if !recent && settings.sound != "system" {
            play(&settings.sound);
        }
    }

    pub fn play(sound: &str) {
        match sound {
            "chime" => notify::play(&CHIME.0),
            "marimba" => notify::play(&MARIMBA.0),
            "system" => notify::play_system(),
            _ => {}
        }
    }

    /// 点了通知或者按钮
    fn on_activate<R: Runtime>(app: &AppHandle<R>, argument: &str) {
        let Some((action, tag)) = argument.split_once(':') else { return };
        let Some(shown) = with_state(|state| state.shown.remove(tag)) else { return };
        match (action, shown) {
            ("done", Shown::Task { window, due }) => emit(app, &window, "done", &due),
            ("snooze", Shown::Task { window, due }) => {
                with_state(|state| state.snoozes.push((now() + Duration::minutes(10), window, due)));
            }
            ("open", Shown::Task { window, due }) => {
                crate::workspace::focus(app, &window);
                emit(app, &window, "open", &due);
            }
            ("day", Shown::Group { window, date }) => {
                crate::workspace::focus(app, &window);
                let _ = crate::workspace::VaultGoto { page: "calendar".into(), arg: date }.emit_to(app, window.as_str());
            }
            ("open", Shown::Test { window }) => crate::workspace::focus(app, &window),
            _ => {}
        }
    }

    fn emit<R: Runtime>(app: &AppHandle<R>, window: &str, action: &str, due: &Due) {
        let event = ReminderAction {
            action: action.into(),
            doc_id: due.doc_id.clone(),
            line: due.line as u32,
            raw: due.raw.clone(),
            source: due.source.clone(),
        };
        if let Err(error) = event.emit_to(app, window) {
            eprintln!("交给仓库窗口失败: {error}");
        }
    }

    /// 「发一条试试」：照现在的设置弹一条示例、响一声
    pub fn test<R: Runtime>(app: &AppHandle<R>, window: &str) -> Result<()> {
        let settings = load(&app.state::<AppState>().data_dir);
        let tag = next_tag("t");
        let mut toast = task_toast(&tag, "这是一条试试的提醒".into(), "到点了就像这样 · 提醒设置".into(), None);
        // 示例点「完成」「10 分钟后」没有事可做：只留「打开」
        toast.buttons.retain(|button| button.argument.starts_with("open:"));
        toast.buttons.insert(0, Button { label: "知道了".into(), argument: format!("dismiss:{tag}"), background: true });
        toast.system_sound = settings.sound == "system";
        with_state(|state| state.shown.insert(tag.clone(), Shown::Test { window: window.into() }));
        let handle = app.clone();
        notify::show(&app_id(app), &toast, Arc::new(move |argument| on_activate(&handle, &argument)))
            .map_err(crate::error::AppError::Invalid)?;
        if settings.sound != "system" {
            play(&settings.sound);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::journal::tasks::TaskRow;

    fn row(due: &str, time: Option<&str>, remind: Option<&str>) -> TaskRow {
        TaskRow {
            id: "n#0".into(),
            doc_id: "n".into(),
            line: 0,
            raw: "- [ ] 交周报".into(),
            title: "交周报".into(),
            done: false,
            due_date: due.into(),
            time_label: time.map(Into::into),
            category: None,
            remind_at: remind.map(Into::into),
            doc_kind: "note".into(),
            doc_key: None,
            doc_title: "这周要做的".into(),
        }
    }

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn only_clock_times_ring_and_the_lead_moves_them_earlier() {
        assert_eq!(fire_time(&row("2026-11-12", Some("18:00"), None), 0), Some((at("2026-11-12 18:00"), at("2026-11-12 18:00"))));
        assert_eq!(fire_time(&row("2026-11-12", Some("9:05"), None), 10), Some((at("2026-11-12 09:05"), at("2026-11-12 08:55"))));
        // 提前量跨过零点
        assert_eq!(fire_time(&row("2026-11-13", Some("00:10"), None), 30).unwrap().1, at("2026-11-12 23:40"));
        assert_eq!(fire_time(&row("2026-11-12", Some("下午"), None), 0), None);
        assert_eq!(fire_time(&row("2026-11-12", None, None), 0), None);
        // ⏰ 不管提前量；任务没写钟点时，通知上写的就是 ⏰ 那个时刻
        assert_eq!(
            fire_time(&row("2026-11-13", Some("18:00"), Some("2026-11-12 17:30")), 30),
            Some((at("2026-11-13 18:00"), at("2026-11-12 17:30")))
        );
        assert_eq!(fire_time(&row("2026-11-12", Some("下午"), Some("2026-11-12 14:30")), 0), Some((at("2026-11-12 14:30"), at("2026-11-12 14:30"))));
    }

    fn due(title: &str, time: &str) -> Due {
        Due {
            doc_id: "n".into(),
            line: 0,
            raw: format!("- [ ] {title}"),
            title: title.into(),
            source: DocRef::note("n"),
            source_label: "这周要做的".into(),
            at: at(time),
            fire: at(time),
        }
    }

    #[test]
    fn the_notification_says_what_when_and_where() {
        let now = at("2026-11-12 17:50");
        let (title, line) = single_lines(&due("交周报", "2026-11-12 18:00"), now, false);
        assert_eq!(title, "交周报");
        assert_eq!(line, "还有 10 分钟 · 18:00 · 这周要做的");
        assert_eq!(single_lines(&due("交周报", "2026-11-12 18:50"), now, false).1, "还有 1 小时 · 18:50 · 这周要做的");
        assert_eq!(single_lines(&due("交周报", "2026-11-12 17:50"), now, false).1, "17:50 · 这周要做的");
        assert_eq!(single_lines(&due("交周报", "2026-11-13 00:10"), now, true).1, "稍后提醒 · 明天 00:10 · 这周要做的");

        let items = [due("交周报", "2026-11-12 15:30"), due("对稿子", "2026-11-12 16:15"), due("开会", "2026-11-12 17:00")];
        let (title, lines) = group_lines(&items, true, now);
        assert_eq!(title, "你不在的时候有 3 条到点了");
        assert_eq!(lines, vec!["15:30 交周报".to_string(), "16:15 对稿子 · 17:00 开会".to_string()]);
        let five: Vec<Due> = (0..5).map(|i| due(&format!("事{i}"), "2026-11-12 17:00")).collect();
        let (title, lines) = group_lines(&five, false, now);
        assert_eq!(title, "有 5 条到点了");
        assert_eq!(lines[1], "17:00 事1 · 还有 3 条");
    }

    #[test]
    fn settings_fall_back_to_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), ReminderSettings::default());
        save(dir.path(), &ReminderSettings { enabled: false, lead_minutes: 15, sound: "marimba".into() }).unwrap();
        assert_eq!(load(dir.path()), ReminderSettings { enabled: false, lead_minutes: 15, sound: "marimba".into() });
        std::fs::write(dir.path().join(FILE), r#"{"leadMinutes":7,"sound":"trumpet"}"#).unwrap();
        assert_eq!(load(dir.path()), ReminderSettings::default());
    }
}
