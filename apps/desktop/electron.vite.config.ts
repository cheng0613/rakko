import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@rakko/core", "@rakko/shared", "@rakko/proxy"] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
    resolve: {
      alias: {
        "@rakko/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
        "@rakko/core": resolve(__dirname, "../../packages/core/src/index.ts"),
        "@rakko/proxy": resolve(__dirname, "../../packages/proxy/src/index.ts"),
      },
    },
  },
  preload: {
    // 不要 externalize @rakko/shared：它是 TS 源码，运行时没有 loader 能加载 .ts。
    // preload 必须把所有 workspace 依赖都打包进去。
    plugins: [externalizeDepsPlugin({ exclude: ["@rakko/shared"] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: { entryFileNames: "[name].mjs" },
      },
    },
    resolve: {
      alias: {
        "@rakko/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    resolve: {
      alias: {
        "@rakko/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
        "@renderer": resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
