/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** vitest 跑的时候：Loro 用 node 版（加载即就绪），见 src/collab/loro.ts */
const testing = !!process.env.VITEST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // 桌面端、浏览器预览用 Loro 的 web 版：wasm 异步流式编译（collab/loro.ts 里 await init）。
      // 它默认给浏览器的版本是同步 XHR + 同步编译 3.4MB 的 wasm，开始协作时界面会卡一下
      ...(testing ? [] : [{ find: /^loro-crdt$/, replacement: "loro-crdt/web" }]),
    ],
  },
  // web 版按自己文件的位置找 wasm（new URL(…, import.meta.url)），预构建会把它挪走、找不到
  optimizeDeps: { exclude: ["loro-crdt"] },

  // Tauri 约定：固定端口、失败不回退、Rust 改动不触发前端 HMR。
  // 绑 127.0.0.1 不用默认的 localhost：Node 在 Windows 上把 localhost 解析成 ::1、只听 IPv6，
  // 开发机上 ::1 被拦（连上去一律 EACCES，TODO「常用命令」）时 tauri dev 一直等、内置浏览器打不开
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },

  test: {
    // happy-dom 和浏览器不一样的地方在这里补齐（见文件里的说明）
    setupFiles: ["./src/test/setup.ts"],
  },

  build: {
    // WebView2 (Chromium) 与 WKWebView (Safari 16) 的交集
    target: ["es2022", "chrome110", "safari16"],
    minify: "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: {
          motion: ["motion"],
          vendor: ["react", "react-dom"],
        },
      },
    },
  },
});
