import { appendFileSync } from "node:fs";
import { runInUntrustedCodeSandbox } from "../../src/sandbox/llm-sandbox.js";

function writeActionOutputs(outputs: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    if (value.includes("\n")) {
      const delimiter = "EPURE_EOF";
      appendFileSync(
        outputPath,
        `${key}<<${delimiter}\n${value}\n${delimiter}\n`,
        "utf8"
      );
    } else {
      appendFileSync(outputPath, `${key}=${value}\n`, "utf8");
    }
  }
}

async function main(): Promise<void> {
  const command = process.env.INPUT_COMMAND ?? "";
  const rawArgs = process.env.INPUT_ARGS_JSON ?? "[]";
  const isolationAvailable =
    (process.env.INPUT_ISOLATION_AVAILABLE ?? "true").toLowerCase() === "true";

  let args: string[] = [];
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    if (Array.isArray(parsed)) {
      args = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    args = [];
  }

  const result = await runInUntrustedCodeSandbox({
    isolationAvailable,
    runnerEnv: process.env,
    command,
    args
  });

  writeActionOutputs({
    isolated: String(result.isolated),
    error_code: result.error_code,
    exit_code: String(result.exit_code),
    stdout: result.stdout,
    stderr: result.stderr
  });

  if (!result.isolated || result.exit_code !== 0) {
    process.stderr.write(`${result.error_code}: ${result.error_message}\n`);
    process.exitCode = 1;
  }
}

await main();
