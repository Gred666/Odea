import {
  Decoration,
  type DecorationSet,
  type EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/* ============================================================
   很长、中间没有断点的西文串（网址、哈希、一直按着的 kkkk……）：允许在串里任意处断行。

   正文两端对齐（docs/排版规范.md §2）。浏览器遇到这种串，会先在它前面（汉字和西文之间）
   折行、把整串挪到下一行，串太长再在里面断 —— 前一行只剩几个字，却要撑满整行宽，
   字和字之间拉开一大截（2026-10-18 协作实测时在一句话后面一直按 k 撞上的）。
   串里能断以后，行尾就地断开，前一行照常排满。普通单词到不了这个长度，照旧整词折行。
   ============================================================ */

/** 多长算「很长」：比正常的英文单词都长（internationalization 是 20 个字母） */
const MIN_RUN = 24;

/** 不是空白、不是汉字 / 假名 / 谚文 / 全角符号的一串（中日韩文字之间本来就能断） */
const LONG_RUN = new RegExp(
  `[^\\s\\u2E80-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF]{${MIN_RUN},}`,
  "g",
);

const mark = Decoration.mark({ class: "cm-odea-long-run" });
const matcher = new MatchDecorator({ regexp: LONG_RUN, decoration: () => mark });

/** 只算视口里的（MatchDecorator 自己管增量） */
export const longRuns = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = matcher.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = matcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
