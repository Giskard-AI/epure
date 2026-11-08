import { describe, it } from "vitest";
import { loadE2eConfig, resolveGitHubToken } from "./config.js";
import { createGitHubApi } from "./github.js";
import { resetSandbox } from "./reset.js";

const MODE = process.env.EPURE_E2E;
const describeE2e = MODE === "reset" ? describe : describe.skip;
const log = (line: string) => console.log(line);

describeE2e(`EPURE e2e sandbox (EPURE_E2E=${MODE ?? "unset"})`, () => {
  it("resets the sandbox repository to the seed", { timeout: 600_000 }, async () => {
    const config = loadE2eConfig();
    await resetSandbox(createGitHubApi(resolveGitHubToken(), config.repository), log);
  });
});
