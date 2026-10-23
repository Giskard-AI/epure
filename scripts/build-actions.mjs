import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const actionTargets = [
  {
    entryPoint: resolve(rootDir, "actions/epure-contract/index.ts"),
    outFile: resolve(rootDir, "dist/actions/epure-contract/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/authorize-command/index.ts"),
    outFile: resolve(rootDir, "dist/actions/authorize-command/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/verify-app-role/index.ts"),
    outFile: resolve(rootDir, "dist/actions/verify-app-role/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/publish-agent-output/index.ts"),
    outFile: resolve(rootDir, "dist/actions/publish-agent-output/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/run-sandboxed/index.ts"),
    outFile: resolve(rootDir, "dist/actions/run-sandboxed/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "src/bootstrap/cli.ts"),
    outFile: resolve(rootDir, "dist/cli/setup-repo.mjs")
  }
];

for (const target of actionTargets) {
  mkdirSync(dirname(target.outFile), { recursive: true });
  await build({
    entryPoints: [target.entryPoint],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: target.outFile,
    minify: false,
    legalComments: "inline"
  });
}
