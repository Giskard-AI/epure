import { describe, expect, it } from "vitest";
import { loadE2eConfig, resolveGitHubToken } from "./config.js";
import { runSandboxEpic } from "./driver.js";
import { createGitHubApi } from "./github.js";
import { resetSandbox } from "./reset.js";

const MODE = process.env.EPURE_E2E;
const log = (line: string) => console.log(line);

function connect() {
  const config = loadE2eConfig();
  const { token, source } = resolveGitHubToken();
  log(`[e2e] GitHub token from ${source}`);
  return { config, token, gh: createGitHubApi(token, config.repository) };
}

describe.runIf(MODE === "reset")("EPURE e2e sandbox reset", () => {
  it("resets the sandbox repository to the seed", { timeout: 600_000 }, async () => {
    await resetSandbox(connect().gh, log);
  });
});

describe.runIf(MODE === "run")("EPURE e2e sandbox epic", () => {
  it("drives a scripted epic to Gate 3 with an open feature pull request", { timeout: 8 * 3_600_000 }, async () => {
    const { config, token, gh } = connect();
    const { result, dir } = await runSandboxEpic(config, gh, token, log);
    log(`[e2e] ${result.success ? "PASS" : "FAIL"}: report in ${dir}/report.md`);
    expect(result.checks.filter((c) => c.passed === false), result.error ?? "").toEqual([]);
  });
});
