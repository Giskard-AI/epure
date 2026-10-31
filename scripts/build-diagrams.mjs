import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ARCHIFY_BIN = resolve(REPO_ROOT, "scripts/archify/bin/archify.mjs");

export const EPURE_ARCHIFY_DIAGRAMS = [
  {
    locale: "en",
    type: "workflow",
    slug: "epure-issue-flow",
    input: "docs/archify/en/epure-issue-flow.workflow.json",
    output: "docs/public/diagrams/en/epure-issue-flow.html"
  },
  {
    locale: "fr",
    type: "workflow",
    slug: "epure-issue-flow",
    input: "docs/archify/fr/epure-issue-flow.workflow.json",
    output: "docs/public/diagrams/fr/epure-issue-flow.html"
  },
  {
    locale: "en",
    type: "lifecycle",
    slug: "epure-state-machine",
    input: "docs/archify/en/epure-state-machine.lifecycle.json",
    output: "docs/public/diagrams/en/epure-state-machine.html"
  },
  {
    locale: "fr",
    type: "lifecycle",
    slug: "epure-state-machine",
    input: "docs/archify/fr/epure-state-machine.lifecycle.json",
    output: "docs/public/diagrams/fr/epure-state-machine.html"
  },
  {
    locale: "en",
    type: "architecture",
    slug: "epure-security-architecture",
    input: "docs/archify/en/epure-security-architecture.architecture.json",
    output: "docs/public/diagrams/en/epure-security-architecture.html"
  },
  {
    locale: "fr",
    type: "architecture",
    slug: "epure-security-architecture",
    input: "docs/archify/fr/epure-security-architecture.architecture.json",
    output: "docs/public/diagrams/fr/epure-security-architecture.html"
  },
  {
    locale: "en",
    type: "workflow",
    slug: "epure-review-pipeline",
    input: "docs/archify/en/epure-review-pipeline.workflow.json",
    output: "docs/public/diagrams/en/epure-review-pipeline.html"
  },
  {
    locale: "fr",
    type: "workflow",
    slug: "epure-review-pipeline",
    input: "docs/archify/fr/epure-review-pipeline.workflow.json",
    output: "docs/public/diagrams/fr/epure-review-pipeline.html"
  },
  {
    locale: "en",
    type: "workflow",
    slug: "epure-ci-actions-flow",
    input: "docs/archify/en/epure-ci-actions-flow.workflow.json",
    output: "docs/public/diagrams/en/epure-ci-actions-flow.html"
  },
  {
    locale: "fr",
    type: "workflow",
    slug: "epure-ci-actions-flow",
    input: "docs/archify/fr/epure-ci-actions-flow.workflow.json",
    output: "docs/public/diagrams/fr/epure-ci-actions-flow.html"
  },
  {
    locale: "en",
    type: "workflow",
    slug: "epure-user-journey",
    input: "docs/archify/en/epure-user-journey.workflow.json",
    output: "docs/public/diagrams/en/epure-user-journey.html"
  },
  {
    locale: "fr",
    type: "workflow",
    slug: "epure-user-journey",
    input: "docs/archify/fr/epure-user-journey.workflow.json",
    output: "docs/public/diagrams/fr/epure-user-journey.html"
  }
];

function runArchify(args) {
  const stdout = execFileSync(process.execPath, [ARCHIFY_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

export function buildAndVerifyDiagrams({ validateOnly = false } = {}) {
  const results = [];

  for (const d of EPURE_ARCHIFY_DIAGRAMS) {
    const absInput = resolve(REPO_ROOT, d.input);
    const absOutput = resolve(REPO_ROOT, d.output);
    mkdirSync(dirname(absOutput), { recursive: true });

    const validation = runArchify([
      "validate",
      d.type,
      absInput,
      "--quality",
      "showcase",
      "--repo-root",
      REPO_ROOT,
      "--json"
    ]);

    if (
      !validation.ok ||
      validation.composition?.status !== "pass" ||
      validation.composition?.summary?.errors !== 0 ||
      validation.composition?.summary?.warnings !== 0
    ) {
      throw new Error(
        `Archify showcase validation failed for ${d.input}: ${JSON.stringify(validation, null, 2)}`
      );
    }

    if (!validateOnly) {
      execFileSync(
        process.execPath,
        [
          ARCHIFY_BIN,
          "render",
          d.type,
          absInput,
          absOutput,
          "--quality",
          "showcase",
          "--repo-root",
          REPO_ROOT
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024
        }
      );

      // Remove sidecar receipt if generated
      const receiptPath = absOutput.replace(/\.html$/i, ".delivery-receipt.json");
      if (existsSync(receiptPath)) {
        rmSync(receiptPath, { force: true });
      }
    }

    const htmlCheck = runArchify(["check", absOutput, "--json"]);
    if (!htmlCheck.ok) {
      throw new Error(
        `Archify HTML check failed for ${d.output}: ${JSON.stringify(htmlCheck, null, 2)}`
      );
    }

    results.push({
      ...d,
      validation,
      htmlCheck
    });
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const validateOnly = process.argv.includes("--check");
  const summary = buildAndVerifyDiagrams({ validateOnly });
  process.stdout.write(
    `[EPURE][Archify] Verified ${summary.length} showcase diagrams (${validateOnly ? "check-only" : "rendered + checked"}).\n`
  );
}
