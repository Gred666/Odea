# OnTheWay 开发进度

> 每次开工先看这里，收工更新这里。
> 技术基准见 [技术方案.md](./技术方案.md)（v2.0，已按代码现状重写）。

---

## 环境备忘

Rust 装在 **非默认路径**，新终端要先设环境变量否则 `cargo` 找不到：

```powershell
$env:CARGO_HOME="D:\Dev\cargo"; $env:RUSTUP_HOME="D:\Dev\rustup"; $env:Path="D:\Dev\cargo\bin;$env:Path"
```

| 工具 | 版本 |
|---|---|
| Node | v24.10.0 |
| pnpm | 10.30.3 |
| rustc / cargo | 1.96.0 (MSVC) |
| Vite / React / Tailwind | 6.4 / 19.2 / 4.3 |
| Motion | 12.43 |
| CodeMirror view | 6.43 |
| Vitest | 4.1 |

pnpm 10 默认拦截 postinstall，`pnpm-workspace.yaml` 里已放行 `esbuild` 和 `@biomejs/biome`。

**常用命令**

浏览器调 UI（mock 后端，localStorage）：

```bash
pnpm dev
```

桌面端：

```bash
pnpm tauri dev
```

类型检查 / lint / 前端测试：

```bash
npx tsc --noEmit
```

```bash
pnpm lint
```

```bash
pnpm test
```

Rust 测试（`--no-default-features` 下 `main.rs` 编不过，必须加 `--lib`；装了 WebView 依赖的机器上 `cargo test --lib` 会连 `commands.rs` 一起测）：

```bash
cd src-tauri; cargo test --no-default-features --lib
```

不碰真实笔记跑桌面端（换一个应用数据目录和仓库文件夹；想试搬家就先把 `ontheway.db` 拷一份进这个数据目录）：

```powershell
$env:ONTHEWAY_DATA_DIR="D:\tmp\otw-data"; $env:ONTHEWAY_VAULT="D:\tmp\otw-vault"; pnpm tauri dev
```

不起 app 重新生成 `src/lib/bindings.ts`（debug 启动也会自动生成）。注意这条命令导出的文件里没有 `ready` / `win_*` 这几个窗口命令（它们只在 desktop-runtime 下注册），提交前以 debug 启动生成的为准：

```bash
cd src-tauri; cargo run --example export_bindings --features typegen --no-default-features
```

---

## 设计基准（从 Prototype/ 提炼）

**核心抽象：一切皆文档。** 笔记、今日TODO、GOAL、日历的某一天、归档项 —— 全部是同一种结构：

```
（可选横幅）大标题 +（可选分段控件）
正文 Markdown（CodeMirror 所见即所得）
右侧目录树 + 底部状态栏
```

五个模块不是五套 UI，是同一个 `DocumentView` 的不同数据源。新增内容类型 = 在
`data/adapter.ts` 里多映射一个 `DocumentModel`，**不写新视图组件**。守住这条。

**布局**

| 区域 | 宽度 | 出现条件 |
|---|---|---|
| 标题栏 | 38px，无背景，浮在内容上 | 仅 Tauri 内 |
| 左导航 | 240px（可收成 64px 图标栏） | 常驻 |
| 中列表栏 | 300px | 笔记 / 日历 / 归档；今日TODO、GOAL、扩展 是两栏 |
| 主内容 | flex-1，内容 max-w 860px | 常驻 |
| 右目录树 | 180px | ≥1280px 显示（`xl:`），条目多了自己滚动；专注模式下是贴右缘的浮层刻度 |

**色板**（亮色取样自原型图，1:1；暗色手工配平）见技术方案 §9.1。

---

## 阶段划分

- [x] **P0 环境与规划**
- [x] **P1 前端骨架与设计系统**
- [x] **P2 应用外壳与导航动效**
- [x] **P3 五个视图**
- [x] **P4 Tauri 外壳接入**
- [x] **P5 Rust + SQLite 后端**
- [x] **P6 编辑器**（Milkdown 接入 → 实机不行 → 换成 CodeMirror 6）
- [x] **P6.5 文档模型收口**（行动项迁回 Markdown、今日TODO = 某一天、GOAL 一周期一篇）
- [ ] **P7 打磨与性能**
- [ ] **P8 多设备同步（内置 git）** ← 现在（2026-10-07 设计定稿，见技术方案 §5.9）

---

## 已完成

### P1 骨架与设计系统 ✅

- `styles/globals.css`：色板 token、亮暗双主题（`data-theme` + `@custom-variant dark`）、`prose-doc` 排版、编辑器全部样式
- `lib/motion.ts`：spring（含 `layout`）/ tween（含 `instant` `slow`）预设、stagger、layoutId 命名空间、`usePrefersReducedMotion`
- `lib/date.ts`：全局唯一时间入口，ISO 日期字符串、周期起止、月网格、ISO 周数、中文格式化
- `lib/markdown.tsx`：`buildOutline`（ATX / Setext / callout 进目录树）、`countWords`；`renderMarkdown` 现在只做占位
- `lib/cn.ts`、`lib/tauri.ts`、`lib/platform.ts`（mac ⌘ / Windows Ctrl 的快捷键提示）
- `data/types.ts` / `seed.ts` / `store.ts` / `adapter.ts` / `backend.ts` / `mock.ts`

### P2 外壳与动效 ✅

| 位置 | 动效 |
|---|---|
| Logo | SVG 九段笔画 `stroke-dashoffset` 依序描出、停一拍、再收回，无限循环 |
| 导航活动项 | `layoutId` 指示块滑动 |
| 导航项入场 | stagger |
| 中列表栏出现/消失 | 整块 `x: -300 → 0` 从导航栏底下抽出，**220ms tween**；布局只在挂载那一帧变一次（见坑记录） |
| 主内容切换 | `popLayout` 冻结退场屏交叉淡出，退场方向感知横移；**进场纯 opacity**（编辑器才能第一帧挂上） |
| 切换文档（笔记 / 日历某天 / GOAL 周期） | `SwapFade`：旧内容的静态快照原地淡出上飘 4px（140ms），新内容纯 opacity 淡入（220ms）；标题、正文、状态栏、目录树整块一起换 |
| 标题下分隔线 | `scaleX` 从 0 展开（进工作区时一次，换篇不重播） |
| 目录树活动条 | `layoutId` 滑动，跟编辑器行号联动 |
| 主题切换按钮 | 图标旋转交叉淡入 |
| 命令面板 | 静态 backdrop-blur + 只动 opacity/scale |
| 专注模式 | 左侧 chrome 切 absolute 后 `x: -540` 滑出，正文画布往左多铺 540px |

### P3 五个视图 ✅

- **笔记**：标题筛选、三种排序（单选菜单）、置顶分组、选中高亮 `layoutId` 滑动、新建、行菜单（置顶 / 归档 / 删除）
- **今日TODO**：两栏，就是今天这一天的文档
- **/GOAL**：周月年分段，一个周期一篇，标题由周期算
- **日历**：6×7 固定月网格、ISO 周数、选中周整行高亮、方向感知切月、「今天」按钮按需出现、写过的日子墨点；右侧「日TODO / 周·月·年 GOAL」四段
- **归档**：归档横幅、分类·日期、悬停旋转的恢复按钮，正文仍可编辑
- **扩展**：目录页（官方占位 + 本地导入清单），无运行时；2026-10-07 起不在导航里（页面留着，等有运行时再放回来）
- **命令面板**：⌘K，跳转 / 笔记 / 外观三组，方向键 + 回车

### 行动项勾选动画（日历「当日安排」）

三层同时发生，总时长约 380ms：对勾 `pathLength` 描边、圆环脉冲、文字色过渡。

### P4 Tauri 外壳 ✅

- `src-tauri/` 脚手架、`tauri.conf.json`、`Cargo.toml`（feature `desktop-runtime` / `typegen`）、`capabilities/default.json`
- 应用图标：蓝底 + 一条「在路上」的弧线，全套尺寸
- 无边框窗口 + 自定义标题栏 `TitleBar.tsx`：按钮平时 opacity 0.28，悬停浮现；双击最大化；`win_start_dragging` 必须在 mousedown 同一调用栈发起
- `visible: false` + 首帧双 rAF 后 `ready()` 才 show()，消除开局白闪
- 单实例、窗口状态记忆
- 关窗保护：`onCloseRequested` → flush 所有编辑器 → `win_force_close`；保存失败不锁死窗口，再点一次放弃修改

### P5 Rust + SQLite ✅

- `0001_init.sql` + 三次迁移（见技术方案 §5.3）
- 连接池 + PRAGMA（WAL / foreign_keys 每连接都要设）；迁移前 Online Backup；`DbTooNew` 拒绝降级
- `domain/` 各模块 + 59 个单测（迁移链路、FTS5、rrule / 时区、双链、延续语义…）
- jieba 分词 + FTS5（**不要用 trigram**，中文双字词搜不到）；`build_match_query` 空 / 纯标点返回 None
- tauri-specta 生成 `src/lib/bindings.ts`；三个 crate 版本 `=` 锁死；`typegen` feature 可不起 app 导出
- 笔记 / 任务变更与 append-only `activity` 同一事务
- 双链保存时同步 `link(kind='ref')`，不存在的目标保留 Markdown
- 首次启动 `seed::ensure` 播种示例内容，`setting.seeded_v1` 标记只播一次
- 浏览器 mock backend（`otw.mock.v3`）语义贴近 Rust

### P6 编辑器 ✅（CodeMirror 6）

Milkdown 在实机上接入后被整个换掉：AST ↔ Markdown 互转导致输入跳行、内容漂移，Crepe 的框架 UI 也和原型不合。现在：

- `@codemirror/lang-markdown`（CommonMark + GFM）解析，文档始终是 Markdown 源文
- Typora 式装饰：光标不在的语法范围藏标记 + 加样式，进入后原位展开
- 装饰拆成块级 `StateField`（全文浅遍历）+ 行内 `ViewPlugin`（只处理视口）：53KB 文档 5.3ms → 0.57ms
- widget：任务勾选框（点击改源码）、列表符号、围栏封口 + 语言名、分隔线、图片、表格（点击回源码）
- `markdownStyleRegistry.ts` 注册表：新增纯样式语法只加一行
- Typora 对齐的快捷键（`Mod-k` 让给命令面板；插入链接 `Shift-Mod-k`）；搜索面板中文化
- 串行 400ms 防抖保存；Mod-S / 失焦 / 切换 / 关窗统一 flush；失败版本放回队列重试
- 外部回填只在本地无未同步编辑时进行（修掉「某天备注异步到达前一输入就整篇覆盖」的 P0）
- 编辑器分包在 bootstrap 里预载，首帧直接是编辑器，没有「预览 → 编辑器」的闪动
- 目录树用编辑器行号跳转；正文变化 250ms 防抖、标题集合没变不重渲染
- 自绘 `OverlayScrollbar`，滑块对 `scrollHeight` 的变化做指数缓动跟随
- 支持 / 不支持的语法清单见技术方案 §11.4

### P6.7 动态表情 ✅

- 自己画的 48 个线稿动画表情（心情 / 干劲 / 在路上 / 日常 / 打工人 / 吃瓜 / 表态 / 小动物），SVG + Web Animations，亮暗主题都跟着变
- 源文是 `:otw_<id>:` 短码；编辑器里像一个字符（贴着不展开、退格整删、方向键跨过），看得见就一直循环，单击从头再来、双击改源码
- `Mod-e` 选择器：贴光标、最近使用、中文 / 拼音 / 英文搜索、方向键 + 回车、输入法组字不误触
- 列表摘要、目录、表格单元格里换成 Unicode；主包只带一张「短码 → Unicode」的小表
- 行高零变化、在前面打字不重播、滚出视口就停、同时循环最多 48 个；细节见技术方案 §11.4.2
- 性能：静止时换成一张按主题缓存的图，只在循环时叠上活的 SVG —— 一屏 400 个表情首次渲染 217 → 103ms，画质逐像素验证未变；循环每轮用计时器重播，停顿期间不占帧
- 第三批「网络梗」12 个：打工人（摸鱼、躺平、头秃、下班、充电、奶茶）和吃瓜（吃瓜、鸽了、柠檬精、裂开、666、灵魂出窍）；选择器六组放不下，网格限高滚动，矮窗口里两边都放不下时压矮网格贴在空间大的一侧
- 第四批 12 个：表态（狗头、捂脸、尴尬、翻白眼、叹气、点赞）和小动物（猫猫探头、冲鸭、熬夜、慢慢来、破壳、干饭）

### P6.6 Markdown 语法补全 ✅

- 解析器识别但以前没表现的：`~sub~` `^sup^`、`:emoji:`（`editor/emoji.ts` 短码表）、`&entity;`（`editor/entities.ts`）、硬换行 `↵`、`\*` 只藏反斜杠、块级 HTML、嵌套引用按层叠竖线
- 新语法：`==高亮==`、`[[双链]]` / `[[目标|别名]]`、`[^脚注]`、`> [!标签]` callout（五种语义 + 中文自定义）、`[TOC]` 目录 widget、YAML front matter 折叠、图片 `"title"` 与 `|300x200`
- 方括号分流：没有定义的 `[文字]` 不再被染成链接（以前任何 `[x]` 都藏括号变链接色），块级层收集 `referenceLabels` 供行内层判断
- 围栏代码：`@codemirror/language-data` 按语言懒加载 + `codeHighlight.ts` 调色板（`--code-*`，亮暗各一套）；封口带复制按钮（clipboard API 失败退回 execCommand）
- 链接：Mod + 点击打开（`@tauri-apps/plugin-opener`，只放行 http(s) / mailto / tel），按住 Mod 变手形，悬停 tooltip 显示地址
- 表格单元格 / 目录条目用 `editor/inlineDom.ts` 渲染行内格式，真实 DOM 不走 innerHTML
- widget 全部搬到 `editor/widgets.ts`；`MarkdownEditor.tsx` 只剩两层装饰的编排
- 测试：`markdownSyntax.dom.test.ts`（21 个 DOM 用例）+ `markdownExtras.test.ts`（纯函数）

### P6.5 文档模型收口 ✅

- 行动项区块（`link(kind='action')` + 独立 task）迁回宿主正文的 `## 标题` + `- [ ]`（迁移 0003），整篇文档只有一个编辑面
- 「今日TODO」从特殊笔记 `n-today` 变成今天这一天的 `day_doc`（迁移 0004），`day_doc` 加可编辑标题
- 今天没写过时**延续**之前最近一天（`carried_from`），一编辑才落库；零点翻页丢掉延续缓存
- GOAL 合并成一篇 `content_md`、`UNIQUE(horizon, period_start)`（迁移 0002）；没写过的周期返回空文档不落库；`period_start` 必须是周期起点
- 零点翻页 `startTodayTicker`：对准下一个零点 + 唤醒对表
- 专注模式（笔记区）：Esc 退出、离开笔记区自动退出

## P7 打磨

- [x] ~~全文搜索接回界面~~ —— 不做：标题筛选（归档按标题 + 正文）就够用（2026-10-06）
- [x] 双链 `[[…]]` 编辑器内表现 + Mod 点击跳转（反向链接面板还没有）
- [x] callout `> [!标签]` 的编辑器内表现
- [x] 代码块语法高亮 + 复制按钮
- [x] 表格 widget 单元格走行内渲染
- [x] 下标 / 上标 / Emoji 短码 / 实体 / 硬换行 / 转义 / `==高亮==` / 脚注 / `[TOC]` / front matter / 嵌套引用 / 图片 title 与尺寸 / Mod 点击打开外链
- [x] 行内 / 块级 HTML（白名单净化，不走 innerHTML）、`<br>` 多行单元格、callout 标题与 `[!x]-` 折叠、有序列表自动编号、单 `~` 删除线（下标改 `<sub>`）、`[[笔记#小节]]`、脚注悬停与跳转、KaTeX 公式、mermaid 图表、```csv 表格、定义列表、缩写、智能标点、本机图片 asset 协议 + CSP 放行网络图片（见技术方案 §11.4）
- [x] 编辑区动效：标记淡入、替身淡入、勾选描边、复制反馈、标题层级提示（见技术方案 §11.4.1）
- [x] 长文档刚打开时 `[TOC]` 只列前几节、后面的表格公式是源码（块级层只看到前 3000 字符的语法树）；表格分隔行 `:--:` 被拒；脚注徽章压住上一行；块级公式挂竖滑块；缩写常驻点线
- [x] 表格 / CSV 重做成圆角卡片 + 数字列右对齐，CSV 加标签栏；自绘光标（`smoothCaret.ts`：滑动、柔和闪烁）；脚注 / 缩写改用悬停卡片（`hoverCard.ts`）
- [x] 表格 / CSV 格子里直接编辑（`tableWidget.ts`：露出单格源码、逐字写回、Tab / Enter / 方向键导航、插入 / 删除行）
- [x] Ctrl+F 边打边跳到第一个匹配，跳过去后把匹配项钉在屏幕上；块级替身报估计高度并记住真实高度（远处跳转不再整页下沉）
- [x] 表格加列 / 删列 / 改对齐（工具栏；GFM 插删列时整表按显示宽度重新排版）；换格时工具栏不再闪
- [x] 查找、目录树、[TOC]、脚注的跳转改成平滑滑过去（`glide.ts`）
- [x] 切换笔记不再「闪一下」：以前正文硬切、标题先消失再弹上来、分隔线缩回再展开、目录逐条错峰，各块到场时间不一；现在 `SwapFade` 整块交叉淡化（见技术方案 §10.3）
- [x] 长标题折行：正文大标题从 `input` 换成随内容长高的 `textarea`（`field-sizing: content`，不支持的内核 JS 量高），目录树（常规 / 专注两种形态）里的长标题也完整折行、不截断；笔记 / 归档列表的标题单行，超出用省略号
- [x] 按文档缓存编辑器状态：切回来不再解析全文，撤销历史也在。生产包里 66KB 的「语法全览」切回来 160–220ms → 约 58ms（第一次打开仍约 124ms，见技术方案 §11.6）
- [x] **文件是真相**：每篇文档是仓库文件夹（默认「文档/OnTheWay」）里的一个 .md，SQLite 只做可重建的索引；旧库第一次启动时自动搬进来（旧库原样留着）；文件监听 + 冲突副本；日历当日安排改成来自正文里带日期的 `- [ ]`；行菜单 / 状态栏 / 命令面板「在文件夹中显示」；命令面板可以更换笔记文件夹（见技术方案 §5）
- [x] 今日TODO / GOAL 模板：一行里输入 `/模板`（`/model` `/mb` `、模板` 也行）弹出这篇能用的模板 + 缩略预览，回车插入、Shift+回车替换全文（没勾的任务收进「待续」）；11 个模板按日期现算，周计划的每天一件事、各级复盘节点写成带日期的任务进日历；只有日期没写事情的任务不再进日历（见技术方案 §11.4.3）
- [x] 反向链接面板：笔记正文后面列出写了 `[[这篇]]` 的笔记 / 某一天 / 目标，带上下文行，点一行跳过去滚到那一行（技术方案 §12.1）
- [x] 改标题时顺手改别处的 `[[旧标题]]`（2026-10-07）：标题写完存好后，笔记 / 某一天 / 目标里链到旧标题的都改，别名、小节照留，代码里的不动；提示条可撤销（改完又被改过的那篇不撤）。新标题写不进双链、撞名、还有别的笔记叫旧标题时不改，提示原因（技术方案 §12.1）
- [x] 识别网盘的冲突副本：属性块 id 重复，或名字是 Dropbox / Syncthing / Google Drive / 百度网盘 / OneDrive / 本应用的冲突样式且原文在旁边；列表打标签，打开是冲突横幅（查看差异、打开原文、用这一版替换、删掉副本），新出现的有提示（§5.5）
- [x] 附件：粘贴截图 / 拖文件进编辑器存进「附件/」，插相对这篇文档的路径，图片按文档所在文件夹解析显示（§11.4.4）
- [x] 暗色模式全量走查：五个视图 × 各种状态、两个选择器、查找面板、语法全览全文过了一遍；没勾的勾选框 / 任务圈在暗色里看不见，加了 `--color-control-edge`（§9.2）
- [x] 笔记文件夹：「笔记」下的子目录就是文件夹。列表栏就地展开（子文件夹 + 里面笔记的标题）、点进去、面包屑回上层、点标题跳到任意文件夹；拖笔记进文件夹（停在收起的上面自动展开）、「移动到…」；新建 / 改名 / 删除（可撤销）；移动时正文里的相对图片链接跟着改；归档再恢复回原文件夹（技术方案 §5.8、§12.1）
- [ ] ~~独立的设置界面~~ —— 先不做，偏好从命令面板改就行（2026-10-06）
- [x] 空状态插画：没有笔记 / 归档是空的（正文区，带「新建笔记」）、搜不到（列表栏）；线稿用颜色 token 画，暗色自动跟着换
- [x] 体验走查一轮（2026-10-07）：
  - 新建笔记光标直接在标题里；标题里回车 / ↓ 进正文开头，正文第一行 ↑ 回标题（命令面板「新建笔记「…」」直接进正文）
  - `[[` 弹笔记标题补全（`【【` 自动换成 `[[`）；链到还没有的笔记画成虚线，Ctrl+点击就地新建，提示条可撤销
  - 行首 `/`（或 `、`）弹插入菜单：标题、待办、列表、引用、提示块、表格、代码、公式、流程图、分隔线、目录、链接、动态表情；某一天 / 某个周期的文档多一项「模板」；筛选认中文、英文、拼音首字母，右边写着快捷键。笔记空白正文有占位提示（`editor/suggest.ts`、`SuggestMenu.tsx`）
  - 记住上次停在哪：重开应用回到上次的区、那一篇、那个文件夹（`otw.session`）；每篇文档的滚动位置和光标，切回来、重开都回到原处（`lib/viewMemory.ts`，按「视口顶上是哪一行」记，不按 scrollTop）；去掉了写死的种子 id
  - 删除 / 归档 / 恢复正在看的那篇，选中落到列表里的下一篇（没有就上一篇），不再甩回第一篇（`selectNeighbor`）
  - 归档：能直接删（列表行和状态栏都有），归档 / 恢复都有撤销提示条；归档横幅从红色换成中性色
  - 窄窗口：正文区按容器宽度收左右留白、大标题 38 → 30px，日历分段控件换成「日 周 月 年」，标题上方那行日期不再被挤没；导航栏可以收成 64px 的图标栏（左下角按钮或命令面板，记在本机）。收起 / 展开的动画见 `app/navMotion.ts`：排版一帧到位（正文只折一次行），看得见的是导航底板的右边缘在滑、列表栏用 transform 贴着它走、正文那一列 layout 滑到新的居中位置；图标两种宽度下 x 不变，文字只淡入淡出，Logo 收成一个「O」，展开时从写好的那一刻接着走；左下角展开时是一行（主题 / 命令面板 / 收起），收起时先原地错开成三层、再跟着边缘收成一列，展开倒过来（先跟着边缘往右走、再落成一行），逐帧检查过不重叠、不被裁。底板用标准缓入缓出（0.5s），专注模式仍是自己那条前段快的曲线。只让正文那一列（`CenteredColumn`）订阅 navCollapsed —— 以前整个 DocumentView 订阅，长文档切换一下 dev 构建里 68ms、4 倍降速 370ms
  - 笔记排序记在本机；冲突副本在列表里显示原文标题，标签带上时间「冲突副本 · 8月28日 22:10」
  - 日历：当日安排每条右边一个箭头，跳到写着它的那篇那一行；月网格分两种记号：实心墨点 = 写过记录 / 做完过事，空心小圈 = 还有没做完的待办（Rust `calendar_marks`）
  - 扩展页先从导航和命令面板里拿掉（没有运行时，「下载」只是一份清单）；页面代码留着
  - 标题栏：Win+↑、拖到顶上吸附之后最大化图标也跟着对；关闭按钮能点到窗口右上角
  - 状态栏：折行后行首不再挂一个「·」；新笔记不再「创建时间」「上次更新」各写一遍；「保存中…」超过 600ms 才显示；删除按钮有提示
  - 提示条在正文区居中；命令面板也搜日记和目标的正文（Rust `journal_list`）；导航图标：笔记换成本子、今日TODO 换成勾选框；当日安排的勾选动画改用 `usePrefersReducedMotion`
- [x] 新用户的使用指南（2026-10-13）：新仓库里只放「欢迎使用 OnTheWay」（置顶，一张能勾的上手清单）和「语法全览」两篇，原型那套示例笔记 / 归档 / 日记 / 目标去掉了。正文在 `src/content/guide/`，Rust 编进程序（`vault/guide.rs`），浏览器 mock 读同一份。升级时：没改过的直接换成新版（勾过的照勾），改过的在那一篇上出横幅（看差异 / 换成新版，可撤销 / 留着我的），删了不再放回；命令面板「帮助」组的「使用指南」「语法全览」随时打开（删了就重新放一篇）。`guide.test.ts` 把指南里写到的快捷键、命令面板项、`/` 菜单项、双链和代码对一遍，改了代码忘了改指南会挂
- [ ] 性能回归脚本
- [ ] 打包与签名、自动更新：Tauri updater，安装包和 latest.json 放 GitHub Releases + Gitee Releases（国内）；更新说明随安装包带、升级后第一次打开提示一次，不写进仓库。更新签名的私钥要先生成、自己保管（技术方案 §14.4）
  - [x] 应用这一侧（2026-10-13）：`update.rs` 后台查、下载、验签，下好了导航栏同步那一行上面出现「新版本 0.2.0」，点开是新版本卡片（「稍后」/「重启并更新」，没有跳过这个版本）；装之前先存编辑器、推同步、记窗口位置；deb / rpm 只提示、打开下载页；请求走同步的代理。命令面板「检查更新」「这一版的更新说明」。升级后第一次打开弹一次更新说明（`config.json` 的 `lastVersion`，正文是 `src/content/changelog.md`）。版本号只剩 `package.json` 和 `Cargo.toml` 两处，`pnpm bump` 一起改，测试对两处一样。本机用测试密钥 + 本地 latest.json 在真实应用里走过：签名不对的不装、对的下好后卡片弹出、点「重启并更新」交给安装包、进程退出
  - [x] 生成正式的更新签名密钥（2026-10-13）：私钥在 `%USERPROFILE%\.tauri\ontheway.key`（带密码，公钥 ID 9213A3C800A560A8；第一对的密码在 GitHub 上对不上，重新生成过），公钥已填进 `tauri.conf.json` 的 `plugins.updater.pubkey`。私钥和密码另外备份（密码管理器）；`.gitignore` 挡了 `*.key`。PowerShell 里 `-w ~/…` 不展开 `~`，会生成在当前目录下一个叫 `~` 的文件夹里。本机打包要设 `TAURI_SIGNING_PRIVATE_KEY`（私钥内容或文件路径；这一版 CLI 不认 `_PATH`）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。密钥要设密码：PowerShell 里把环境变量设成空串等于删掉，CLI 会卡在问密码
  - [x] 发版 CI（2026-10-13，写好了、还没在 GitHub 上跑过）：`.github/workflows/release.yml`，打 `v*` tag 触发。先 `scripts/release-notes.mjs` 对版本（tag = package.json = Cargo.toml = Cargo.lock）、取 `changelog.md` 最上面那一节（不是这一版就不发），跑类型检查和前端测试；再 Windows / macOS（Apple 芯片、Intel 各一个）/ Linux 并行打包、签名，建草稿 Release，附件里有安装包、`.sig`、`latest.json`。Publish 之后用户才查得到。手动 Run workflow = 试打包，安装包在 Artifacts 里，不建 Release。两个 Secret 已经加了。bundle 目标加了 `app`（macOS 的更新包从 .app 打）
  - [ ] 第一次在 GitHub 上跑：先试打包，看 macOS / Linux 能不能编过（这个项目还没在这两个平台上编过）
    - 第一次试打包（2026-10-13）四个都挂了：Windows / Linux / macOS Apple 芯片编完了，签名时「Wrong password for that key」—— Secret 里的密码和私钥对不上，要重填；macOS Intel 在 Apple 芯片机器上交叉编，找不到 OpenSSL（git2 带进来的 openssl-sys），改成 macOS 上 vendored，CI 加了 otool 检查。Actions 升到 Node 24 的版本（checkout / setup-node v7、pnpm/action-setup v6、tauri-action v1）
  - [x] Gitee 镜像（2026-10-13）：仓库 `hyxzs111111/on-the-way`（公开）。附件不登录能下、单个 ≤ 100 MB、仓库一共 ≤ 1 GB（实测 + 帮助文档）；没有 latest/download，latest.json 放在固定的 `updater` 发行版。`scripts/gitee-release.mjs` + CI 的「同步到 Gitee」，四个打包都成了才镜像、镜像成了才正式发布，只留最近两版。应用的 `endpoints` 改成 Gitee 在前、GitHub 兜底，`update.rs` 一个地址从查到下载验签整条不行就换下一个（本机走过）。下载页（deb / rpm）改成 Gitee 的发行版页。Mac 加了临时签名（`signingIdentity: "-"`）
  - [ ] Secret `GITEE_TOKEN` 加上以后试打包一次（看 Mac 临时签名编不编得过、Gitee 令牌能不能推），再发 0.1.0
  - [ ] 代码签名（Windows Authenticode、macOS 公证），以后再说
- [x] 清理旧代码：没用的依赖（`@dnd-kit/*`、`fractional-indexing`、`marked`、Radix dialog / popover / tooltip，Rust 的 `r2d2`、`rrule`、`chrono-tz`）；旧数据模型留下的字段（笔记的 `icon`、恒为空的 `actionGroup`、任务的 `priority` / `goalId` / `sortKey` / `completedAt`）、没人调的 `note_list`、用不上的 `NoteIcon` 组件；日历当日安排从 `ActionGroup` 简化成 `DayTasks`

---

## P8 多设备同步（内置 git）

设计见技术方案 §5.9。用户不用装 git，整个仓库（含附件）通过 GitHub / Gitee 上的私有仓库自动同步。

**P8.1 引擎**（`sync/repo.rs`，只依赖 git2）✅ 2026-10-07
- [x] 打开 / init / clone 仓库，维护 `.gitignore` / `.gitattributes` 里应用管的那一段（用户自己的行不动），仓库本地关掉 autocrlf
- [x] 提交：按大小过滤（上限由调用方传），已经同步过、后来超限的文件停在旧版本；提交信息先用文件名（`describe`），接上 Vault 后换成文档标题
- [x] fetch → 快进 / 三方合并，冲突策略（本机优先 + 对方版本交回去存副本、一删一改留改过的、附件和同名新文件也一样），合并后返回改动的路径
- [x] push：两种被拒都认（`NotFastForward` 错误 / 回调里的状态）；`unpushed()` 数没推的提交
- [x] 打包零散对象（packbuilder，换掉 Repository 再删旧包：Windows 上映射着删不掉）；只改大小写的改名（Windows 上实测传到另一台设备）
- [x] 单测 13 个：裸仓库当远端、clone 当设备，冲突表逐行测；两段互不相干的历史也能合；连不上算网络错误
- [ ] HTTPS 远端在服务器端拒绝（回调里的状态）、登录失效：本地裸仓库测不到，P8.3 用真实账号验

**P8.2 接入仓库与触发**（`sync/engine.rs`）✅ 2026-10-07
- [x] 同步线程（`SyncHub` 放在 AppState 里）；联网不持 `Mutex<Vault>`，提交 / 合并持锁；合并后 `Vault::absorb_merge` 整库增量扫一遍、发 `vault-changed`；换了仓库线程自己退出
- [x] 冲突副本：`.md` 走 `write_conflict_copy`（列表里认得出原文），附件按原字节另存，以点开头的路径不另存；提示走 `sync-notice` → 提示条
- [x] 触发：文件监听每批戳一下（`watch::start` 多了 `on_batch`）、停笔 1 分钟（最多 10 分钟）、窗口获得焦点、每 10 分钟、关窗口（藏起窗口、最多等 3 秒）、立即同步；断网 1/2/5/10 分钟退避；第一轮等前端 `ready`
- [x] `sync-status-changed` 事件和 `sync_status` / `sync_now` 命令；超限文件每个只提示一次（记在 `.git/ontheway.json`）；仓库体积到 Gitee 400 MB / GitHub 1 GB 提醒；零散对象过千、一天一次打包
- [x] 真实应用验证（临时仓库 + 本机裸仓库当云端）：启动自动同步、两边改同一行 → 冲突副本 + 提示条、关窗口时把最后的改动推上去。修了一个：窗口一建出来就有一次「获得焦点」，第一轮在前端订阅事件之前就跑了，提示丢了
- [x] 「某一天 / 目标」的冲突副本也有冲突横幅（2026-10-07）：两台设备都改了今日TODO 是同步里最常见的冲突，以前副本以「2026-10-07 (冲突 …)」混在全部笔记里，没标签、不能对比、不能替换。`conflict_of` 按名字认原文时不再只认笔记，`Note.conflictOf` 是 `day:日期` / `goal:周期:起点`；前端 `data/conflicts.ts` 认原文，列表标题「10月7日」，横幅按需取原文正文、替换时先取回再写。真实应用里走过一遍：提示条 → 列表里的副本 → 横幅 → 差异 → 用这一版替换 → 跳到今日TODO、副本进回收站、关窗口时推上去

**P8.3 账号与网络**（`sync/provider.rs` / `account.rs` / `secret.rs` / `proxy.rs`）✅ 2026-10-07
- [x] 代理：应用里填的 > 环境变量 > 系统代理（Windows 注册表 / macOS scutil）> 直连；交给 libgit2 和 ureq（真实应用里认出了 Clash 的 127.0.0.1:7897）
- [x] 令牌存钥匙串（keyring-core + windows-native / apple-native 存储，单测用 mock）；同步配置写在 `.git/config`（`ontheway.provider / login / autosync`），登录过的账号记在应用配置里
- [x] GitHub：设备码登录（领码 → 等确认 → 可取消）、列仓库、建私有仓库；令牌快过期或推拉被拒时用刷新令牌续，续不了才是「登录失效」
- [x] Gitee：私人令牌登录（错令牌说「令牌不对」）、列仓库、建私有仓库
- [x] GitHub OAuth App 已注册（2026-10-07），client_id 在 `sync/provider.rs`
- [x] 联网冒烟测试（`#[ignore]`）：领 GitHub 设备码、两家错令牌都是「要登录」
- [ ] **需要你**：用真实账号走一遍 —— GitHub 登录 → 新建仓库 → 第一次推送；另一台电脑（或另一个 `ONTHEWAY_VAULT`）选同一个仓库 → clone → 两边改同一篇；Gitee 同样一遍；8 小时后看令牌续期
- [ ] **需要你**：Gitee 的 OAuth 要先注册「第三方应用」，再用真实账号验证 OAuth 令牌能不能当 git 密码，验证过才做

**P8.4 界面** ✅ 2026-10-07
- [x] 导航栏的同步那一行（导航项下面、左下角那排上面；那排塞不下第四个按钮）：开启同步 / 已同步 · 3 分钟前 / 同步中… / 离线 · N 次改动没推 / 登录失效 / 同步出错
- [x] 同步对话框：选托管方 → 登录 → 新建或选仓库 → 看一眼云端说清楚会发生什么 → 开启；开了之后是状态页（立即同步、断开、重新登录、太大的文件、网络）
- [x] 命令面板：开启同步… / 同步状态…、立即同步；提示条：冲突副本、超限文件、仓库快满
- [x] 真实应用里验证：状态页、立即同步、断开（一轮跑到一半时断开，状态不会被改回「已同步」—— 修了：停掉的同步线程不再发状态）、GitHub 设备码、Gitee 错令牌；浏览器预览里看过亮 / 暗两种配色

**P8.5 第二台设备与边界情况**
- [x] 云端已有内容：clone 到旁边的「OnTheWay (同步)」，走换仓库流程切过去（`switch_vault`，和「更换笔记文件夹」共用）；可选把本机的笔记也合并进去（同名两份都留，`.git` / `.ontheway` 不拷）
- [x] 以前连过同一个云端（断开后重连）：就在原地接上
- [x] 断开同步（.git 留着、账号不退出）；网盘目录检测（OneDrive / iCloud / Dropbox / Google Drive / 坚果云 / 百度网盘），不让开启
- [x] 第一次全量提交提速（2026-10-07）：`SyncRepo::stage_bulk` 在锁外把要进库的小文件（≤ 1 MB，200 个起）成批放进索引 —— 用 status 找文件，8 个线程各自开一个 Repository + 空的内存索引 + mempack，算出对象落成包，libgit2 量好的索引项交回主线程；然后 commit_all 只剩大文件和提交。真实应用（debug 构建）2000 篇 + 附件：锁外 1.4 s，持锁 0.23 s（以前整个提交都持锁，十几秒）；单测里逐个写 13.9 s → 成批 2.0 s

**P8.6 以后**
- [x] 单篇历史版本（2026-10-07，技术方案 §5.9.11）：`sync/history.rs` 从 HEAD 倒着走提交，改过这篇的才算一版；改名、挪文件夹靠属性块 id 认出原来的路径（git2 没有 `--follow`，相似度识别在改名同时大改正文时也会断）。状态栏时钟按钮 / 命令面板「历史版本…」打开对话框：版本列表（时间、哪台设备、当时的标题）、和现在的差异 / 全文、恢复这一版（可撤销）。真实应用里（临时仓库，三次提交含一次改名）走过：列表、当时叫「…」、设备名、差异；改标题 → 两篇里的链接改了 → 撤销
- [ ] 移动端（libgit2 iOS 走 SecureTransport，Android 要带 OpenSSL）

---

## 决策记录

- **文件是真相，SQLite 只是索引**（2026-09-27）：v2.0 的 SQLite 为真相让「一切皆文档」只在界面上成立 —— 数据锁在库里，没法在文件夹里找到一篇笔记、没法用别的编辑器打开、没法放进网盘。现在每篇文档是仓库里的一个 .md；索引存在应用数据目录（不在仓库里：网盘来回拷一个正在写的 SQLite 迟早出冲突），表结构改了升版本号、清空重建，不写迁移。event / review / key_result / tag 这些建了没用的表连同 rrule 一起删掉了（git 历史里有）。
- **任务只有 Markdown 一个来源**：日历「当日安排」来自任何文档里带日期的 `- [ ] … @2026-09-30`，勾选改原文件那一行。独立的 task 表没了。
- **外部改动不静默覆盖**：保存前发现磁盘比索引新、或者外部改动撞上编辑器里没存的修改，都先把磁盘那一版另存成「(冲突 时间)」副本。
- **数据层抽象**：`data/backend.ts`（`Backend` 接口，Tauri IPC / 浏览器 mock 二选一）→ `data/store.ts`（缓存 + 乐观更新）→ `data/adapter.ts`（映射成 `DocumentModel`）。视图只认 adapter 的产物。
- **不用 TanStack Query / Router**：没有路由（五个工作区共用一个视图），乐观更新和失效范围都很小，直接写在 Zustand 里更直白。
- **编辑器换成 CodeMirror 6**：Milkdown 的 AST 互转在真机上表现为输入跳行、内容漂移。CodeMirror 文档就是源文，装饰层只负责「看起来像渲染过」。
- **没有「只读预览模式」**：`renderMarkdown` 只在数据还没到 / 空状态时当占位。技术方案 v1 里「大文档降级为只读」没有做，CodeMirror 按视口渲染，1800 行文档挂载 5ms，不需要。
- **行动项就是 Markdown 的 `- [ ]`**：原来的独立 task 实体 + link 表方案让文档有两个编辑面，已迁回正文。`task` 表现在只服务日历「当日安排」（按 `due_date`）。
- **今日TODO = 今天的 `day_doc`**，未写过时延续最近一天。原来是一篇藏起来的特殊笔记，和日历里的今天是两份数据。
- **内置指南是普通笔记，但由应用管新旧**（2026-10-13）：id 以 `guide-<名字>-` 开头（启动时只读这几篇的文件），属性块里一行 `ontheway-guide: <名字> <应用版本> <指纹>`。指纹按勾选框都没勾算，所以勾清单不算改过；新旧按写它的应用版本认，只升不降；两台设备各自升级写出的字节一样，同步不撞车。改了正文不用改版本号。
- **GOAL 一个周期一篇**，键是 `(horizon, period_start)`，由前端算周期起点、后端校验。「本周目标」是今天所在那一周，不是最新一条。
- **笔记列表只按标题筛**：全文匹配的结果和标题栏对不上，异步回填还会闪一次。全文搜索留给专门的入口。
- **自动保存不重排列表**：每 400ms 刷新 `updatedAt`，按它排序会让正在编辑的笔记当着用户的面往上跳。「按更新时间」排序直接用 store 的顺序，不在 `NotesView` 里再按 `updatedAt` 排。
- **删除 = 挪进回收站 + 6 秒撤销**：不弹确认框（多数删除是有意的），删完底部给「撤销」，走 `note_undelete` 从 `.ontheway/trash/` 挪回原来的位置。回收站 30 天后清掉，没有回收站界面。
- **保存失败的正文留作草稿**：`drafts` 按 `saveKeyOf` 的键存，切走再切回来还在（adapter 优先用它），下一次保存成功就清掉，关窗时编辑器 flush 之后再试一次（`flushDrafts`）。状态栏只显示这一篇自己的保存失败。
- **其它操作失败走 ErrorToast**：置顶 / 归档 / 恢复 / 删除 / 勾选 / 新建 / 加载失败写进 `error`，底部提示条显示；启动加载失败时常驻并带「重试」。保存失败不走这里。
- **同一篇文档的写入排队**（store 里的 `serialized`）：标题和正文两条路保存、各自写整篇，并发时后到的会把另一半覆盖回旧值。
- **迁移期间关外键**：`migrate::run` 事务外关、每次迁移后 `foreign_key_check` 只拦新增的悬空引用，结束再恢复。重建表时开着外键，DROP TABLE 会级联删掉引用它的行。
- **启动一次取全文**：`note_list_full` 每个列表一次往返，不再「摘要列表 + 逐篇 `note_get`」。
- **摘要 / 字数的算法改了要升索引的 `VERSION`**（`vault/index.rs`）：索引整个重建，摘要字数跟着重算。
- **Logo 改成手写 SVG**：九段笔画按书写顺序 `stroke-dashoffset` 描出再收回，`pathLength="1"` 归一化、`currentColor` 跟主题走。原来的 `Brand.png` 是 53760×11528 的巨图，缩到 22px 发糊，已删。减少动效时停在「写完」态。
- **目录树首项固定为「概览」**，五个视图统一；callout 标签进目录树。
- **日历不用 FullCalendar**，自己用 CSS Grid 画；每周自成一个 grid 行，整行高亮用 `inset-0`。
- **`calendarMarked` 一次取 2000–2100**：一个 `Set<string>` 而已，比按月分页省事。
- **扩展页只做目录和导入**，`ExtensionCatalogProvider` 接口留给以后的审核服务；不承诺运行时。
- **文件夹是真目录，不是属性块里的分组**（2026-10-07）：和「文件是真相」一致，资源管理器 / 网盘 / 别的编辑器看到同一套结构。「全部笔记」只列文件夹和没放进文件夹的笔记，不再把所有笔记拍平；就地展开只列标题（300px 的列表栏放不下摘要），要看摘要就点进去。面包屑放在搜索框下面而不是标题上方：顶上 38px 是拖窗口带。
- **同步用内置 libgit2，不调用系统 git**（2026-10-07）：默认用户没装 git。打包 MinGit 在 Windows 上要多带 37 MB，macOS 也没有官方便携版；gitoxide 还不能 push。git2-rs 让可执行文件只多 1.2 MB，HTTPS 走系统 TLS，以后移动端也能用同一套代码。代价是 `pull`、`gc`、代理都要自己补（技术方案 §5.9.2）。
- **同步冲突一律变成冲突副本，本机优先**（2026-10-07）：笔记应用里不能出现 `<<<<<<<` 冲突标记，也不做手动解决冲突的界面。原文留本机的版本，对方的版本存成副本，沿用已有的冲突横幅（查看差异 / 用这一版替换）。一边删一边改时留改过的那版。
- **超过上限的文件不同步，不从索引里删**（2026-10-07）：GitHub 100 MB、Gitee 50 MB（免费版单文件上限，超了整个推送都会被拒）。已经同步过、后来变大的文件停在旧版本：从索引里删掉，等于在别的设备上把它删了。
- **拖动用指针事件自己做**：窗口开着 `dragDropEnabled`（拖文件进来当附件），Windows 上 WebView 里的 HTML5 拖放会被它吃掉。

## 坑记录

**工程**

- `pnpm 10` 拦 postinstall，esbuild 不放行则 vite 起不来。
- `pnpm tauri dev` 会占 1420 端口，和已经在跑的 `pnpm dev` 冲突，先停一个。
- Python 脚本在 Windows 上写文件会把换行转成 CRLF，Biome 会报格式错。批量改文件后跑一次 LF 归一化。
- 这台机器上 `cargo run --example export_bindings` 编得过、跑不起来（`STATUS_ENTRYPOINT_NOT_FOUND`，DLL 加载的问题）；要新的 `bindings.ts` 就启动一次 debug 桌面端。桌面端在 `tauri dev` 里因为改了 Rust 自动重启时，写 `bindings.ts` 可能撞上文件正被占着（Windows 错误 1224「用户映射区域」）直接 panic 退出 —— 再启动一次就好（2026-10-07）。
- **不要跑 `cargo fmt`**：项目的 Rust 代码不是按 rustfmt 默认配置排的（不少行超过 100 列），也没有 `rustfmt.toml`。跑一次会改动整个 crate 二十多个文件，把没提交的改动里也混进一堆换行（2026-10-07 出过一次，靠 Claude Code 的文件快照还原）。
- `cargo test --no-default-features` 会因 `main.rs` 的 `run()` 被 feature 门控而失败，加 `--lib`。
- tauri-specta 三个 crate 的 RC 版本互不兼容，`=` 锁死，不要跟着 `cargo update` 走。
- 无事件时 tauri-specta 生成的辅助代码触发 `noUnusedLocals`，生成文件头加了 `// @ts-nocheck`，biome 也忽略它。

**主题 / 布局**

- Tailwind v4 的 `dark:` 变体需要 `<html>` 上有明确的 `data-theme`，不能只靠 `prefers-color-scheme` —— `index.html` 里有段内联脚本在首帧前落属性。
- 标题栏的 `data-tauri-drag-region` 铺满顶部 38px，这一条内会吞掉滚轮事件。各视图内容都从 42px 以下开始。
- `win_start_dragging` 必须在 mousedown 的同一调用栈里发起 IPC，不能等动态 import。
- Browser 预览面板的截图会滞后于动画，判断渲染问题要用 DOM 测量而不是看截图。

**动效**

- motion 自带的 `useReducedMotion()`：`MotionConfig` 只要设过一次 `reducedMotion="always"`，它之后就一直返回 true 直到刷新。要判断系统偏好用 `lib/motion.ts::usePrefersReducedMotion()`。
- 列表栏不能动画化 `marginLeft`：布局属性，动画期间 flex 行每帧重排，开了 lineWrapping 的 CodeMirror 逐帧折行，头几帧稳定 28ms 一帧。改成挂载即入流、只动 `x`；主内容用 `popLayout` + `anchorX="right"` 把退场屏冻结在原位交叉淡出。
- 中文文字的 `font-weight` 不能做 CSS 过渡：每一帧都是一个新的小数字重，回退字体（YaHei 没有可变轴）每次都要重新匹配，实测一个标签一帧 11ms、拉丁文只要 0.5ms。导航切换时新旧两个标签一起变，就是 22ms 一帧持续 140ms。
- 工作区进场不能带 transform：编辑器不能挂在正在平移的祖先里，否则得先渲染占位再换编辑器，两者排版不同（正文 15px vs 17px/1.4），一换整篇重排。
- `React.lazy + Suspense` 即便 promise 已 resolve，首次渲染也必然先 suspend 一次把 fallback 提交上屏。编辑器组件自己持有解析后的引用，bootstrap 里 await 预载。

**弹出层（Ctrl+E 表情选择器、`/模板`、命令面板）**

- **盖在正文上的浮层不能整块从透明淡入**。用户报「按 Ctrl+E 正文会跳一下」，实机录屏（WebView2 远程调试逐帧记录 150 秒）里正文一个像素都没动过：是面板开在光标上方、前 100ms 半透明，一行行表情格子和底下的正文叠在一起，看着像正文在跳。入场方向要在挂载那一帧就对：面板尺寸是定的，先按常量算好位置，挂上以后再按量到的尺寸校正。
- **盖在正文上的浮层也不能缩放**。上一版「实心卡片 scale 0.97 → 1 + 内容淡入」，用户报「刚打开时字是模糊的，大概 0.1s，然后抖一下才变好」：带字的层一缩放就被当位图拉伸，动画那 ~200ms 字发虚、有重影，结束撤掉 transform 的那一帧重新按原尺寸画，字一下变清楚还挪了一点（1.5 倍屏无头 Chrome，`performance.now` + 文档时间线一起放慢 10 倍逐帧截图，对比最终帧确认）。现在卡片从贴光标的那条边展开 —— 破例动 `height`（fixed 小盒子，内容高度不跟着变，4 倍降速下每帧 3.5–8ms），内容不缩放、不变透明，每一帧露出来的部分和最终画面逐像素一致；往上开的用 `bottom` 定位，钉住贴光标的那条边；收起折回那条边，剩不到 10px 空白边时才淡掉（早淡的话半透明的一条带着搜索栏的字叠在正文上）。位置对齐到物理像素（`pinnedEdge`）。`lib/motion.ts` 的 `popoverCard`，`popupMotion.test.ts` 守着。
- **同类问题全应用排查（2026-10-06）**：同样「先糊、再抖一下」的还有命令面板（scale 0.97）、下拉菜单（CSS scale 0.96 + 上移）、悬停卡片（CSS scale 0.98 + 位移）、撤销 / 出错 / 通知提示条（scale 0.97）、日历「今天」按钮和列表栏标题右侧按钮（scale 0.9）。逐帧看：动画快结束时字已经不动了但还是虚的，最后一帧才跳清楚。只去掉缩放、保留 CSS 位移的菜单照样跳；只动 opacity 的从头到尾和终帧一致。现在命令面板用 `popoverCard` 展开，菜单和悬停卡片只淡入，提示条上滑 + 淡入不缩放（tween），两个按钮只淡入；没用到的 `popIn`（scale 0.97 的浮层预设）删掉了。日历切月的 spring 加了 `restDelta: 0.01`（默认差半个像素就跳到终点）。没问题的：左侧导航按下的 scale（主线程逐帧重画）、表格 / 目录 / 查找面板的上浮 3–4px（同上）、只有图标的缩放。

- 每张**不同的** `data:` SVG 图，Chrome 都要同步建一个隔离的 SVG 文档（trace 里是 `IsolatedSVGDocumentHost`，发生在布局里），再插一次还得再建。表情的静止帧图只适合「同一个表情画很多遍」的正文；选择器里 48 个各不相同，以前每次打开都建 48 个文档 —— 4 倍降速 + 2x 屏上首次 Ctrl+E 卡 0.75–0.94 秒。选择器的格子现在 `mount(host, { image: false })` 用活的 SVG。
- 界面字体里没有的字（↵ ⇧ ↑↓ ⌘ ⏎）第一次画时浏览器要把系统字体挨个找一遍兜底（装的字体越多越慢），只一个 ↵ 在 4 倍降速下就是 100ms。按键提示一律用 lucide 图标，`popupGlyphs.test.ts` 守着。
- 用户的桌面端（WebView2 + dev 构建 + 高分屏）比无头 Chrome 慢好几倍：1 倍速下 100ms 的开销到他那儿接近 1 秒。改了编辑器或弹出层，要在 4 倍 CPU 降速 + 2x 屏下量一遍**已有**弹出层的打开耗时（Chrome trace，不是看截图）。

**同步（P8）**

- Tauri 窗口在 `tauri.conf.json` 里是 `visible: false`，可它一建出来（还藏着、前端还没加载）就会收到一次 `WindowEvent::Focused(true)`。同步拿「获得焦点」当触发，第一轮就在前端订阅事件之前跑完了，冲突副本的提示没人收。现在第一轮之前的焦点不算，第一轮等 `ready`（2026-10-07）。
- libgit2 在 Windows 上走 WinHTTP 的默认代理（`netsh winhttp`），不读 Clash 这类工具设的系统代理；连不上报的错误类别是 `Os`，不是 `Net`。
- git2 0.21 的默认 features 是空的（不带 https）；`Reference::symbolic_target`、`Remote::url` 改成返回 `Result`。
- 设备码登录「等用户确认」那一步只能调一次（后端把这次登录拿走了）。放在 React effect 里会被 StrictMode 跑两次，第二次报「没有正在进行的登录」；现在在点击里发起（`SyncDialog.tsx` 的 `githubLogin`）。
- 断开同步时线程可能正在一轮的半路上，剩下的状态事件会在「已断开」之后到前端，把它改回「已同步」。停掉的线程现在不再往外发状态和提示（`Running.alive`）。
- libgit2 的 mempack 自己的 `dump` 只收**提交**和提交能走到的对象：只放进索引、还没提交时导出来是个 32 字节的空包，`reset` 之后对象就丢了，索引指着不存在的 blob。`stage_bulk` 自己建 packbuilder，按索引项的 id 一个个放进去（2026-10-07）。
- `Index::add_all` 会给每个新文件生成一份 diff（打开、读完、判断是不是二进制）：2000 个新文件、回调全返回「跳过」也要 5 s；`statuses()` 只比 stat，7 ms。要先知道有哪些文件就用 status。
- libgit2 每把一个文件写成 blob 都要从头查一遍属性（`.gitattributes`、info/attributes、全局的……，没有 session 缓存），Windows 上一次约 2 ms，一个文件两次；纯读文件 + 算哈希只要 0.05 ms。慢在等文件系统，不在 CPU：依赖开 -O3 没用，清空系统 / 全局配置的搜索路径也没用，多开线程一起等才有用。
- 想看真实应用里的同步：临时仓库 `git init -b main`，`git config ontheway.autosync true`，远端设成本机的一个裸仓库，用 `ONTHEWAY_VAULT` / `ONTHEWAY_DATA_DIR` 指过去再 `pnpm tauri dev`。

**附件 / 冲突副本 / 反向链接**

- 拖文件进桌面端窗口，WebView 收不到 HTML5 的 drop（`dragDropEnabled` 开着时系统拖放被 Tauri 接走），要听 `getCurrentWebview().onDragDropEvent`：给的是路径和**物理像素**坐标，除以 `devicePixelRatio` 才是页面坐标。没法从自动化里真的从资源管理器拖，验证时用 `plugin:event|emit` 发一个 `tauri://drag-drop` 走同一条路
- 粘贴的图片插进去以后光标要落到下一行：光标挨着图片时图片显示成源码（Typora 式），插完看到的是一串 `![](…)`
- 光标进到链接 / 图片里时 `(…)` 里的地址也是 `.cm-otw-syntax-marker`；它以前是 `white-space: nowrap`，长地址把整栏撑宽、右边的字被裁掉。改成 `overflow-wrap: anywhere`
- 网盘拷出来的副本带着原文属性块里的 id；扫描按字节序，「周报 (1).md」排在「周报.md」前面，先被索引就抢走了原文的 id —— 名字像副本的要排到最后
- `cargo run --example export_bindings` 在这台机器上跑不起来（dialog 插件要的 comctl32 v6 清单示例程序没有，STATUS_ENTRYPOINT_NOT_FOUND）。重新生成 `bindings.ts`：`cargo build` 后用一个临时的 `ONTHEWAY_DATA_DIR` / `ONTHEWAY_VAULT` 直接跑一下 `target/debug/ontheway.exe`（debug 启动时就写绑定，窗口在前端没起来时不会显示），写完杀掉

**CodeMirror**

- **编辑器正文行高是 1.4**：以前 `.cm-editor` 上写着 1.82，但 CodeMirror 自带主题给 `.cm-scroller` 写了 `line-height: 1.4` 把它盖住了，正文从第一版起其实一直是 1.4。2026-10-06 确认保持 1.4，`globals.css` 改成在 `.otw-editor .cm-scroller` 上明写 1.4。17px 字一行只有 23.8px，字体框就占 22px，所以行内带底色的样式上下不能加 padding：`[[双链]]` 小块原来上下各 0.08em，底色冒出这一行 1.36px，把上一行链接的下划线盖掉了（每行 `position: relative`，后面的行整个画在前面的行上面）。`widgetSpacing.test.ts` 守着。
- 块级 widget 的留白只能用 padding，**不能用 margin**：CodeMirror 用 `getBoundingClientRect` 量 widget 高度，margin 不在边框盒里，高度图比真实布局短，点击会定位到错误的行。`widgetSpacing.test.ts` 用正则守着。
- 行内 `<img>` widget 同理：块级子元素的上下 margin 会穿透 `.cm-line` 折叠出去。
- 改变行结构的装饰（折叠整行、块级 widget）必须来自 `StateField`，视口是在 ViewPlugin 更新之前算出来的。
- 空围栏（只有开闭两行）不能折叠，折叠后再也点不进去。
- Setext 下划线只藏 `===` 三个字符会留一条空行，得整行折叠；分隔线同理。
- `<u>` 的源码级配对以前是全文 `indexOf`，两个不相干段落里的 `<u>` 和 `</u>` 会配成一对；现在要求不跨空行。
- 中文正文在 WebView2 里会被拼写检查画满红波浪线，`spellcheck="false"`。
- `scrollHeight` 在滚动过程中会变（未渲染的行只有估算高度，滚过去才回填真实值；400 段文档从 17846 涨到 22286）。自绘滚动条的滑块要指数缓动跟随，不能每帧离散校正。
- 外部回填（store → 编辑器）要用 annotation 标记，否则会被当成用户输入触发一次保存。
- CommonMark 把任何没有定义的 `[文字]` 都解析成 `Link` 节点（短引用形式），`[!NOTE]`、`[TOC]`、`[^1]`、`[[双链]]` 里那层都是它。装饰层必须按内容分流，不能见 Link 就藏括号。
- `HardBreak` 节点的末尾是换行符本身；行内 replace 装饰跨过换行会把两行拼成一行，替换范围必须停在 `to - 1`。
- `LinkReference` 这类顶层节点的父节点是 `Document`，按「父节点是否被光标碰到」判断激活永远为真，只能看节点自己。
- front matter 的 `---` 会被 CommonMark 解析成分隔线 + Setext 标题，两层装饰和目录收集都要先用 `frontMatterRange` 绕开；光标停在 0（新挂载的编辑器）不算点进了属性块，否则每篇一打开就是展开的 YAML。
- 预览面板里 `navigator.clipboard.writeText` 会因权限被拒（真机不会），复制按钮要有 execCommand 退路并吞掉 rejection。
- 用 `::before` 做行首提示（标题的 H2）要给 `width: max-content; white-space: nowrap`，否则 `right: 100%` 的绝对定位伪元素会被压成一列字。

**数据**

- 某天 / 某周期的文档是异步加载的，编辑器往往先以空文档挂载。`saveDocument` 在 `source` 还没回来时**必须直接返回**，否则用户一输入就把原有内容整篇覆盖。adapter 在数据没到时干脆不给 `editor`。
- `foreign_keys` 是连接级 PRAGMA，只在建库时设一次没用（旧库的事，搬家只读拷贝，不用管）。
- 文件改名 / 挪位置后按新路径写入前，索引里得先改路径**并清掉指纹**：标题来自文件名、归档与否来自位置，内容一模一样也得重新解析；不改路径的话旧路径那一行占着同一个 id，新文件会被当成一篇重复的笔记。
- 应用自己写的文件会触发文件监听：靠「写完立刻把修改时间、大小、指纹记进索引」识别，扫描时对得上就不算外部改动、不发通知。
- 外部程序用 CRLF 存过的文件：读进来统一成 `\n`，否则编辑器一打开就当成改过了。
- 编辑器分辨不了「store 里的正文变了」是外部改动还是自己的保存回来了（边打字边保存时两者都是 `当前 ≠ 已同步`）：store 只在外部改动真的改了正文时给 `externalRevisions` 加一，编辑器看这个数有没有变。
- `saveBus` 引用了数据 store，store 要 flush 编辑器时只能动态 `import("@/editor/saveBus")`，静态引入会成环。
- 这台机器的 Git 开了 `core.autocrlf`，工作区里的文件是 CRLF，Biome 按 LF 检查会报格式错；改过的文件存成 LF 即可（提交时本来就是 LF）。
- FTS5 的 `snippet()` / `highlight()` 作用在分词串上，中文会显示成「今天 开会 讨论」；高亮在前端用 `tokens` 做。
- jieba 会把标点单独切出来，进了 FTS5 查询就是 `""""*`，要先过滤掉不含字母数字汉字的 token。
- 延续来的「今天」不落库；跨过零点后缓存里的延续文档要丢掉，否则翻回昨天会把它当成昨天写的。
