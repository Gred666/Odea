/* ============================================================
   每篇文档上次看到哪、光标在哪。

   切到别的文档再切回来、或者关了应用再打开，正文回到上次的位置，光标也在原处
   （以前一律滚回顶部、光标归零：长文写到一半去查个东西，回来得重新找）。

   位置记成「视口顶上是正文的哪一行、往下多少像素」，而不是 scrollTop：
   编辑器没画过的行只有估计高度，同一个 scrollTop 下次打开未必是同一处；
   按行定位交给 CodeMirror 的 scrollIntoView，它在量好之后再滚。
   标题还露在视口里（正文顶端没滚过视口上沿）时记的是 scrollTop —— 上面只有标题，
   高度是确定的。

   键是 store 的 saveKeyOf（`note:…`、`day:…`、`goal:…`）。只留最近的一些，存在本机。
   ============================================================ */

export interface ViewSpot {
  /** 正文顶端还在视口里时的 scrollTop；滚进正文之后是 null，用 pos / offset */
  scrollTop: number | null;
  /** 视口上沿落在正文的哪一行（行首位置） */
  pos: number;
  /** 视口上沿在那一行顶端往下多少像素 */
  offset: number;
  /** 光标位置 */
  head: number;
  /** 收起的标题：第几行（一基）、这一行的原文（editor/headingFold.ts 认回来） */
  folds?: { line: number; text: string }[];
  /** 目录树里收起的条目（components/outlineTree.ts 的键：层级 + 标题字 + 第几个同名的） */
  outline?: string[];
}

const STORAGE_KEY = "odea.view-memory";
const LIMIT = 150;

function load(): Map<string, ViewSpot> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      return new Map(
        raw.filter(
          (entry): entry is [string, ViewSpot] =>
            Array.isArray(entry) &&
            typeof entry[0] === "string" &&
            !!entry[1] &&
            typeof entry[1].pos === "number" &&
            typeof entry[1].head === "number",
        ),
      );
    }
  } catch {
    /* 隐私模式 / 数据损坏：从顶上开始而已 */
  }
  return new Map();
}

const memory = load();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...memory]));
    } catch {
      /* 忽略：只是下次打开回到顶上 */
    }
  }, 800);
}

/** 立刻写进本机（关窗时）：平时攒 800ms 写一次，关窗那一下等不到 */
export function flushViewMemory(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...memory]));
  } catch {
    /* 忽略 */
  }
}

export function spotOf(key: string): ViewSpot | undefined {
  return memory.get(key);
}

/** 记下（或更新一部分）。最近动过的排到最后，超出上限丢最早的 */
export function rememberSpot(key: string, patch: Partial<ViewSpot>): void {
  const previous = memory.get(key) ?? { scrollTop: 0, pos: 0, offset: 0, head: 0 };
  memory.delete(key);
  memory.set(key, { ...previous, ...patch });
  while (memory.size > LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  persist();
}

/** 测试用 */
export function clearViewMemory(): void {
  memory.clear();
}
