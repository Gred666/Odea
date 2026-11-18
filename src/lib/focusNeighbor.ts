/**
 * 一行要从列表里拿掉了（「移动到…」别的文件夹、「从列表里移除」）：焦点要还的「…」按钮跟着那一行拆掉，
 * 用键盘做完这一步焦点就落在 body 上（审查 2026-11-13 §5.12）。拿掉之前记下它相邻的几行（下面的在前，
 * 再是上面的），拿掉以后焦点没去别处的话，给还在的第一行。
 *
 * rows：列表里每一行的选择器；which：要拿掉的是哪一行（按 data 属性比，不拼进选择器：路径里的反斜杠、引号
 * 转义起来各家不一样）；target：一行里接焦点的那个（行本身能聚焦就是它自己）。
 * 正在收起的行（`[data-leaving]` 里的，笔记列表的 NoteSlot）算已经走了：焦点还在它里面也要挪，也不往它上面放
 */
export function rememberNeighbors(
  rows: string,
  which: (row: HTMLElement) => boolean,
  target: (row: HTMLElement) => HTMLElement | null = (el) => el,
): () => void {
  const all = [...document.querySelectorAll<HTMLElement>(rows)];
  const at = all.findIndex(which);
  if (at < 0) return () => {};
  const row = all[at]!;
  const neighbors = [...all.slice(at + 1), ...all.slice(0, at).reverse()];
  const gone = (el: Element) => !el.isConnected || el.closest("[data-leaving]") !== null;
  return () => {
    const active = document.activeElement;
    if (active && active !== document.body && !gone(active) && !row.contains(active)) return;
    for (const neighbor of neighbors) {
      const focusable = gone(neighbor) ? null : target(neighbor);
      if (focusable) {
        focusable.focus();
        return;
      }
    }
  };
}

/** 等 React 把这一次的变化画上去（拿掉的那一行真的不在了、或者开始收起）再落焦点 */
export function afterPaint(run: () => void): void {
  requestAnimationFrame(() => run());
}
