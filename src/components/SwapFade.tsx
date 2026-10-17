import { Component, type ReactNode, createRef } from "react";

/** 和 lib/motion.ts 的 tween 同一条曲线（ease-out-quint） */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** 旧内容退得快一点，两份字叠在一起的时间越短越干净 */
const OUT_MS = 140;
const IN_MS = 220;

/** 快照放在最近的这个祖先里：它必须是定位元素、自己不滚动（快照按它的可视区裁切） */
export const SWAP_HOST = "data-swap-host";

interface Snapshot {
  clone: HTMLElement;
  top: number;
  left: number;
  width: number;
  height: number;
  /** 快速连切时新内容可能还在淡入，快照从它当时的透明度接着退 */
  opacity: number;
}

/**
 * 换内容时的交叉淡化：swapKey 一变，旧内容留一份静态快照在原处淡出，
 * 新内容在同一帧里挂好、从透明淡入。
 *
 * 为什么不是 AnimatePresence：正文是 CodeMirror，两个编辑器同时挂着既贵又会
 * 抢焦点、抢保存；而且编辑器不能挂在带 transform 的祖先里（技术方案 §11.5），
 * 新内容只能动 opacity。旧的那一份反正要销毁，拿 DOM 克隆一份死的就够了 ——
 * 可见的只有视口附近画出来的那一截，克隆很便宜。
 *
 * 以前切笔记是各部分各播各的：正文硬切、标题先消失再从下面弹上来、分隔线缩回去
 * 再展开、列表符号和表格晚一拍淡入、目录逐条错峰 —— 每一块到场的时间都不一样，
 * 看着就是整屏闪了一下。现在整块一起换。
 *
 * 快照必须在 React 改 DOM 之前拍，所以是 class 组件的 getSnapshotBeforeUpdate。
 */
export class SwapFade extends Component<{
  swapKey: string;
  className?: string;
  /** 旧内容退场时往上飘的距离（px），0 表示原地淡出 */
  exitLift?: number;
  children: ReactNode;
}> {
  private readonly ref = createRef<HTMLDivElement>();
  private ghost: HTMLElement | null = null;
  private fadeIn: Animation | null = null;

  override getSnapshotBeforeUpdate(prev: { swapKey: string }): Snapshot | null {
    if (prev.swapKey === this.props.swapKey) return null;
    const node = this.ref.current;
    if (!node || typeof node.animate !== "function" || motionReduced()) return null;
    return capture(node);
  }

  override componentDidUpdate(_prev: unknown, _state: unknown, snapshot: Snapshot | null) {
    if (snapshot) this.play(snapshot);
  }

  override componentWillUnmount() {
    this.ghost?.remove();
    this.fadeIn?.cancel();
  }

  private play(snapshot: Snapshot) {
    const node = this.ref.current;
    const host = node?.closest<HTMLElement>(`[${SWAP_HOST}]`);
    if (!node || !host) return;

    // 上一次的快照还没退完就又切了：直接换成这一份
    this.ghost?.remove();
    this.fadeIn?.cancel();

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
    host.append(layer);
    this.ghost = layer;

    const lift = this.props.exitLift ?? 0;
    const out = layer.animate(
      [
        { opacity: snapshot.opacity, transform: "none" },
        { opacity: 0, transform: `translateY(${-lift}px)` },
      ],
      { duration: OUT_MS, easing: EASE, fill: "forwards" },
    );
    out.onfinish = () => {
      layer.remove();
      if (this.ghost === layer) this.ghost = null;
    };

    this.fadeIn = node.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: IN_MS,
      easing: EASE,
    });
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
    opacity: Number(getComputedStyle(node).opacity) || 0,
  };
}

function motionReduced(): boolean {
  return (
    document.documentElement.dataset.reduceMotion === "true" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
