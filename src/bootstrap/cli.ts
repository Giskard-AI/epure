#!/usr/bin/env node
import { planAndApplyRepoSetup } from "./setup-repo.js";

function parseArgs(argv: readonly string[]): {
  repository: string;
  repoRootDir: string | undefined;
  dryRun: boolean;
  json: boolean;
} {
  let repository = "";
  let repoRootDir: string | undefined;
  let dryRun = true;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo" && argv[i + 1]) {
      repository = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--dir" && argv[i + 1]) {
      repoRootDir = argv[i + 1];
      i += 1;
    } else if (arg === "--apply") {
      dryRun = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    }
  }

  return { repository, repoRootDir, dryRun, json };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = planAndApplyRepoSetup({
    repository: args.repository,
    repoRootDir: args.repoRootDir,
    dryRun: args.dryRun
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.summary_markdown}\n`);
  }

  if (result.status === "error") {
    process.exitCode = 1;
  }
}

main();
