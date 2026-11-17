/* ============================================================
   正文编辑器换掉时，键盘焦点的交接。
   正文编辑器按篇挂（`key` 是这一篇）：Ctrl+Tab、Alt+数字、Ctrl+W、Alt+←、Ctrl+点双链换篇，
   或者从命令面板打开另一篇，旧的编辑器连同手里的焦点一起拆掉，焦点掉在 body 上，
   得再点一下正文才能接着打字。这里把「焦点在正文里」交给紧接着挂上的那个编辑器：
   - 交（offer）：拆掉的编辑器手里有焦点（editor/MarkdownEditor 的 layout effect 收尾，DOM 还没摘）；
     或者模态框关掉时要还焦点的正文已经没了（lib/modalFocus）；或者 Ctrl+\ 拆出一栏（新的一栏接）
   - 接（claim）：编辑器挂上时，一秒内有人交、交的是同一个窗口、焦点还在 body 上（没被别的
     接走，比如新建的一篇聚焦了标题）就聚焦自己。不动选区和滚动：选区是这一篇上次的（缓存的状态）
   ============================================================ */

/** 交了以后多久内挂上的编辑器算接班的：换篇要等正文读回来，桌面端的 IPC 慢的时候几十毫秒 */
const WINDOW_MS = 1000;

let offer: { doc: Document; at: number } | null = null;

export function offerEditorFocus(doc: Document = document): void {
  offer = { doc, at: performance.now() };
}

/** 挂上的编辑器问一下要不要接；不管接没接，交的这一下都用掉了 */
export function claimEditorFocus(doc: Document = document): boolean {
  const pending = offer;
  offer = null;
  if (!pending || pending.doc !== doc || performance.now() - pending.at > WINDOW_MS) return false;
  const active = doc.activeElement;
  return !active || active === doc.body;
}
