import type { EditorView } from "@codemirror/view";
import type { Mermaid } from "mermaid";
import { OtwWidget, positionOf } from "./widgets";

/* ============================================================
   ```mermaid 围栏的图表替身。

   mermaid 有 2MB 多，只在文档里真的有图表围栏时才拉。渲染是异步的：先放一个
   占位，SVG 回来后替换并让 CodeMirror 重新量高。语法错误就把错误信息显示在
   原位，代码留在源码里，点一下就能进去改。

   securityLevel 用默认的 strict：mermaid 会自己把标签里的 HTML 净化掉；
   拿到 SVG 字符串后也不走 innerHTML，而是 DOMParser 解析后只把 <svg> 节点
   收进来。
   ============================================================ */

/** 加载器单独拆出来，单测里可以换成不真拉包的桩（并把 cached 清掉）。 */
export const diagramEngine = {
  cached: null as Promise<Mermaid> | null,
  load(): Promise<Mermaid> {
    return import("mermaid").then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        // mermaid 12 的默认布局是 ELK：画一张最普通的 graph TD 也要拉 1.4 MB 的 elkjs，
        // JS 堆多 6–7 MB（2026-10-14 量的）。dagre 只有 46 KB，连线是曲线（ELK 是直角折线）。
        // 图里自己写了 layout: elk 的照样用 ELK
        layout: "dagre",
        // 和正文同一套字体（globals.css 的 --font-sans）
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', sans-serif",
      });
      return mermaid;
    });
  },
  get(): Promise<Mermaid> {
    this.cached ??= this.load();
    return this.cached;
  },
};

let sequence = 0;

/**
 * 渲染结果按代码缓存：同一段图表滚出视口再滚回来、或者替身因为别的原因重建时，
 * 不用再跑一遍 mermaid。上限 40 张，超过就把最早的丢掉。
 */
const rendered = new Map<string, string>();
const RENDER_CACHE_LIMIT = 40;

function remember(code: string, svg: string): void {
  if (rendered.size >= RENDER_CACHE_LIMIT) {
    const oldest = rendered.keys().next().value;
    if (oldest !== undefined) rendered.delete(oldest);
  }
  rendered.set(code, svg);
}

function mountSvg(host: HTMLElement, svg: string): void {
  const parsed = new DOMParser().parseFromString(svg, "text/html");
  const element = parsed.body.querySelector("svg");
  if (!element) throw new Error("没有生成 SVG");
  element.removeAttribute("height");
  host.replaceChildren(document.adoptNode(element));
  host.classList.remove("is-loading");
}

export class DiagramWidget extends OtwWidget {
  constructor(private readonly code: string) {
    super();
  }

  eq(other: DiagramWidget) {
    return other.code === this.code;
  }

  protected override heightKey() {
    return `diagram:${this.code}`;
  }

  /** 没画过的图表多半两三百像素高；按一行估的话，跳到它下面时整页会沉一大截 */
  protected override guessHeight() {
    return 300;
  }

  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = "cm-otw-diagram-block";
    const host = document.createElement("div");
    host.className = "cm-otw-diagram is-loading";
    host.title = "点击编辑图表";
    host.textContent = "渲染图表…";
    host.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: positionOf(view, block) } });
      view.focus();
    });
    block.append(host);
    this.settle(block);

    const cached = rendered.get(this.code);
    if (cached) {
      mountSvg(host, cached);
      return block;
    }

    sequence += 1;
    const id = `otw-diagram-${sequence}`;
    void diagramEngine
      .get()
      .then((mermaid) => mermaid.render(id, this.code))
      .then(({ svg }) => {
        remember(this.code, svg);
        if (!host.isConnected) return;
        mountSvg(host, svg);
        view.requestMeasure();
      })
      .catch((error: unknown) => {
        if (!host.isConnected) return;
        const message = error instanceof Error ? error.message : String(error);
        host.textContent = `图表无法渲染：${message.split("\n")[0]}`;
        host.classList.remove("is-loading");
        host.classList.add("is-error");
        view.requestMeasure();
      });

    return block;
  }
}
