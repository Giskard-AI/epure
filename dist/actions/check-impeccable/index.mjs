// actions/check-impeccable/index.ts
import { appendFileSync } from "node:fs";

// src/frontend/impeccable-pr-gate.ts
function evaluateImpeccableFrontendPr(input) {
  const blocking = [];
  const informational = [];
  for (const f of input.findings) {
    if (f.isPreExistingInBaseline || f.hasApprovedException) {
      continue;
    }
    if (f.category === "subjective_aesthetic_suggestion") {
      informational.push(f);
      continue;
    }
    blocking.push(f);
  }
  return {
    conclusion: blocking.length === 0 ? "success" : "failure",
    blocking_findings: blocking,
    informational_findings: informational
  };
}

// actions/check-impeccable/index.ts
function writeActionOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${key}=${value}
`, "utf8");
  }
}
async function main() {
  let findings = [];
  try {
    const parsed = JSON.parse(process.env.INPUT_FINDINGS_JSON ?? "[]");
    if (Array.isArray(parsed)) {
      findings = parsed;
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
      `Impeccable PR gate failed with ${result.blocking_findings.length} blocking finding(s).
`
    );
    process.exitCode = 1;
  }
}
await main();
