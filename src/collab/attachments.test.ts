import { resolveImageSource } from "@/editor/html";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GuestImages,
  copyImages,
  dataUrlBase64,
  imageRefs,
  isRelativeRef,
  rewriteImageRefs,
  vaultPathOf,
} from "./attachments";

/* 协作里的附件（attachments.ts）：主持人给 Rust 的引用表、访客要图片和给编辑器的解析器。
   Rust 那边「只给引用了的、落在附件/ 里的」在 src-tauri/src/collab/tests.rs 和 commands.rs */

afterEach(() => {
  vi.useRealTimers();
});

describe("正文里的图片", () => {
  it("相对路径的才算：行内、引用式、<img>；网络的、data:、本机绝对路径、锚点不算", () => {
    const markdown = [
      '![截图](../附件/a.png) 和 ![](附件/b%20c.png "标题")',
      "![网](https://example.com/x.png) ![内](data:image/png;base64,AAAA)",
      "![本机](C:/Users/me/x.png) ![根](/abs/x.png) ![锚](#x)",
      "![引用][logo]",
      "[logo]: <../附件/logo.svg>",
      '<img src="./图/d.png" width="200"> <img src=附件/e.gif>',
      "再来一次 ![](../附件/a.png)",
    ].join("\n");
    expect(imageRefs(markdown)).toEqual([
      "../附件/a.png",
      "附件/b%20c.png",
      "../附件/logo.svg",
      "./图/d.png",
      "附件/e.gif",
    ]);
    expect(isRelativeRef("file:///C:/a.png")).toBe(false);
    expect(isRelativeRef("\\\\server\\share\\a.png")).toBe(false);
  });

  it("按这篇所在的文件夹算出仓库里的路径；退到仓库外面的不认", () => {
    expect(vaultPathOf("笔记/工作/周会.md", "../../附件/a.png")).toBe("附件/a.png");
    expect(vaultPathOf("笔记/周会.md", "../附件/b%20c.png")).toBe("附件/b c.png");
    expect(vaultPathOf("周会.md", "./附件/./x.png")).toBe("附件/x.png");
    expect(vaultPathOf("笔记/周会.md", "../../../etc/passwd")).toBeNull();
    expect(vaultPathOf("笔记\\工作\\周会.md", "..\\..\\附件\\a.png")).toBe("附件/a.png");
  });
});

describe("访客要图片", () => {
  it("扫到新图片才去要；要到了换一个新的解析器，编辑器据此重画", async () => {
    const fetch = vi.fn(async (_path: string) => ({
      url: "asset://cache/a.png",
      file: "C:/data/collab/cache/0a1b/a.png",
    }));
    const changes: Array<(source: string) => string> = [];
    const images = new GuestImages(fetch, (resolver) => changes.push(resolver.resolve));
    const first = images.resolver;
    // 还没要到：空着（显示占位）；网络图片原样；主持人电脑上的绝对路径不显示
    expect(first.resolve("../附件/a.png")).toBe("");
    expect(first.resolve("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(first.resolve("C:/Users/host/x.png")).toBe("");
    images.scan("![](../附件/a.png) ![](../附件/a.png)");
    images.scan("![](../附件/a.png)");
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(images.resolver).not.toBe(first);
    expect(images.resolver.resolve(" ../附件/a.png ")).toBe("asset://cache/a.png");
    // 编辑器那边：解析器直接给 <img> 的地址
    expect(resolveImageSource("../附件/a.png", images.resolver)).toBe("asset://cache/a.png");
    expect(resolveImageSource("../附件/没要到.png", images.resolver)).toBe("");
    // 「存一份到我的笔记」按缓存的文件存
    expect(images.fetched(" ../附件/a.png ")?.file).toBe("C:/data/collab/cache/0a1b/a.png");
    expect(images.fetched("../附件/没要到.png")).toBeUndefined();
    images.destroy();
  });

  it("要不到的过一会儿再试（主持人的引用表可能晚一步），试几次就算了；重连后从头算", async () => {
    vi.useFakeTimers();
    let ok = false;
    const fetch = vi.fn(async () => {
      if (!ok) throw new Error("这个文件不在这篇正文里");
      return { url: "asset://cache/a.png", file: null };
    });
    const images = new GuestImages(fetch, () => {});
    images.scan("![](附件/a.png)");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    // 再扫也不要了
    images.scan("![](附件/a.png)");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    // 断了又连上：重新算
    ok = true;
    images.retryFailed();
    images.scan("![](附件/a.png)");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(images.resolver.resolve("附件/a.png")).toBe("asset://cache/a.png");
    images.destroy();
  });
});

describe("访客存一份到自己的笔记", () => {
  it("只换图片语法里地址那一段：alt、标题里一样的字、普通链接不动", () => {
    const markdown = [
      '![a.png](a.png "a.png") [a.png](a.png)',
      "![引用][x]",
      "[x]: <a.png>",
      '<img src=" a.png " alt="a.png"> ![别的](b.png)',
    ].join("\n");
    const out = rewriteImageRefs(markdown, new Map([["a.png", "附件/新.png"]]));
    expect(out).toBe(
      [
        '![a.png](附件/新.png "a.png") [a.png](a.png)',
        "![引用][x]",
        "[x]: <附件/新.png>",
        '<img src=" 附件/新.png " alt="a.png"> ![别的](b.png)',
      ].join("\n"),
    );
    expect(rewriteImageRefs(markdown, new Map())).toBe(markdown);
  });

  it("要到了的存进自己的附件、路径换掉；没要到的、存不进去的数出来，路径留着", async () => {
    const markdown = [
      "![](../附件/a.png)",
      "![](../附件/%E5%9B%BE.svg)",
      "![](../附件/没要到.png)",
      "![](../附件/坏.png)",
    ].join("\n");
    const attachPath = vi.fn(async (file: string) => {
      if (file.includes("坏")) throw new Error("写不进去");
      return { link: "附件/a.png", name: "a.png", isImage: true };
    });
    const attachData = vi.fn(async (name: string, _data: string) => ({
      link: `附件/${name}`,
      name,
      isImage: true,
    }));
    const fetched = (ref: string) =>
      ({
        "../附件/a.png": { url: "asset://a", file: "C:/cache/1/a.png" },
        "../附件/%E5%9B%BE.svg": { url: "data:image/svg+xml;utf8,%3Csvg%2F%3E", file: null },
        "../附件/坏.png": { url: "asset://bad", file: "C:/cache/2/坏.png" },
      })[ref];
    const { markdown: out, missing } = await copyImages(markdown, fetched, {
      attachPath,
      attachData,
    });
    expect(out).toBe(
      [
        "![](附件/a.png)",
        "![](附件/图.svg)",
        "![](../附件/没要到.png)",
        "![](../附件/坏.png)",
      ].join("\n"),
    );
    expect(missing).toBe(2);
    // 浏览器预览里按名字和内容存：名字是正文里写的那个（解开 %xx）
    expect(attachData).toHaveBeenCalledWith("图.svg", btoa("<svg/>"));
  });

  it("data: 地址转成 base64：已经是 base64 的原样，文字的按 UTF-8 编", () => {
    expect(dataUrlBase64("data:image/png;base64,AAAA")).toBe("AAAA");
    expect(dataUrlBase64("data:image/svg+xml;utf8,%3Csvg%3E%E5%9B%BE%3C%2Fsvg%3E")).toBe(
      btoa(String.fromCharCode(...new TextEncoder().encode("<svg>图</svg>"))),
    );
    expect(dataUrlBase64("asset://x")).toBeNull();
  });
});
