import { defineConfig } from "vite";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FRONTEND_PUBLIC = resolve(__dirname, "../frontend/public");

/**
 * 1) dist/bookmarklet.txt — プレースホルダ入りの検証用（そのままでは実行不可）
 * 2) frontend/public/bookmarklet.iife.js — フロントが読み込みトークンを埋め込む
 */
function bookmarkletPlugin() {
  return {
    name: "bookmarklet-wrap-and-copy",
    closeBundle() {
      const file = resolve(__dirname, "dist/bookmarklet.iife.js");
      const code = readFileSync(file, "utf8");
      const wrapped = `javascript:${encodeURIComponent(`void (function(){${code}})();`)}`;
      writeFileSync(resolve(__dirname, "dist/bookmarklet.txt"), wrapped, "utf8");

      mkdirSync(FRONTEND_PUBLIC, { recursive: true });
      copyFileSync(file, resolve(FRONTEND_PUBLIC, "bookmarklet.iife.js"));
    },
  };
}

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      name: "RhythmInfoBookmarklet",
      formats: ["iife"],
      fileName: () => "bookmarklet.iife.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    emptyOutDir: true,
  },
  plugins: [bookmarkletPlugin()],
});
