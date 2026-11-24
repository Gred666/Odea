# CodeMirror

- **编辑器正文行高是 1.4**：以前 `.cm-editor` 上写着 1.82，但 CodeMirror 自带主题给 `.cm-scroller` 写了 `line-height: 1.4` 把它盖住了，正文从第一版起其实一直是 1.4。2026-10-06 确认保持 1.4，`globals.css` 改成在 `.odea-editor .cm-scroller` 上明写 1.4。17px 字一行只有 23.8px，字体框就占 22px，所以行内带底色的样式上下不能加 padding：`[[双链]]` 小块原来上下各 0.08em，底色冒出这一行 1.36px，把上一行链接的下划线盖掉了（每行 `position: relative`，后面的行整个画在前面的行上面）。`widgetSpacing.test.ts` 守着。
- 块级 widget 的留白只能用 padding，**不能用 margin**：CodeMirror 用 `getBoundingClientRect` 量 widget 高度，margin 不在边框盒里，高度图比真实布局短，点击会定位到错误的行。`widgetSpacing.test.ts` 用正则守着。
- 行内 `<img>` widget 同理：块级子元素的上下 margin 会穿透 `.cm-line` 折叠出去。
- 改变行结构的装饰（折叠整行、块级 widget）必须来自 `StateField`，视口是在 ViewPlugin 更新之前算出来的。
- 空围栏（只有开闭两行）不能折叠，折叠后再也点不进去。
- Setext 下划线只藏 `===` 三个字符会留一条空行，得整行折叠；分隔线同理。
- 收紧 Setext 不能把 lezer 自带的解析器从列表里拿掉：分隔线判断「这行该不该让给 Setext」认的是那个函数本身，拿掉了 `标题\n---` 永远是分隔线。只能留着它、每一段开头把它的那一份换成自己的（`leaf.parsers` 是公开的）；多行段落下面的 `---` 要自己 `finishLeaf` 收尾、这一行不吃掉，下一轮自然是分隔线。
- 组字时别给组字那段字加标记：CodeMirror 保住组字的文本节点，连同包着它的标记一起原样沿用，新加的标记盖不上去（动了 DOM 输入法就断）。行装饰可以 —— 只改行的属性。也别在 compositionstart 里直接改 DOM：那时先只记一笔状态，第一笔 `input.type.compose` 的改动进来时（`transactionExtender`）再加。直接改 `.cm-line` 的 class 也不行，属性变化被观察器标脏，下次同步就被抹掉。
- **组字时的每一次 `docChanged` 里正文都是拼音**：拿正文去做的事（防抖存盘、筛提示列表、搜索）都得等组字结束。存盘的防抖到点时 `view.compositionStarted` 还是真就再等一轮（`debouncedSave.ts` 的 `hold`）——
  以前照存，拼音落盘、回音以后「已存」也是拼音，外面一改文件编辑器就当成没有没存的改动整篇替换，组着的词落到文档开头（2026-11-15，桌面端验证 §3.2）。
  输入框同理：显示的字和拿去筛的字分开，组字时只改前者，`compositionend` 再改后者（命令面板、全局搜索）
- **`window` 上捕获阶段听的快捷键要看 `isComposing`**：CodeMirror 自己的键表组字时不跑，但应用的 Ctrl+Tab、Ctrl+K 这些挂在 `window` 上，组字时照样换篇、开面板，
  焦点一离开正在组字的编辑器，浏览器把组字串当成字留下（2026-11-15，桌面端验证 §3.3）
- **ViewPlugin 的构造函数在一次更新里跑，不能 `dispatch`**（经 `Compartment.reconfigure` 换上的插件也是）。构造时就要改编辑器（协作绑定挂上时对齐会话）：
  先把要改的记成一份 `ChangeSet`，微任务里再派发；这之间要是有本地事务，它的位置是相对没改之前的文档的，写到别处之前得映射过那份改动
  （`collab/binding.ts` 的 `deferred`：正文 = 编辑器 ∘ deferred）。原来在微任务里整篇替换，中间的本地事务就拿编辑器的位置写进了正文（2026-11-15，§27）
- 两份从同一版出发的 `ChangeSet` 互相映射：`a.compose(b.map(a))` 和 `b.compose(a.map(b, true))` 得到一样的文档；落在对方删掉、替换掉的范围里的插入不丢，
  但会被挪到那一段的边上 —— diff 要细到字（一整段的掐头去尾不够，`collab/external.ts::fineEdits`）
- `overflow-x: auto` 隔不断最小宽度：里面是十几列的表，`.cm-content`（flex 子项，`min-width: auto`）照样被撑到表那么宽。要横向滑的块一律加 `contain: inline-size`。
- CodeMirror 会拿同一个 widget 对象再 `toDOM` 一次（滚出视口又滚回来、旁边的块重排），`fresh` 只能管第一次，不然刚打开那篇的替身每滚回来一次就淡入一次。
- `<u>` 的源码级配对以前是全文 `indexOf`，两个不相干段落里的 `<u>` 和 `</u>` 会配成一对；现在要求不跨空行。
- 中文正文在 WebView2 里会被拼写检查画满红波浪线，`spellcheck="false"`。
- `scrollHeight` 在滚动过程中会变（未渲染的行只有估算高度，滚过去才回填真实值；400 段文档从 17846 涨到 22286）。自绘滚动条的滑块要指数缓动跟随，不能每帧离散校正。
- 外部回填（store → 编辑器）要用 annotation 标记，否则会被当成用户输入触发一次保存。
- CommonMark 把任何没有定义的 `[文字]` 都解析成 `Link` 节点（短引用形式），`[!NOTE]`、`[TOC]`、`[^1]`、`[[双链]]` 里那层都是它。装饰层必须按内容分流，不能见 Link 就藏括号。
- `HardBreak` 节点的末尾是换行符本身；行内 replace 装饰跨过换行会把两行拼成一行，替换范围必须停在 `to - 1`。
- `LinkReference` 这类顶层节点的父节点是 `Document`，按「父节点是否被光标碰到」判断激活永远为真，只能看节点自己。
- **单独一段的 `[^1]: 脚注` 被解析成 `LinkReference`**（`^1` 是合法的引用标签），不是 `Paragraph`；接在一段字后面的（不空行）才在段落里。编辑器那边早就分流了（`inlineDecorations.ts` 把它当段落逐行排）；
  静态渲染照编辑器排时把 `LinkReference` 整个丢掉，白板的卡片点进去就多出一行（2026-11-23，`staticHtml.ts` 的 `editorReference`）。按「脚注定义」认东西的地方两种节点都要看
- front matter 的 `---` 会被 CommonMark 解析成分隔线 + Setext 标题，两层装饰和目录收集都要先用 `frontMatterRange` 绕开；光标停在 0（新挂载的编辑器）不算点进了属性块，否则每篇一打开就是展开的 YAML。
- 预览面板里 `navigator.clipboard.writeText` 会因权限被拒（真机不会），复制按钮要有 execCommand 退路并吞掉 rejection。
- 用 `::before` 做行首提示（标题的 H2）要给 `width: max-content; white-space: nowrap`，否则 `right: 100%` 的绝对定位伪元素会被压成一列字。
- **原生选区在一行里字号不一时高低不齐**：浏览器按每段文字自己的字框画底色，小字号的标记底下矮一截。所以选区是自己画的（`selectionLayer.ts`）。CodeMirror 的 `RectangleMarker.forRange` 一行的高度只看选区两端那两个字，两端都落在小标记上时整块也矮，得用 `Range.getClientRects` 补；它量的左右边界跟着视口里**第一行**的 padding 走，引用打头时整片选区都往右缩。
- **widget 加载完变高了要自己 `view.requestMeasure()`**：CodeMirror 的 ResizeObserver 只理会距上次更新 75ms 以后的尺寸变化。刚粘贴的截图几十毫秒就加载完，光标、高度图都停在图片没高度的时候（光标画在图片中间）。图片、块级 HTML 里的图、mermaid 都这么做了，以后异步出内容的 widget 照办。
- 列表项后面只有缩进的空白行不属于语法树里的任何一项；行首一个列表项的 `resolveInner(行尾, 1)` 在文末会落到 `Document` 上，找「光标在哪一项」时行尾要往左找（`resolveInner(pos, -1)`）。
- 有序列表 `1. ` 下面要缩进三个空格才是子项（正文那一栏），两个空格还是同一级。CodeMirror 自带的缩进一律加 indentUnit（两个空格），在列表里用不得。
- **替身的身份（`eq`）里带着跟光标走的状态（`open`：光标在不在这一行）就要写 `updateDOM`**：不写的话光标一进一出 `eq` 是 false，整张 DOM 重画。`![[录音.m4a]]` 的卡片里正在放的音视频断了、从头来；`![[笔记]]` 的卡片正文是异步排的，新卡片先只有标题那一条、下一轮才长回去，展开的 callout 也收回去了（2026-11-14，审查 §4.16、§4.17）。做法：DOM 是照哪个替身画的记在一张 `WeakMap` 里，`updateDOM` 里除了那个状态别的都一样就只换类名、返回 true（`attachmentEmbed.ts`、`embed.ts`；图片替身一直是这么做的）。另外：替身滚出视口约 1000px 以外 DOM 就拆了，里面的 `<audio>` / `<video>` 从文档里拿掉会被内核暂停，这个 `updateDOM` 管不了 —— 由 `mediaKeeper.ts` 管（下一条，`技术方案.md` §11.4.6）。
- **替身里有不能断的东西（正在放的 `<audio>` / `<video>`），挪进挪出都得在 CodeMirror 的同一个任务里**：内核在「从文档里拿下来以后的下一个任务」查一遍，还不在文档里的就暂停；同一个任务里、微任务里接回去不停，`setTimeout(0)`、下一帧才接回去就停了。正好够用的是 CodeMirror 的时序：`destroy(dom)` 调的那一刻旧 DOM 还在文档里（先 `builder.run` 建新的、再拆旧的、最后才 `sync` 动 DOM）；`toDOM` 返回的新 DOM 那时还没挂上，同一个任务里就挂上；整张重画（`updateDOM` 返回 false）是先 `toDOM(新)`、后 `destroy(旧)`。另外 `view.destroy()` 先拆插件、后拆替身：替身的 `destroy` 里 `view.plugin(...)` 已经拿不到了，`destroy(dom)` 也不给 view —— 要找回管它的插件，`toDOM` 时自己按 DOM 记一份（2026-11-15）
- **「本地有没有没存的字」不能只拿 `现在的正文 !== 上次和 store 对上的那一版` 判断**：存盘还在路上时把刚打的字删了（撤销了），正文正好等于上次对上的那一版，存盘的回音（store 换成刚存的那一版）一到就被当成别处来的新正文整篇换上 —— 删掉的字回来、光标跳走。要认得自己的回音：交给 `onSave` 的每一版记下来，`initialMarkdown` 换成其中一版、又不是外部改动时只记「对上了」，正文不动（`editor/liveTwins.ts` 的 `noteSent` / `confirmSent`，开着这一篇的每一处一份，后挂上的抄先挂着的；白板视图也是其中一处）（2026-11-14，审查 §4.32）。
- **回车在 Markdown 里照抄上一行的缩进**（`insertNewlineAndIndent`：Markdown 没有缩进规则时退回照抄；代码块里按代码的语言缩进）。手打的收尾 ```` ``` ```` 跟着代码的缩进打出来，缩进到 4 格它就不算收尾（CommonMark 最多 3 格），后面的正文全成了代码；2 格收得住，但收尾那一行回车又把 2 格带到代码块后面的正文里。`markdownCommands.ts` 的 `closeFenceOnInput`（打完收尾那道围栏时挪回开头那道的缩进）和 `newlineAfterFence`（收尾那一行回车用开头那道的缩进）只管顶层的代码块，列表、引用里的交给 lang-markdown 的续行（2026-11-14，审查 §4.42）。
- **GFM 的表格要到空行才结束**：紧贴着表格的那一行打的字就是表格的一行（下面紧跟的那段字也一起被带进去），表格替身当场变回源码（光标进了表格）。插表、粘贴表、从表格里走出来，光标都别落在紧贴着的那一行（`tableClipboard.ts::spotBelowTable`）；方向键、Esc 走出来不为留空行改正文，回车走出来补（回车本来就是换行）。
  在那一行放进内容时补空行（`tableGap.ts`，`表格.md` §13）：打字、粘贴在同一个事务里补（`transactionFilter`）；**组字不能这么补** —— 同一个事务里改了组字那一行前面的字，组字的文本节点换了行，输入法就断。组字期间正文不动，装饰层把这一行从表格里截出去（`tableCut`），组完再补。
  Lezer 的懒续行：引用里的表格下面一个不带 `>` 的行、列表项里的表格下面一个没缩进的行照样并进表格，判断「紧贴表格」不能要求 `>`、缩进和表格一样（2026-11-14 审查 §4.43、§5.10；2026-11-16 做了）
- **`compositionend` 里不能直接派发事务**：CodeMirror 自己的 `compositionend` 观察者排在插件的后面跑，DOM 里还有没读进来的组字改动时它排一个微任务去读；在这之前派发，没读进来的 DOM 改动被丢掉（吞字）。
  要在组字结束后改正文就在 `compositionend` 里排两拍微任务（排在它后面），另外每次更新里看到「有事要做、`view.compositionStarted` 是假」也排一拍（最后那次组字改动在 `compositionend` 之后才读进来的时候）。
  这样改正文和上屏在同一个任务里，推迟存盘、协作放行攒着的更新都在这之后；Chrome 失焦时先发 `compositionend` 再发 `blur`。补的那一下标 `userEvent: "input.type.compose"`，history 把它并进上屏那一步，撤销一次连字带补的一起回去（`tableGap.ts::gapSettler`，2026-11-16）
- **`transactionFilter` 里要追加改动，返回 `[{ changes: 追加的 }, tr]`，追加的排在前面**：合并时后一份映射过前一份，同一处的插入后一份落在后面 —— 在空行前面补一份它自己，打的字就落在补出来的空行之后（`tableGap.ts::tableGapFilter`）。只认 `input`（不含 `input.type.compose`）和 `move.drop`：协作里对方的改动、外部改动、撤销都不带这些 userEvent，不会被重复补
- **`ChangeSet.touchesRange(from, to)` 的 `"cover"` 要改动严格地包住这一段**（源码：`pos < from && end > to`）：从 `from` 正好开始、或者正好到 `to` 结束的删除只算 `true`。
  拿它判断「这一行整个被删掉了」，文首那一行在全选删除、全选粘贴时就被当成「改了一半」（白板的标记打头，全选粘贴被整个拦下，2026-11-19）。自己比：`fromA <= from && toA >= to && toA > fromA`（`hiddenLines.ts` 的 `damages`）
- **`state.replaceSelection(…)` 不带 userEvent**：按 `isUserEvent("input")` / `("delete")` 拦改动的 `transactionFilter`，测试里拿它当「打字」「删选区」就根本没走到 —— 上一条的问题就是这么漏过去的。
  测试里照真的那样带上：打字 `input.type`、删选区 `delete.selection`、粘贴 `input.paste`
- **编辑器头一次构建的替身全算「新内容」、都淡入**（`decorationKit.ts` 的 `freshness(null)`）。旁边已经画着同样东西的地方（白板的静态卡片点进去换成编辑器）一挂上圆点、勾选框、代码块的封口就闪一下：
  这种宿主给 `quietOpen.of(true)`（2026-11-22）
- **自绘的光标出来时有一下「落下」的动画（`scale: 1 0.4` 长回 1）**：这期间量 `.odea-caret` 的框，中心是偏的，像是光标在滑 —— 量光标位置等 0.5 秒。
  另外 `view.posAtCoords` 会先把排版同步量一遍（`readMeasured`），图层在这一刻按当时的选区画一次；要在挂上的那一刻按点击的位置放光标，用浏览器的 `caretPositionFromPoint` 加 `view.posAtDOM`，不触发量（白板 `board.ts` 的 `placeCaret`）
