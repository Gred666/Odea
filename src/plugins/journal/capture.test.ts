import { describe, expect, it } from "vitest";
import { appendTask } from "./capture";

const apply = (body: string, text: string) => {
  const { at, insert } = appendTask(body, text);
  return body.slice(0, at) + insert + body.slice(at);
};

describe("速记记进今日TODO", () => {
  it("joins the list at the end, or starts one after a blank line", () => {
    expect(apply("", "买牛奶")).toBe("- [ ] 买牛奶\n");
    expect(apply("- [ ] 写周报\n- [x] 开会\n", "买牛奶")).toBe(
      "- [ ] 写周报\n- [x] 开会\n- [ ] 买牛奶\n",
    );
    expect(apply("## 今天\n\n写点东西\n\n\n", "买牛奶")).toBe(
      "## 今天\n\n写点东西\n\n- [ ] 买牛奶\n\n\n",
    );
    expect(apply("1. 第一件", "买牛奶")).toBe("1. 第一件\n- [ ] 买牛奶");
  });

  it("keeps it on one line", () => {
    expect(apply("", "  两行\n 合成一行 ")).toBe("- [ ] 两行 合成一行\n");
  });
});
