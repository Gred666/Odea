/* ============================================================
   命令面板（components/CommandPalette.tsx）的搜索：给一条候选打分、标出命中的字。

   - 连续命中（「主题」→「主题跟随系统」）分最高，开头命中再加分
   - 空格隔开的几个词都要出现（「切换 暗」→「切换到暗色」）
   - 按顺序跳着命中（「主跟」→「主题跟随系统」）分低一点，而且字不能隔得太远 ——
     两个字的关键词在一长串里各找一个字，十有八九是巧合
   - 别名（keywords）只算命中、不标字：「深色」「dark」都能找到「切换到暗色」
   - 正文命中：截出命中的那一行、前后留一截，供面板在标题下面显示一行
   ============================================================ */

export type Range = [number, number];

export interface Match {
  score: number;
  /** label 里命中的字（[起, 止)），按位置排好、不重叠 */
  ranges: Range[];
}

/** 给 text 打分；没命中返回 null */
export function matchText(text: string, query: string): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const t = text.toLowerCase();

  const at = t.indexOf(q);
  if (at >= 0) {
    const whole = t.length === q.length ? 20 : 0;
    return {
      score: (at === 0 ? 100 : 80) - Math.min(at, 30) * 0.5 + whole,
      ranges: [[at, at + q.length]],
    };
  }

  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const ranges: Range[] = [];
    for (const word of words) {
      const hit = t.indexOf(word);
      if (hit < 0) return null;
      ranges.push([hit, hit + word.length]);
    }
    return { score: 60, ranges: merge(ranges) };
  }

  if (q.length < 2) return null;
  const ranges: Range[] = [];
  let from = 0;
  for (const char of q) {
    const hit = t.indexOf(char, from);
    if (hit < 0) return null;
    ranges.push([hit, hit + char.length]);
    from = hit + char.length;
  }
  const spread = ranges[ranges.length - 1]![1] - ranges[0]![0];
  if (spread > q.length * 3) return null;
  return { score: 40 - (spread - q.length) * 2 - ranges[0]![0] * 0.2, ranges: merge(ranges) };
}

/** 别名里有没有命中（只要连续出现就算） */
export function matchKeywords(keywords: string | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q || !keywords) return false;
  const k = keywords.toLowerCase();
  return q.split(/\s+/).every((word) => k.includes(word));
}

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([range[0], range[1]]);
  }
  return out;
}

/**
 * 正文的小写，按那一篇（对象）记着。命令面板、归档的搜索框每打一个字都要在所有正文里找一遍，
 * 以前每次都把全部正文重新转一遍小写（几百篇就是每个字复制一两 MB）；
 * 一篇改过之后 store 里换成新对象，自然重新算
 */
const loweredContent = new WeakMap<object, string>();

export function lowerContent(doc: { contentMd: string }): string {
  let lower = loweredContent.get(doc);
  if (lower === undefined) {
    lower = doc.contentMd.toLowerCase();
    loweredContent.set(doc, lower);
  }
  return lower;
}

/** 行首的 Markdown 记号：标题井号、引用、列表、任务框、编号 */
const LINE_MARKERS = /^\s*(?:(?:#{1,6}|>+)\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/;

/**
 * 正文里第一次出现 query 的那一行，截成一小段：命中处前面留 before 个字，总长不超过 max。
 * 行首的 Markdown 记号去掉；截掉的地方补省略号。没出现返回 null。
 * lower 是调用方缓存着的 content.toLowerCase()：面板每打一个字要搜遍所有正文，不用每次都转
 */
export function snippetAround(
  content: string,
  query: string,
  { before = 14, max = 48 }: { before?: number; max?: number } = {},
  lower = content.toLowerCase(),
): { text: string; range: Range } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const at = lower.indexOf(q);
  if (at < 0) return null;

  const lineStart = content.lastIndexOf("\n", at - 1) + 1;
  const lineEndAt = content.indexOf("\n", at);
  const lineEnd = lineEndAt < 0 ? content.length : lineEndAt;
  let line = content.slice(lineStart, lineEnd);
  let offset = at - lineStart;
  const lead = line.match(LINE_MARKERS)?.[0].length ?? 0;
  if (offset >= lead) {
    line = line.slice(lead);
    offset -= lead;
  }

  const start = Math.max(0, offset - before);
  const end = Math.min(line.length, start + Math.max(max, q.length + before));
  let text = line.slice(start, end);
  let from = offset - start;
  if (start > 0) {
    text = `…${text}`;
    from += 1;
  }
  if (end < line.length) text += "…";
  return { text, range: [from, from + q.length] };
}
