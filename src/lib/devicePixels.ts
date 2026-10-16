/**
 * 把元素挪到整物理像素上：量一下它现在的位置，用静态的 translate 补掉零头。
 *
 * 要淡入淡出的小控件（图片上的悬停按钮、大图的缩放条）在动画那几帧会被浏览器提成单独
 * 一层，层是对齐到整物理像素的；元素本身落在半个物理像素上（1.5 倍屏、正文栏居中都常见）
 * 的话，动画一结束退回原处按小数位置画，整块挪不到一个像素、笔画重新抗锯齿 —— 看着就是
 * 「出来的时候闪了一下」。开始动之前对齐好，两种画法落在同一个位置，就没有这一下了。
 * 逐帧对比见 CLAUDE.md「动效：先对齐再动」。
 *
 * 位置会跟着排版、滚动变：每次要开始淡入 / 淡出前再调一次（量一次布局，很便宜）。
 */
export function snapToDevicePixels(element: HTMLElement): void {
  element.style.translate = "";
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = element.ownerDocument.defaultView?.devicePixelRatio || 1;
  const remainder = (value: number) => (Math.round(value * ratio) - value * ratio) / ratio;
  const dx = remainder(rect.left);
  const dy = remainder(rect.top);
  if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
    element.style.translate = `${Math.round(dx * 1000) / 1000}px ${Math.round(dy * 1000) / 1000}px`;
  }
}
