import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("setup-github-apps-wizard input checks", () => {
  // Every case stops before Stage 1, so nothing reaches GitHub.
  it.each([
    {
      id: "e2e-config-refuses-a-repository-without-sandbox",
      args: ["--repo", "Giskard-AI/epure-e2e", "--e2e-config", "x.json"],
      key: null,
      expected: ["must contain 'sandbox' and must not be epure-live-sandbox"]
    },
    {
      id: "e2e-config-refuses-the-live-sandbox-in-any-case",
      args: ["--repo", "Giskard-AI/EPURE-Live-Sandbox", "--e2e-config", "x.json"],
      key: null,
      expected: ["must contain 'sandbox' and must not be epure-live-sandbox"]
    },
    {
      id: "prefix-is-sanitized-and-the-app-name-capped-at-34",
      args: ["--repo", "o/my-sandbox", "--app-name-prefix", "Giskard_AI EPURE.e2e-sandbox"],
      key: null,
      expected: ["App name 'giskard-ai-epure-e2e-sandbox-release' is longer than GitHub's 34 characters"]
    },
    {
      id: "key-file-with-only-a-crlf-is-empty",
      args: ["--repo", "o/my-sandbox"],
      key: { content: "\r\n", mode: 0o600 },
      expected: ["is empty"]
    },
    {
      id: "group-readable-key-file-warns",
      args: ["--repo", "o/not-a-box", "--e2e-config", "x.json"],
      key: { content: "k\r\n", mode: 0o644 },
      expected: ["is readable by group or others (mode 644): run chmod 600", "must contain 'sandbox'"]
    }
  ])("$id", ({ args, key, expected }) => {
    const dir = mkdtempSync(join(tmpdir(), "epure-wizard-"));
    try {
      const keyArgs: string[] = [];
      if (key) {
        const path = join(dir, "llm.apikey");
        writeFileSync(path, key.content);
        chmodSync(path, key.mode);
        keyArgs.push("--llm-api-key-file", path);
      }

      const run = spawnSync("bash", ["scripts/wizards/setup-github-apps-wizard.sh", ...args, ...keyArgs], { input: "", encoding: "utf8" });

      expect(run.status).toBe(1);
      expect(run.stdout).not.toContain("Stage 1/");
      for (const text of expected) {
        expect(run.stdout).toContain(text);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
