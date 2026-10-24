import { redactSecrets } from "../auth/issue-command-gate.js";

export interface BuildAuditTraceInput {
  readonly correlationId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly actorLogin: string;
  readonly effectivePermission: string;
  readonly authorizationDecision: "allowed" | "refused";
  readonly agentRole: string;
  readonly harness: string;
  readonly model: string;
  readonly workflowRefPinnedSha: string;
  readonly runUrl: string;
  readonly retentionDays: number;
  readonly diagnosticNote: string;
  readonly rawPrivatePromptOrReasoning?: string | undefined;
}

export interface MinimizedAuditTrace {
  readonly correlation_id: string;
  readonly repository: string;
  readonly issue_number: number;
  readonly actor_login: string;
  readonly effective_permission: string;
  readonly authorization_decision: "allowed" | "refused";
  readonly agent_role: string;
  readonly harness: string;
  readonly model: string;
  readonly workflow_ref_pinned_sha: string;
  readonly run_url: string;
  readonly retention_days: number;
  readonly private_reasoning_omitted: true;
  readonly diagnostic_note: string;
  readonly github_comment_footer: string;
}

export function buildMinimizedAuditTrace(
  input: BuildAuditTraceInput
): MinimizedAuditTrace {
  const retentionDays =
    input.retentionDays > 0 && input.retentionDays <= 90
      ? input.retentionDays
      : 30;

  const cleanDiagnostic = redactSecrets(input.diagnosticNote);
  const cleanRunUrl = redactSecrets(input.runUrl);

  const footer = [
    `<!-- epure-audit:${input.correlationId} -->`,
    `> **EPURE Provenance** — role: \`${input.agentRole}\` | harness: \`${input.harness}\` | model: \`${input.model}\` | workflow: \`${input.workflowRefPinnedSha.slice(0, 12)}\` | [Run](${cleanRunUrl})`
  ].join("\n");

  return {
    correlation_id: input.correlationId,
    repository: input.repository,
    issue_number: input.issueNumber,
    actor_login: input.actorLogin,
    effective_permission: input.effectivePermission,
    authorization_decision: input.authorizationDecision,
    agent_role: input.agentRole,
    harness: input.harness,
    model: input.model,
    workflow_ref_pinned_sha: input.workflowRefPinnedSha,
    run_url: cleanRunUrl,
    retention_days: retentionDays,
    private_reasoning_omitted: true,
    diagnostic_note: cleanDiagnostic,
    github_comment_footer: footer
  };
}
