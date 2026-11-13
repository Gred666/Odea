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
cd src-tauri; cargo test --no-default-features --lib
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
| 桌面端 | `odea-desktop`（`pnpm tauri dev`）；不碰真实笔记用 `odea-desktop-temp`（临时数据目录，WebView2 调试端口 9333） | Rust | 上面那些，加上 Rust 的命令、文件和索引、文件监听、窗口、系统对话框和通知、asset 协议和 CSP |

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
| 常用操作的性能回归（启动、切换、打字、滚动、命令面板、分屏、内存） | `perf.mjs` + `compare.mjs` | 无头 Chrome、mock 后端，默认 4 倍 CPU 降速 + 2x 屏；量生产构建。改之前、改之后各跑一次再对比 |
| 每种窗口打开要加载多少 JS、多久画出来 | `entry.mjs` | 给它构建目录，自己起静态服务（`1110审查与研究.md` §5.3.1） |
| 淡入淡出结束那一帧闪不闪 | `fade-frames.mjs` | 逐帧和终帧比，找「平台」；场景名和读法见下面「逐帧对比」 |
| 窗口级的动画（开窗、关窗、两个窗口交接） | `window-frames.py` | WebView 里量不到，抓屏幕；量窗口的边，不只量亮度 |
| 协作时用输入法打字 | `collab-ime.mjs` | 真 Chrome 里走一遍组字：不丢字、不重复、对方看不到拼音 |
| 表格格子里用输入法打字 | `table-ime.mjs` | 同上，格子里的子编辑器（`表格.md`） |
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

1.5 倍屏无头 Chrome、动画放慢 10 倍，逐帧截那一块和最终帧逐像素比。正确的是差异一路降到 0；
中途画面已经不动、却和最终帧不一样，最后一帧才突然归零（「平台」），就是这个问题。
2026-10-17 图片悬停按钮修之前：淡入 113–141ms 这段有 470–536 个像素和终帧不同，140ms 那一帧跳成终帧；
修之后一路收敛，117ms 起和终帧完全一致。要查别的控件，在脚本的 `SCENES` 里加一个场景，
第二个参数换成它的名字（标题的层级提示和收起箭头是 `heading`，右侧目录树的收起箭头是 `outline`，
协作时别人的名字标签是 `remote`，开在协作实验台 `/?lab=collab` 里；文件列表里文件夹那一行是 `folder`，
置顶那一行是 `pinned`；表格的行抓手是 `table`）。

验证的坑（2026-10-29）：

- DevTools 的 `Emulation.setDeviceMetricsOverride` 模拟的 1.25 / 1.5 倍屏不是真的：排版还按 1 倍算，截图是放大重采样出来的，
  整物理像素对没对齐看不出来（本来是实色的描边也显得糊）。要逐像素看描边，无头 Chrome 用 `--force-device-scale-factor` 起。
  `fade-frames.mjs` 找「平台」不受影响
- 窗口级的动画（系统的开窗、关窗）WebView 里量不到，要抓屏幕：`scripts/perf/window-frames.py`。
  要量窗口的边，别只量亮度 —— 以前只看亮度，把边淡边缩、最后一跳的关窗动画判成了「每帧都合成了，很顺」

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
