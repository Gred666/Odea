// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { rememberNeighbors } from "./focusNeighbor";

/* 一行连同焦点要还的「…」从列表里拿掉以后，焦点给相邻的那一行（审查 2026-11-13 §5.12） */

function list(ids: string[]) {
  const host = document.createElement("div");
  for (const id of ids) {
    const slot = document.createElement("div");
    const row = document.createElement("div");
    row.tabIndex = 0;
    row.dataset.row = id;
    const more = document.createElement("button");
    row.append(more);
    slot.append(row);
    host.append(slot);
  }
  document.body.append(host);
  return host;
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
const is = (id: string) => (el: HTMLElement) => el.dataset.row === id;

afterEach(() => {
  document.body.replaceChildren();
});

describe("rememberNeighbors", () => {
  it("gives focus to the next row, or the one above when it was the last", () => {
    list(["a", "b", "c"]);
    row("b").querySelector("button")!.focus();
    const settle = rememberNeighbors("[data-row]", is("b"));
    row("b").remove();
    expect(document.activeElement).toBe(document.body);
    settle();
    expect(document.activeElement).toBe(row("c"));

    const last = rememberNeighbors("[data-row]", is("c"));
    row("c").remove();
    last();
    expect(document.activeElement).toBe(row("a"));
  });

  // 笔记列表的行收起要一会儿：这期间焦点还在它的「…」上，也算丢了；正在收起的别的行不接
  it("treats a row that is still sliding away as gone", () => {
    list(["a", "b", "c", "d"]);
    row("c").parentElement!.dataset.leaving = "";
    row("b").querySelector("button")!.focus();
    const settle = rememberNeighbors("[data-row]", is("b"));
    row("b").parentElement!.dataset.leaving = "";
    settle();
    expect(document.activeElement).toBe(row("d"));
  });

  it("leaves focus alone when it already went somewhere else", () => {
    list(["a", "b"]);
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    const settle = rememberNeighbors("[data-row]", is("a"));
    row("a").remove();
    elsewhere.focus();
    settle();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("uses the given target inside a row", () => {
    list(["a", "b"]);
    const settle = rememberNeighbors("[data-row]", is("a"), (el) => el.querySelector("button"));
    row("a").remove();
    settle();
    expect(document.activeElement).toBe(row("b").querySelector("button"));
  });
});
