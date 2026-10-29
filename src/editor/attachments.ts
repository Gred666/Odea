import type { Attachment } from "@/data/types";
import { winOf } from "@/lib/paneWindow";
import { isTauri } from "@/lib/tauri";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { listItemContentColumn } from "./markdownCommands";

/* ============================================================
   把文件放进正文：粘贴截图、拖进图片。

   文件存进仓库的「附件」文件夹（上层的 onAttachFiles / onAttachPaths 去调后端），
   拿回相对这篇文档的路径，在光标 / 松手的位置插 `![名字](../附件/名字.png)`；
   不是图片的插普通链接。

   拖放有两条路：
   - 浏览器里（预览）是 HTML5 的 drop 事件，拿到的是 File；
   - 桌面端窗口开着 dragDropEnabled，系统拖进来的文件 WebView 收不到 drop 事件，
     Tauri 另发 drag-drop 事件，给的是文件路径和窗口坐标（物理像素）。
   拖到编辑器上方时画一条竖线，标出会插在哪。
   ============================================================ */

export interface AttachHooks {
  files: (files: File[]) => Promise<Attachment[]>;
  paths?: (paths: string[]) => Promise<Attachment[]>;
}

/** 剪贴板 / 拖放里的文件。剪贴板里同时有文字的（从 Excel 复制单元格会附带一张截图）按文字粘贴 */
function filesOf(data: DataTransfer | null, preferText: boolean): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (!files.length) return [];
  if (preferText && data.getData("text/plain").trim()) return [];
  return files;
}

/** 插进正文的那一段：图片是 `![名字](路径)`，别的文件是 `[名字](路径)` */
export function attachmentMarkdown(attachments: Attachment[]): string {
  return attachments
    .map((item) => {
      const label = item.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
      return item.isImage ? `![${label}](${item.link})` : `[${label}](${item.link})`;
    })
    .join("\n");
}

/**
 * pos 在列表项里时，这一项正文那一栏在源码里的列（`1. ` 后面是 3）；不在列表里是 0。
 * 插进去的几行都缩进到这一列，才留在这一项里、和这一项的字对齐 —— 以前顶格插进去，
 * 图片成了这一项的「懒惰续行」，下一行的光标却已经出了列表。
 */
export function listContentIndent(state: EditorState, pos: number): number {
  // 只有空格的一行（上一次插完图光标落下的那一行）不在语法树的列表项里：看上一行，
  // 取缩进放得下的最里面那一项
  const here = state.doc.lineAt(pos);
  const blank = !here.text.trim();
  const probe = blank && here.number > 1 ? state.doc.line(here.number - 1).to : pos;
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(probe, -1);
    node;
    node = node.parent
  ) {
    if (node.name !== "ListItem") continue;
    const indent = listItemContentColumn(state, node);
    if (!blank || indent <= here.length) return indent;
  }
  return 0;
}

/**
 * 在 pos 插进去的那一段。图片自己占一行，光标落到下一行开头：光标挨着图片时显示的是源码，
 * 插完就该直接看到图。插在一行中间就把这一行从这里断开，后半截留在下一行。
 * 列表项里每一行都缩进到这一项的正文那一栏。
 */
export function attachmentInsert(
  state: EditorState,
  pos: number,
  attachments: Attachment[],
): string {
  const indent = " ".repeat(listContentIndent(state, pos));
  const prefix = state.sliceDoc(state.doc.lineAt(pos).from, pos);
  // 光标前面正好是这一栏的缩进（上一张图插完落下的那一行）：就从这里接着插
  const before = prefix === indent ? "" : prefix ? `\n${indent}` : indent;
  const body = attachmentMarkdown(attachments).replace(/\n/g, `\n${indent}`);
  return `${before}${body}\n${indent}`;
}

/** 存好以后插进去。存的这一会儿正文变了（继续打字）就插在当时的光标处 */
async function insertWhenSaved(view: EditorView, at: number, pending: Promise<Attachment[]>) {
  const doc = view.state.doc;
  const attachments = await pending;
  if (!attachments.length || !view.dom.isConnected) return;
  const pos = view.state.doc === doc ? at : view.state.selection.main.head;
  const insert = attachmentInsert(view.state, pos, attachments);
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  view.focus();
}

/* ---------------- 拖放时的插入位置 ---------------- */

const setDropPos = StateEffect.define<number | null>();

class DropCaret extends WidgetType {
  toDOM() {
    const node = document.createElement("span");
    node.className = "cm-odea-drop-caret";
    node.setAttribute("aria-hidden", "true");
    return node;
  }
  ignoreEvent() {
    return true;
  }
}

const dropCaret = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setDropPos)) continue;
      next =
        effect.value === null
          ? Decoration.none
          : Decoration.set([
              Decoration.widget({ widget: new DropCaret(), side: 1 }).range(effect.value),
            ]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function showDropAt(view: EditorView, pos: number | null) {
  const current = view.state.field(dropCaret, false);
  if (pos === null && (!current || current.size === 0)) return;
  view.dispatch({ effects: setDropPos.of(pos) });
}

/* ---------------- 扩展 ---------------- */

/** 粘贴 / 浏览器里的拖放。hooks 是现取的：编辑器复用缓存状态时换的是这一截 */
export function attachmentHandlers(hooks: () => AttachHooks | null): Extension {
  return [
    dropCaret,
    EditorView.domEventHandlers({
      paste(event, view) {
        const attach = hooks();
        const files = filesOf(event.clipboardData, true);
        if (!attach || !files.length) return false;
        event.preventDefault();
        const range = view.state.selection.main;
        if (!range.empty) view.dispatch({ changes: { from: range.from, to: range.to } });
        void insertWhenSaved(view, view.state.selection.main.head, attach.files(files));
        return true;
      },
      dragover(event, view) {
        if (!hooks() || !event.dataTransfer?.types.includes("Files")) return false;
        event.preventDefault();
        showDropAt(view, view.posAtCoords({ x: event.clientX, y: event.clientY }));
        return true;
      },
      dragleave(event, view) {
        const into = event.relatedTarget;
        if (!(into instanceof Node) || !view.dom.contains(into)) showDropAt(view, null);
        return false;
      },
      drop(event, view) {
        const attach = hooks();
        const files = filesOf(event.dataTransfer, false);
        showDropAt(view, null);
        if (!attach || !files.length) return false;
        event.preventDefault();
        const pos =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.head;
        void insertWhenSaved(view, pos, attach.files(files));
        return true;
      },
    }),
  ];
}

/**
 * 桌面端：从系统拖进窗口的文件。Tauri 的 drag-drop 事件是整个窗口的，落在这个编辑器
 * 上面才接。返回取消监听的函数。
 */
export function watchDesktopFileDrops(
  view: EditorView,
  hooks: () => AttachHooks | null,
): () => void {
  if (!isTauri) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;

  // 编辑器所在的那个窗口：弹出窗口（docs/标签页与分屏.md §16）的拖放事件发给的是它自己的 webview，
  // 坐标按它的像素比算
  const host = winOf(view.dom) as Window & {
    __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string } } };
  };
  const popoutLabel =
    host === window ? null : host.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;

  const posAt = (position: { x: number; y: number }) => {
    // 事件给的是物理像素
    const scale = host.devicePixelRatio || 1;
    const x = position.x / scale;
    const y = position.y / scale;
    const box = view.contentDOM.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
    return view.posAtCoords({ x, y }) ?? null;
  };

  void import("@tauri-apps/api/webview").then(async ({ Webview, getCurrentWebview }) => {
    const webview = popoutLabel ? await Webview.getByLabel(popoutLabel) : getCurrentWebview();
    if (!webview || disposed) return;
    return webview
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (!view.dom.isConnected || !hooks()?.paths) return;
        if (payload.type === "leave") {
          showDropAt(view, null);
          return;
        }
        const pos = posAt(payload.position);
        if (payload.type === "enter" || payload.type === "over") {
          showDropAt(view, pos);
          return;
        }
        // drop
        showDropAt(view, null);
        const attach = hooks();
        if (pos === null || !attach?.paths || !payload.paths.length) return;
        void insertWhenSaved(view, pos, attach.paths(payload.paths));
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}
