/* ============================================================
   正文的指纹：和 Rust 的 fsio::fingerprint 是同一个（64 位 FNV-1a，按 UTF-8 字节，16 位十六进制）。

   保存时带上「编辑器照着改的那一版」的指纹（noteSave / calendarDaySave / goalSave 的 base），
   后端拿磁盘上的正文一比就知道中间有没有被别处改过 —— 有就先另存冲突副本再写（vault/mod.rs 的
   keep_unseen_edits）。版本不用另外记：手里有正文就算得出来。

   64 位乘法拆成两个 32 位的半边算（都在 2^53 以内，浮点精确），不用 BigInt：
   自动保存每 400ms 一次，十万字的文档也只要零点几毫秒
   ============================================================ */

const encoder = new TextEncoder();
const LOW = 0x1_0000_0000;

const hex = (half: number) => half.toString(16).padStart(8, "0");

export function fingerprint(text: string): string {
  const bytes = encoder.encode(text);
  // 偏移基 0xcbf29ce484222325
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (const byte of bytes) {
    lo = (lo ^ byte) >>> 0;
    // 乘 0x100000001b3：(hi·2^32 + lo)(0x100·2^32 + 0x1b3) mod 2^64
    const low = lo * 0x1b3;
    hi = (hi * 0x1b3 + lo * 0x100 + Math.floor(low / LOW)) % LOW;
    lo = low % LOW;
  }
  return hex(hi) + hex(lo);
}
