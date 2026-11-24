# 怎么验

写功能收尾时的验证和 Verifier 的审查都按这里。没验过的不说「做完了」；验不了的照实写「没走」。

## 1. 每次改动都跑

```bash
pnpm lint
```

```bash
pnpm exec tsc --noEmit
```

```bash
pnpm test
```

改了 Rust 再跑（`cargo` 不在 PATH 上，先看 `PITFALLS/环境.md`）：

```bash
cd src-tauri; cargo fmt; cargo test --no-default-features --lib
```

推到任何分支，GitHub Actions 的「检查」（`.github/workflows/ci.yml`，`技术方案.md` §15）再跑一遍：Ubuntu 上是这四样、下面的 `a11y-names`，
和 clippy（`cargo clippy --no-default-features --lib -- -D warnings`，加 `--profile test` 再一遍，有一条警告就算没过）；
Windows 上重新导出 `src/lib/bindings.ts`，和提交的不一样就算没过 —— 改了 Rust 的命令或类型，记得 `cargo run --example export_bindings --features typegen`。

改了按钮、图标按钮：

```bash
node scripts/a11y-names.mjs --check
```

## 2. 跑起来看

两种跑法，后端不一样（`技术方案.md` §3.2）：

| | 怎么起 | 后端 | 验得了什么 |
|---|---|---|---|
| 浏览器预览 | `.claude/launch.json` 的 `odea`（`pnpm dev`，1420）；生产构建用 `odea-preview`（1432） | `data/mock.ts`，存在 localStorage | 界面、交互、编辑器、动效 |
| 桌面端 | `odea-desktop`（`pnpm tauri dev`）；不碰真实笔记用 `odea-desktop-temp`（临时数据目录，WebView2 调试端口 9333，自己的 identifier `dev.odea.temp`，用户的 Odea 开着也起得来） | Rust | 上面那些，加上 Rust 的命令、文件和索引、文件监听、窗口、系统对话框和通知、asset 协议和 CSP |

- 常用命令在 `TODO.md` 开头的「环境备忘」
- 界面和交互的改动必须真的看渲染结果、真的操作一遍；Rust 那一半的改动要在桌面端走
- 桌面端和无头 Chrome 的结论可能相反，以桌面端为准。用户的桌面端（WebView2）比本机的 Chrome 慢好几倍
- 内置浏览器的截图跟不上动画：判断渲染的问题用 DOM 测量，动效用下面的逐帧脚本
- 用户自己的 Odea 一直开着，起开发版、起两个实例、测系统通知之前先看 `PITFALLS/桌面端实测.md`
- 破坏性的测试（坏数据、故障注入）只在临时的数据目录和临时仓库上做

## 3. 量

脚本都在 `scripts/perf/`，用法写在每个脚本的开头。

| 要查什么 | 脚本 | 说明 |
|---|---|---|
| 常用操作的性能回归（启动、切换、打字、方向键、滚动、命令面板、左侧导航、分屏、内存） | `perf.mjs` + `compare.mjs` | 无头 Chrome、mock 后端，默认 4 倍 CPU 降速 + 2x 屏；量生产构建。改之前、改之后各跑一次再对比。`--only tabs,props` 两个默认不跑：Ctrl+Tab 换篇（含焦点进到新正文的时刻）、长文属性面板里打字和回车存，改了这两处时加上。`--only collab`（协作时访客一直在打字、主持人打字）也默认不跑。同一边两次之间也差 5–10%，要下结论就两边交替各跑 3–5 次、比中位数（`REVIEWS/2026-11-13-全项目审查.md` §3.7） |
| 每种窗口打开要加载多少 JS、多久画出来 | `entry.mjs` | 给它构建目录，自己起静态服务（`REVIEWS/2026-11-10-审查与竞品调研.md` §5.3.1） |
| 淡入淡出结束那一帧闪不闪 | `fade-frames.mjs` | 逐帧和终帧比，找「平台」；场景名和读法见下面「逐帧对比」；`--dpr 1.25` 换成真的倍率 |
| 边栏（刘海 + 侧栏）的动画：动画帧里有没有布局 / 重绘、多倍屏下片和片之间有没有发丝缝 | `edge-chrome.mjs` | `trace`：4 倍降速，收起 / 展开、切区、开关日程各录一段，第一帧之后的 Layout、Paint 一条条列出来（Paint 带着节点），`--dump` 存下 trace 给 Performance 面板看；`seams`：`--force-device-scale-factor` 1 / 1.25 / 1.5 / 2 起，只留形状那几块，底色换成品红，动画放慢 10 倍逐帧找「两边是侧栏色、中间一条不是」的像素；`--gap 1` 故意空出 1px 的缝，自检找不找得到（`边栏.md` §10.3） |
| 窗口级的动画（开窗、关窗、两个窗口交接） | `window-frames.py` | WebView 里量不到，抓屏幕；量窗口的边，不只量亮度 |
| 协作时用输入法打字 | `collab-ime.mjs` | 真 Chrome 里走一遍组字：不丢字、不重复、对方看不到拼音。加 `near`：对方打在同一行；加 `attach`：挂上会话的那一刻正在组字（实验台 `late=1`，`协同编辑.md` §27）；加 `joincompose`：点加入（记本机正文）的那一刻正在组字（§27.5）。`CDP_PORT` 换调试端口 |
| 协作时 Loro 文档的内存、开一篇的耗时、编辑历史和浅快照 | `collab-docs.mjs` | node 直接跑真的 `loro-crdt`，不起界面；篇数是参数（`协同编辑.md` §29.1） |
| 表格格子里用输入法打字 | `table-ime.mjs` | 同上，格子里的子编辑器（`表格.md`）。加 `same`：访客打在主持人这一格；加 `below`：在表格下面紧贴的那一行组字，字不进表格、表格一帧都不塌成源码（`表格.md` §13） |
| 插件沙箱的拒绝测试 | `plugin-sandbox.mjs` | 真的 iframe 和 Worker；`--cdp` 接到开着的桌面端（`插件与跨端.md` §15） |
| 白板的几个实验 | `board/` | `白板.md` §9 |
| 中继的压测 | `relay-load/` | 本机起一台中继，N 个客户端两两互发，量延迟和丢包（`协同编辑.md` §18） |
| 提示音的响度、频谱 | `scripts/sound/reminder.mjs --analyze` | `提醒与属性.md` |
| 发版以后核对 | `scripts/verify-release.mjs <版本号>` | 只用公开地址，和用户的应用看到的一样 |

### 逐帧对比

别凭肉眼，内置浏览器的截图也跟不上动画。用逐帧对比：

```bash
node scripts/perf/fade-frames.mjs http://localhost:1420/ image
```

1.5 倍屏无头 Chrome、动画放慢 10 倍，逐帧截那一块和最终帧逐像素比（要看别的倍率加 `--dpr 1.25`：用 `--force-device-scale-factor` 起，排版、对齐整物理像素都是真的）。正确的是差异一路降到 0；
中途画面已经不动、却和最终帧不一样，最后一帧才突然归零（「平台」），就是这个问题。
2026-10-17 图片悬停按钮修之前：淡入 113–141ms 这段有 470–536 个像素和终帧不同，140ms 那一帧跳成终帧；
修之后一路收敛，117ms 起和终帧完全一致。要查别的控件，在脚本的 `SCENES` 里加一个场景，
第二个参数换成它的名字（标题的层级提示和收起箭头是 `heading`，右侧目录树的收起箭头是 `outline`，
协作时别人的名字标签是 `remote`，开在协作实验台 `/?lab=collab` 里；文件列表里文件夹那一行是 `folder`，
置顶那一行是 `pinned`；表格的行抓手是 `table`；卡片里的录音滚远了、底部的播放条淡入是 `mediabar`、淡出是 `mediabar-out`）。
场景里要放声音的写 `gesture: true`：先真的点一下页面，不然 `play()` 不让放。

验证的坑（2026-10-29）：

- 列表栏行上的「…」（`RowMenu`）悬停时才换成真的菜单：脚本里挪过去马上按，按在还没换的那个按钮上，菜单不开。挪过去停 200ms 再点（`whiteboard/create.mjs`，2026-11-23）

- DevTools 的 `Emulation.setDeviceMetricsOverride` 模拟的 1.25 / 1.5 倍屏不是真的：排版还按 1 倍算，截图是放大重采样出来的，
  整物理像素对没对齐看不出来（本来是实色的描边也显得糊）。要逐像素看描边，无头 Chrome 用 `--force-device-scale-factor` 起
  （`cdp.mjs` 的 `launch(port, ["--force-device-scale-factor=1.25"])`，`edge-chrome.mjs seams` 就是这么起的）。
  `fade-frames.mjs` 找「平台」不受影响
- 窗口级的动画（系统的开窗、关窗）WebView 里量不到，要抓屏幕：`scripts/perf/window-frames.py`。
  要量窗口的边，别只量亮度 —— 以前只看亮度，把边淡边缩、最后一跳的关窗动画判成了「每帧都合成了，很顺」

### 量后端（Rust）和桌面端的启动、内存

`REVIEWS/2026-11-15-桌面端验证.md` §2.4 是一次完整的做法（基线 `a159a2e` 对现在），数在 `技术方案.md` §13.3。

- **核心基准（不起界面）**：在 `src-tauri/src/vault/` 下临时写一个 `#[test] #[ignore]` 的模块（要碰私有函数就在那个文件末尾 `#[cfg(test)] #[path = "xxx.rs"] mod xxx;`），
  环境变量给模板仓库、工作目录；每次先把模板仓库拷到工作目录（不计时），量完打印一行 JSON。`CARGO_TARGET_DIR` 放 `%TEMP%`，
  `cargo test --release --no-default-features --lib --no-run` 编出测试程序，之后直接跑 `odea_lib-*.exe <测试名> --ignored --nocapture --test-threads=1`，源码删了也能跑。
  **用完删掉那个模块和那一两行**，`git status --short -- src-tauri` 里不留
- **比基线**：`git archive <提交> src-tauri | tar -x -C %TEMP%\…\base` 解一份后端，同一个基准模块拷进两边，各编一份（两个 `CARGO_TARGET_DIR`）；两边**交替**跑、每项 5–6 次取中位数，写最小–最大
- **绑一个大核**（这台是大小核，不绑时一整轮慢 40–50%，`PITFALLS/性能.md`）：`cmd /c start /b /wait /affinity 10 <exe> …`；从 node 里起用 `spawnSync("cmd", ["/c","start","/b","/wait","/affinity","10",exe,…])` 才拿得到输出
- **测试仓库**：脚本造（笔记数、日记天数、长文篇数、随机种子固定），几百篇和几千篇各一个，带属性块（中英文键）、任务、链接、代码块、表格
- **端到端（桌面端的发布构建）**：`pnpm tauri build --no-bundle --config <只写 {"identifier":"dev.odea.xxx"} 的 json>`，`CARGO_TARGET_DIR` 放 `%TEMP%`。
  经 WMI 在 MSIX 容器外起一个 .cmd（`Invoke-CimMethod Win32_Process Create`，`PITFALLS/桌面端实测.md`），里面设 `ODEA_DATA_DIR`、`ODEA_VAULT`、`WEBVIEW2_USER_DATA_FOLDER`（都在 `%TEMP%`）
  和 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<端口>`，数据目录里先放好 `config.json`（关速记，免得抢全局快捷键）。
  经 DevTools 协议连上页面，「ready」取 `ipc.localhost/ready` 那条 resource timing 的 `responseEnd + timeOrigin`，减 `Win32_Process` 的 `CreationDate`；
  「编辑器可输入」轮询 `.cm-content` 的 `isContentEditable`。每次 `Stop-Process -Force`，等命令行带那个数据目录的 WebView2 进程都走了再起下一次。
  第一次起要建 WebView2 的配置目录，算热身不计
- **内存**：专用工作集（任务管理器的「内存」），`Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate`，odea.exe（按路径认）+ 命令行带那个数据目录的 WebView2 进程；
  一个 CIM 会话反复用、进程列表隔几次才刷新，0.3 秒采一次。PowerShell 的 `-f` 格式串里 `{0:F1}}}` 会输出字面的 `F1`，右花括号前面空一格
- **收尾**：关掉自己起的进程；删 `%TEMP%` 里的构建目录（几个 GB）、测试仓库；那个 identifier 的 `HKCU\Software\Classes\AppUserModelId\<identifier>`、
  `%APPDATA%`、`%LOCALAPPDATA%` 下以它命名的目录（容器里外各一份，经 WMI 在容器外删）

### 量的规矩

各条的来历在 `PITFALLS/性能.md`、`PITFALLS/环境.md`。


- 改之前、改之后在同样的条件下量，场景要真的一样；写清条件：几倍降速、几倍屏、生产还是开发构建、跑了几次
- 量生产构建：开发构建慢 2.5–3.5 倍
- 量按键延迟别用 Event Timing；量画布别用 `getImageData` 逼着画完
- 在这台机器上量桌面端的启动时间、内存，数据目录要放 `%TEMP%`

## 4. 证据

- 结论后面跟证据：测试的名字和条数、命令的输出、测量的数字和条件、逐帧对比的结果、看过的页面和做过的操作
- 修 Bug：先有稳定的复现（步骤或失败的测试），修完重新走一遍
- 没验的、验不了的照实写，连同原因（「桌面端没走」「macOS 没走」「按钮的回调没亲手点过」）
