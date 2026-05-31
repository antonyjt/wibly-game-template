/**
 * Post-build packaging step.
 *
 * Emits dist/manifest.json and copies repo media/ → dist/media/.
 * Validates the manifest via the existing Vitest suite before writing.
 */
import * as esbuild from "esbuild";
import { cp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");
const tmpDir = resolve(root, ".tmp-build");
const mediaSrc = resolve(root, "media");
const mediaDest = resolve(distDir, "media");

const SKIP_MEDIA_NAMES = new Set([".gitkeep", "README.md"]);

async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const lines = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      lines.push(...(await listFiles(abs, rel)));
    } else {
      lines.push(rel);
    }
  }
  return lines;
}

const validation = spawnSync("pnpm", ["exec", "vitest", "run", "tests/manifest.test.ts"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
if (validation.status !== 0) {
  process.exit(validation.status ?? 1);
}

await mkdir(distDir, { recursive: true });
await mkdir(tmpDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, "manifest.ts")],
  bundle: true,
  platform: "neutral",
  format: "esm",
  outfile: resolve(tmpDir, "manifest.mjs"),
  packages: "external",
});

const manifestUrl = pathToFileURL(resolve(tmpDir, "manifest.mjs")).href;
const { default: manifest } = await import(manifestUrl);

await writeFile(resolve(distDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (existsSync(mediaSrc)) {
  await cp(mediaSrc, mediaDest, {
    recursive: true,
    filter: (src) => !SKIP_MEDIA_NAMES.has(basename(src)),
  });
}

await rm(tmpDir, { recursive: true, force: true });

console.log("Packaged publish artefacts:");
for (const file of (await listFiles(distDir)).sort()) {
  console.log(`  dist/${file}`);
}

const mediaFiles = existsSync(mediaDest) ? await listFiles(mediaDest) : [];
if (mediaFiles.length === 0) {
  console.warn(
    "\nNote: dist/media/ is empty — add portal assets under repo media/ to include them in the publish bundle.",
  );
}
