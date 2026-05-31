import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import { resolve } from "node:path";
import type { UserConfig } from "vite";

const root = __dirname;

/** Shared client bundle config — CSS is injected at runtime, not emitted as a file. */
export const clientLibConfig = (entry: string, name: string, emptyOutDir: boolean): UserConfig => ({
  plugins: [react(), tailwindcss(), cssInjectedByJsPlugin()],
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir,
    target: "es2022",
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(root, entry),
      formats: ["es"],
      fileName: () => `${name}.mjs`,
    },
    rollupOptions: {
      external: ["@wibly/sdk"],
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
