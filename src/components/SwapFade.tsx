import { Component, type ReactNode, createRef } from "react";

/** 和 lib/motion.ts 的 tween 同一条曲线（ease-out-quint）：前段换得快，尾巴长、看不出停下的那一下 */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const OUT_MS = 180;

/** 快照放在最近的这个祖先里：它必须是定位元素、自己不滚动（快照按它的可视区裁切） */
export const SWAP_HOST = "data-swap-host";

interface Snapshot {
  clone: HTMLElement;
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 换内容时的溶解：swapKey 一变，旧内容拍一份静态快照、铺着底色盖在原处，从不透明退到透明；
 * 新内容在同一帧里挂好，一直是不透明的，从快照底下透出来。
 *
 * 为什么不是两份各淡各的（2026-10-28 以前是这样：旧的 140ms 退完、新的 220ms 才进完）：
 * 中间有一段两份都只剩一半，整块字一起变淡又变深 —— 用户说的「闪来闪去」，今日TODO ↔ /GOAL
 * 这种版面一样、只有字不一样的最明显。新内容淡入还要提成单独一层，淡完放回页面重画一次，
 * 字的抗锯齿换一下（CLAUDE.md「动效：先对齐再动」）。现在每个像素都是从旧的直接过渡到新的，
 * 新内容从头到尾是页面里正常画的那一份；快照退完就拿掉，它那一层最后怎么画无所谓。
 * 快照也不再往上飘（以前 4px）：两份版面一样的地方（分隔线、状态栏）原地重合，不会重影。
 *
 * 为什么不是 AnimatePresence：正文是 CodeMirror，两个编辑器同时挂着既贵又会
 * 抢焦点、抢保存；而且编辑器不能挂在带 transform 的祖先里（技术方案 §11.5）。
 * 旧的那一份反正要销毁，拿 DOM 克隆一份死的就够了 —— 可见的只有视口附近画出来的那一截，克隆很便宜。
 *
 * 快照必须在 React 改 DOM 之前拍，所以是 class 组件的 getSnapshotBeforeUpdate。拍完当场就盖上去
 * （和底下现在的样子一模一样，看不出来），React 再在它底下改：新内容挂上时子组件在 layout effect 里
 * 量尺寸（对齐像素、滚进视野），排版连快照一起算一次；以前改完才盖，同一帧里要再排一遍
 * （拆出一栏时 4 倍降速下多出几十毫秒，docs/标签页与分屏.md §15.6）。
 */
export class SwapFade extends Component<{
  swapKey: string;
  className?: string;
  children: ReactNode;
}> {
  private readonly ref = createRef<HTMLDivElement>();
  /** 还在退的快照，底下的在前 */
  private ghosts: HTMLElement[] = [];

  override getSnapshotBeforeUpdate(prev: { swapKey: string }): HTMLElement | null {
    if (prev.swapKey === this.props.swapKey) return null;
    const node = this.ref.current;
    if (!node || typeof node.animate !== "function" || motionReduced()) return null;
    const snapshot = capture(node);
    return snapshot ? this.cover(snapshot) : null;
  }

  override componentDidUpdate(_prev: unknown, _state: unknown, layer: HTMLElement | null) {
    if (layer) this.fade(layer);
  }

  override componentWillUnmount() {
    for (const ghost of this.ghosts) ghost.remove();
    this.ghosts = [];
  }

  /** 快照盖上去（还不透明） */
  private cover(snapshot: Snapshot): HTMLElement | null {
    const node = this.ref.current;
    const host = node?.closest<HTMLElement>(`[${SWAP_HOST}]`);
    if (!node || !host) return null;

    const layer = document.createElement("div");
    layer.className = "odea-swap-ghost";
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    Object.assign(snapshot.clone.style, {
      position: "absolute",
      top: `${snapshot.top}px`,
      left: `${snapshot.left}px`,
      width: `${snapshot.width}px`,
      height: `${snapshot.height}px`,
      minHeight: "0",
      maxWidth: "none",
      margin: "0",
      transform: "none",
      opacity: "1",
    });
    layer.append(snapshot.clone);
    // 快速连切、上一份还没退完：这一份垫在它底下。画面和上一帧一模一样，两份各退各的
    const above = this.ghosts[0];
    if (above?.parentNode === host) host.insertBefore(layer, above);
    else host.append(layer);
    this.ghosts.unshift(layer);
    return layer;
  }

  /** 新内容挂好了：快照退掉 */
  private fade(layer: HTMLElement) {
    const out = layer.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: OUT_MS,
      easing: EASE,
      fill: "forwards",
    });
    out.onfinish = () => {
      layer.remove();
      this.ghosts = this.ghosts.filter((ghost) => ghost !== layer);
    };
  }

  override render() {
    return (
      <div ref={this.ref} className={this.props.className}>
        {this.props.children}
      </div>
    );
  }
}

function capture(node: HTMLElement): Snapshot | null {
  const host = node.closest<HTMLElement>(`[${SWAP_HOST}]`);
  if (!host) return null;
  const hostRect = host.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  if (rect.bottom <= hostRect.top || rect.top >= hostRect.bottom || rect.width === 0) return null;

  const clone = node.cloneNode(true) as HTMLElement;
  // 输入框里的当前值在属性之外，cloneNode 带不过去
  const fields = node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  const copies = clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  fields.forEach((field, index) => {
    const copy = copies[index];
    if (copy) copy.value = field.value;
  });
  // 克隆出来的 id 会和新内容撞车（#doc-top 是目录的锚点）
  clone.removeAttribute("id");
  for (const element of clone.querySelectorAll("[id]")) element.removeAttribute("id");

  return {
    clone,
    top: rect.top - hostRect.top,
    left: rect.left - hostRect.left,
    width: rect.width,
    height: rect.height,
  };
}

function motionReduced(): boolean {
  return (
    document.documentElement.dataset.reduceMotion === "true" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
