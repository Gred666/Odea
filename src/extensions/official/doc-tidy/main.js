/*
  文档整理：Odea 官方的带脚本插件（L1），也是插件接口的示例（docs/插件与跨端.md §15）。

  跑在沙箱里的 Worker 中，只看得到全局的 odea（src/plugins/sandbox/worker.ts）。
  正文后面列出这篇可以整理的地方：行尾多余的空格、连着的空行、跳级的标题，点一下改好。
  没什么可整理的时候那一段不出现。代码块、属性块里的不动；行尾正好两个空格是 Markdown 的换行，也不动。

  改正文走两步：先拿到正文和修订号，再照着那一版交改动。中间用户又打了字，宿主能挪就挪，
  挪不了回 stale —— 那就重新读一遍再来一次。
*/

/** 一篇正文里可以整理的地方。行号从 1 开始，from / to 是正文里的位置 */
function analyze(text) {
  const lines = text.split("\n");
  const trailing = [];
  const blanks = [];
  const headings = [];
  let offset = 0;
  let fence = null;
  let frontMatter = lines[0] === "---";
  let blankRun = 0;
  let lastHeading = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const start = offset;
    offset += line.length + 1;
    // 属性块：开头的 --- 到下一个 ---
    if (frontMatter) {
      if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontMatter = false;
      continue;
    }
    // 代码块：``` 或 ~~~ 开头，同一种、不短于开头的收尾
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      blankRun = 0;
      continue;
    }
    const blank = line.trim() === "";
    if (blank) {
      blankRun += 1;
      // 连着的第二个空行起：整行删掉（含换行）
      if (blankRun >= 2 && index < lines.length - 1) {
        blanks.push({ line: index + 1, from: start, to: start + line.length + 1 });
        continue;
      }
    } else {
      blankRun = 0;
    }
    const space = /[ \t]+$/.exec(line);
    // 正好两个空格结尾是 Markdown 的换行，留着
    if (space && !(space[0] === "  " && !blank)) {
      trailing.push({ line: index + 1, from: start + space.index, to: start + line.length });
    }
    const heading = /^(#{1,6})(?=[ \t]|$)/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (lastHeading && level > lastHeading + 1) {
        headings.push({
          line: index + 1,
          from: start,
          to: start + level,
          level,
          want: lastHeading + 1,
          text: line.slice(level).trim(),
        });
      }
      lastHeading = level;
    }
  }
  return { trailing, blanks, headings };
}

/** 照着一份分析交的改动：按位置从前往后，不重叠 */
function changesFor(found, kind) {
  const remove = (range) => ({ from: range.from, to: range.to, insert: "" });
  if (kind === "trailing") return found.trailing.map(remove);
  if (kind === "blank") return found.blanks.map(remove);
  // 全部：删掉的空行里的空格不用再单独删
  const inBlank = (range) =>
    found.blanks.some((blank) => blank.from <= range.from && range.to <= blank.to);
  return [
    ...found.blanks.map(remove),
    ...found.trailing.filter((range) => !inBlank(range)).map(remove),
  ]
    .concat(
      found.headings.map((heading) => ({
        from: heading.from,
        to: heading.to,
        insert: "#".repeat(heading.want),
      })),
    )
    .sort((a, b) => a.from - b.from);
}

function summary(found) {
  return [
    found.trailing.length ? `${found.trailing.length} 行行尾有空格` : "",
    found.blanks.length ? `${found.blanks.length} 个多余的空行` : "",
    found.headings.length ? `${found.headings.length} 个标题跳了级` : "",
  ].filter(Boolean);
}

/** 读正在改的那一篇、算出改动、交上去；中间被改过（stale）就重读再来，最多三次 */
async function tidy(ref, plan) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const doc = await odea.documents.read(ref);
    const changes = plan(analyze(doc.text));
    if (!changes.length) return 0;
    try {
      await odea.documents.edit(ref, doc.revision, changes);
      return changes.length;
    } catch (error) {
      if (error.code !== "stale") throw error;
    }
  }
  throw new Error("这篇一直在变，过一会儿再整理");
}

odea.slots.register("tidy", {
  render(doc) {
    if (typeof doc.text !== "string") return null;
    const found = analyze(doc.text);
    const parts = summary(found);
    if (!parts.length) return null;
    const children = [{ type: "text", text: `这篇有 ${parts.join("、")}。`, tone: "muted" }];
    if (found.headings.length) {
      children.push({
        type: "list",
        items: found.headings.slice(0, 20).map((heading) => ({
          id: `h${heading.line}`,
          title: `第 ${heading.line} 行：${heading.text || "（空标题）"}`,
          description: `前面是 ${heading.want - 1} 级标题，这里直接用了 ${heading.level} 级`,
          icon: "list",
          actions: [{ action: "heading", label: `改成 ${heading.want} 级`, value: heading.line }],
        })),
      });
    }
    const buttons = [];
    if (found.trailing.length) buttons.push({ action: "trailing", label: "去掉行尾空格" });
    if (found.blanks.length) buttons.push({ action: "blank", label: "合并空行" });
    buttons.push({ action: "all", label: "全部整理", primary: true });
    children.push({ type: "buttons", buttons });
    return { type: "stack", children };
  },
  async onAction({ action, value, doc }) {
    if (action === "heading") {
      await tidy(doc.ref, (found) =>
        found.headings
          .filter((heading) => heading.line === value)
          .map((heading) => ({
            from: heading.from,
            to: heading.to,
            insert: "#".repeat(heading.want),
          })),
      );
      return;
    }
    await tidy(doc.ref, (found) => changesFor(found, action));
  },
});

odea.commands.register("tidy.all", async () => {
  const doc = await odea.documents.current();
  if (!doc) {
    await odea.ui.notify("先打开一篇文档");
    return;
  }
  const count = await tidy(doc.ref, (found) => changesFor(found, "all"));
  await odea.ui.notify(
    count ? `「${doc.title}」整理好了，改了 ${count} 处` : `「${doc.title}」已经很整齐了`,
  );
});

// 单测（src/extensions/official/docTidy.test.ts）直接拿这两个函数测
if (typeof self !== "undefined") self.__docTidy = { analyze, changesFor };
