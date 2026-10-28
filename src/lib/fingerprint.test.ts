import { describe, expect, it } from "vitest";
import { fingerprint } from "./fingerprint";

describe("fingerprint", () => {
  it("matches Rust's fsio::fingerprint", () => {
    // 和 src-tauri/src/vault/fsio.rs 的 fingerprints_match_the_frontend 同一组值
    expect(fingerprint("")).toBe("cbf29ce484222325");
    expect(fingerprint("a")).toBe("af63dc4c8601ec8c");
    expect(fingerprint("周报：第 3 期\n\n- [ ] 交稿 😀")).toBe("0b6430e23ccb5e54");
  });
});
