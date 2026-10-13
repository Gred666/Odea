// 给浏览器 mock 后端造一个「用了半年」的仓库：几百篇笔记（一成是长文）、几个文件夹、
// 归档、三个月的日记，外加 docs/语法全览.md 当压力测试长文。随机数固定种子，每次一样
import fs from "node:fs";

const STRESS_DOC = new URL("../../docs/语法全览.md", import.meta.url);
export const STRESS_ID = "n-stress";

const WORDS = (
  "今天 我们 讨论 了 项目 进度 需要 把 这个 问题 拆开 看 设计 方案 还 有 一些 细节 没 想清楚 用户 " +
  "反馈 说 打开 速度 有点 慢 下周 之前 要 完成 第一版 读书 笔记 关于 时间 管理 的 几个 想法 记录 " +
  "一下 明天 再 整理 会议 结论 是 先 做 最小 可用 的 版本 然后 再 迭代 性能 优化 交互 动效 文档 " +
  "测试 发布 复盘 计划 目标 习惯 健身 跑步 三公里 晚饭 后 散步"
).split(" ");
const FOLDERS = [
  "工作",
  "工作/周报",
  "工作/会议",
  "读书",
  "生活",
  "项目",
  "项目/OnTheWay",
  "项目/旧项目",
  "灵感",
];
/** 笔记会放进这些文件夹（三成直接放在「笔记」下面） */
const NOTE_FOLDERS = FOLDERS.filter((folder) => folder !== "项目");

export function buildState(count = 400) {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const sentence = () => {
    let text = "";
    for (let i = 8 + Math.floor(rand() * 30); i > 0; i--) text += pick(WORDS);
    return `${text}${pick(["。", "，然后", "！", "？", "。"])}`;
  };
  const paragraph = () => Array.from({ length: 2 + Math.floor(rand() * 5) }, sentence).join("");
  const list = (task) =>
    Array.from({ length: 3 + Math.floor(rand() * 4) }, () =>
      task ? `- [${rand() < 0.4 ? "x" : " "}] ${sentence()}` : `- ${sentence()}`,
    ).join("\n");

  const titles = Array.from(
    { length: count },
    (_, i) => `${pick(WORDS)}${pick(WORDS)}${pick(WORDS)} ${i + 1}`,
  );
  const body = (size) => {
    const blocks = [];
    let length = 0;
    let section = 1;
    while (length < size) {
      const r = rand();
      const block =
        r < 0.12
          ? `## 第${section++}部分 ${pick(WORDS)}${pick(WORDS)}`
          : r < 0.2
            ? `### ${pick(WORDS)}${pick(WORDS)}${pick(WORDS)}`
            : r < 0.32
              ? list(false)
              : r < 0.4
                ? list(true)
                : r < 0.44
                  ? `> ${paragraph()}`
                  : r < 0.47
                    ? `\`\`\`ts\nconst x = ${Math.floor(rand() * 100)};\nfunction f(a: number) {\n  return a * x;\n}\n\`\`\``
                    : r < 0.49
                      ? `| 项目 | 状态 | 数量 |\n| --- | --- | ---: |\n| ${pick(WORDS)} | 进行中 | 12 |\n| ${pick(WORDS)} | 完成 | 3 |`
                      : r < 0.53
                        ? `相关：[[${pick(titles)}]]，${sentence()}`
                        : paragraph();
      blocks.push(block);
      length += block.length;
    }
    return blocks.join("\n\n");
  };
  const note = (fields) => ({
    isPinned: false,
    isArchived: false,
    archiveCategory: null,
    archivedAt: null,
    conflictOf: null,
    ...fields,
    excerpt: fields.contentMd.replace(/[#*>`|\-[\]]/g, "").slice(0, 60),
    wordCount: fields.contentMd.length,
  });

  const now = Date.now();
  const notes = titles.map((title, i) => {
    const contentMd = body(rand() < 0.1 ? 5000 + rand() * 10000 : 300 + rand() * 2500);
    const folder = rand() < 0.3 ? "" : pick(NOTE_FOLDERS);
    const updatedAt = now - Math.floor(rand() * 180 * 86400000);
    return note({
      id: `n-${i.toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`,
      title,
      contentMd,
      isPinned: i < 3,
      createdAt: updatedAt - 86400000,
      updatedAt,
      relPath: `笔记/${folder ? `${folder}/` : ""}${title}.md`,
    });
  });
  notes.push(
    note({
      id: STRESS_ID,
      title: "语法全览压力测试",
      contentMd: fs.readFileSync(STRESS_DOC, "utf8"),
      createdAt: now - 1000,
      updatedAt: now,
      relPath: "笔记/语法全览压力测试.md",
    }),
  );
  for (let i = 0; i < 40; i++) {
    notes.push(
      note({
        id: `a-${i}`,
        title: `归档 ${pick(WORDS)}${pick(WORDS)} ${i}`,
        contentMd: body(800),
        isArchived: true,
        archiveCategory: pick(["完成", "放弃", null]),
        archivedAt: now - i * 86400000,
        createdAt: now - (i + 30) * 86400000,
        updatedAt: now - i * 86400000,
        relPath: `归档/归档 ${i}.md`,
      }),
    );
  }
  const days = {};
  for (let d = 1; d <= 90; d++) {
    const date = new Date(now - d * 86400000).toISOString().slice(0, 10);
    days[date] = { title: "", noteMd: body(600), updatedAt: now - d * 86400000 };
  }
  return { notes, tasks: {}, days, goals: {}, folders: FOLDERS };
}
