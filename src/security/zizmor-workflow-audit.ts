export type ZizmorRuleId =
  | "unpinned-uses"
  | "template-injection"
  | "excessive-permissions"
  | "dangerous-triggers";

export interface ZizmorFinding {
  readonly rule_id: ZizmorRuleId;
  readonly severity: "high" | "critical";
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface AuditWorkflowSecurityInput {
  readonly workflowPath: string;
  readonly workflowYaml: string;
}

export interface AuditWorkflowSecurityResult {
  readonly passed: boolean;
  readonly findings: readonly ZizmorFinding[];
  readonly summary_markdown: string;
}

const UNSAFE_EXPRESSION_IN_RUN_PATTERN =
  /\$\{\{\s*github\.event\.(?:issue|comment|pull_request|head_commit|commits|review|discussion)\.[^}]+\}\}/i;

export function auditGitHubWorkflowSecurity(
  input: AuditWorkflowSecurityInput
): AuditWorkflowSecurityResult {
  const lines = input.workflowYaml.split(/\r?\n/);
  const findings: ZizmorFinding[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i] ?? "";
    const lineNumber = i + 1;

    if (/^\s*pull_request_target\s*:/.test(lineText)) {
      findings.push({
        rule_id: "dangerous-triggers",
        severity: "critical",
        file: input.workflowPath,
        line: lineNumber,
        message:
          "pull_request_target runs in target repo context and risks secret/token exfiltration."
      });
    }

    if (/^\s*permissions\s*:\s*write-all\b/i.test(lineText)) {
      findings.push({
        rule_id: "excessive-permissions",
        severity: "high",
        file: input.workflowPath,
        line: lineNumber,
        message:
          "permissions: write-all violates least-privilege workflow hardening."
      });
    }

    const usesMatch = /^\s*-?\s*uses\s*:\s*([^\s#]+)/.exec(lineText);
    if (usesMatch && usesMatch[1]) {
      const target = usesMatch[1].trim();
      if (!target.startsWith("./")) {
        const atIndex = target.lastIndexOf("@");
        const ref = atIndex >= 0 ? target.slice(atIndex + 1) : "";
        if (!/^[0-9a-f]{40}$/i.test(ref)) {
          findings.push({
            rule_id: "unpinned-uses",
            severity: "high",
            file: input.workflowPath,
            line: lineNumber,
            message: `Action reference '${target}' is not pinned to a full 40-char commit SHA.`
          });
        }
      }
    }

    if (
      /^\s*(?:-\s*)?run\s*:/.test(lineText) &&
      UNSAFE_EXPRESSION_IN_RUN_PATTERN.test(lineText)
    ) {
      findings.push({
        rule_id: "template-injection",
        severity: "critical",
        file: input.workflowPath,
        line: lineNumber,
        message:
          "Untrusted github.event.* context interpolated directly inside run: shell script."
      });
    }
  }

  const passed = findings.length === 0;
  const summaryLines = passed
    ? [`### zizmor Workflow Security Audit — Passed (\`${input.workflowPath}\`)`]
    : [
        `### zizmor Workflow Security Audit — Failed (\`${input.workflowPath}\`)`,
        ...findings.map(
          (f) =>
            `- **${f.rule_id}** (${f.severity}) at \`${f.file}:${f.line}\`: ${f.message}`
        )
      ];

  return {
    passed,
    findings,
    summary_markdown: summaryLines.join("\n")
  };
}
