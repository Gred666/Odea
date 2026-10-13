/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },

  // Tauri 约定：固定端口、失败不回退、Rust 改动不触发前端 HMR
  clearScreen: false,
  server: {
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
