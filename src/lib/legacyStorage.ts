/* ============================================================
   改名（OnTheWay → Odea）之前，localStorage / sessionStorage 的键都以 `otw.` 开头
   （主题、偏好、每篇看到哪、展开的文件夹、最近用的表情……）。

   main.tsx 第一个 import 的就是这里：在任何模块读这些键之前换成 `odea.`。
   新键已经有了以新的为准，旧键一律删掉。index.html 里定主题的那段内联脚本跑得更早，
   它自己先认一下旧键。所有设备都升级上来以后，和 src-tauri/src/old_name.rs 一起删掉。
   ============================================================ */

const OLD_PREFIX = "otw.";
const NEW_PREFIX = "odea.";

export function moveLegacyKeys(storage: Storage) {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(OLD_PREFIX)) old.push(key);
  }
  for (const key of old) {
    const value = storage.getItem(key);
    const renamed = NEW_PREFIX + key.slice(OLD_PREFIX.length);
    if (value !== null && storage.getItem(renamed) === null) storage.setItem(renamed, value);
    storage.removeItem(key);
  }
}

try {
  moveLegacyKeys(localStorage);
  moveLegacyKeys(sessionStorage);
} catch {
  // 存不了（隐私模式、被禁用）：读的那边本来就当没有处理
}
