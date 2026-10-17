import { describe, expect, it } from "vitest";
import { moveLegacyKeys } from "./legacyStorage";

/** 最小的内存版 Storage：按插入顺序列键，和浏览器一样 */
function memoryStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

const dump = (storage: Storage) =>
  Object.fromEntries(
    Array.from({ length: storage.length }, (_, i) => storage.key(i) as string).map((key) => [
      key,
      storage.getItem(key),
    ]),
  );

describe("改名前的 otw. 键", () => {
  it("换成 odea.，别的键不动", () => {
    const storage = memoryStorage({
      "otw.theme": "dark",
      "otw.prefs": '{"reduceMotion":true}',
      "otw.emoji-recent": '["fire"]',
      "别的应用.x": "1",
    });
    moveLegacyKeys(storage);
    expect(dump(storage)).toEqual({
      "odea.theme": "dark",
      "odea.prefs": '{"reduceMotion":true}',
      "odea.emoji-recent": '["fire"]',
      "别的应用.x": "1",
    });
  });

  it("新键已经有了以新的为准，旧键照样删掉", () => {
    const storage = memoryStorage({ "otw.theme": "dark", "odea.theme": "light" });
    moveLegacyKeys(storage);
    expect(dump(storage)).toEqual({ "odea.theme": "light" });
  });

  it("没有旧键什么都不做", () => {
    const storage = memoryStorage({ "odea.theme": "light" });
    moveLegacyKeys(storage);
    expect(dump(storage)).toEqual({ "odea.theme": "light" });
  });
});
