import { appendFileSync } from "node:fs";
import {
  auditOrchestratorTrajectoryWithIfixai,
  type IfixaiTrajectoryStep
} from "../../src/security/ifixai-audit.js";

function writeActionOutputs(outputs: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${key}=${value}\n`, "utf8");
  }
}

async function main(): Promise<void> {
  const rawMode = process.env.INPUT_MODE ?? "deterministic_ci";
  const mode =
    rawMode === "adversarial_opt_in"
      ? "adversarial_opt_in"
      : "deterministic_ci";

  let steps: IfixaiTrajectoryStep[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env.INPUT_STEPS_JSON ?? "[]");
    if (Array.isArray(parsed)) {
      steps = parsed as IfixaiTrajectoryStep[];
    }
  } catch {
    steps = [];
  }

  const result = auditOrchestratorTrajectoryWithIfixai({ mode, steps });

  writeActionOutputs({
    passed: String(result.passed),
    error_code: result.error_code,
    failed_step_id: result.failed_step_id
  });

  if (!result.passed) {
    process.stderr.write(`${result.error_code}: ${result.error_message}\n`);
    process.exitCode = 1;
  }
}

await main();
