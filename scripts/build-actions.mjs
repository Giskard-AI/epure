import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = resolve(rootDir, "dist/actions/epure-contract/index.mjs");

mkdirSync(dirname(outFile), { recursive: true });

await build({
  entryPoints: [resolve(rootDir, "actions/epure-contract/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: outFile,
  minify: false,
  legalComments: "inline"
});
