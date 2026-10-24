import { appendFileSync } from "node:fs";
import {
  evaluateImpeccableFrontendPr,
  type ImpeccablePrFinding
} from "../../src/frontend/impeccable-pr-gate.js";

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
  let findings: ImpeccablePrFinding[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env.INPUT_FINDINGS_JSON ?? "[]");
    if (Array.isArray(parsed)) {
      findings = parsed as ImpeccablePrFinding[];
    }
  } catch {
    findings = [];
  }

  const result = evaluateImpeccableFrontendPr({ findings });

  writeActionOutputs({
    conclusion: result.conclusion,
    blocking_count: String(result.blocking_findings.length),
    informational_count: String(result.informational_findings.length)
  });

  if (result.conclusion !== "success") {
    process.stderr.write(
      `Impeccable PR gate failed with ${result.blocking_findings.length} blocking finding(s).\n`
    );
    process.exitCode = 1;
  }
}

await main();
