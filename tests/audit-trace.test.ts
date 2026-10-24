import { describe, expect, it } from "vitest";
import {
  buildMinimizedAuditTrace,
  type BuildAuditTraceInput
} from "../src/security/audit-trace.js";

describe("Ticket 29 (#30) — Emit minimized agent audit traces without secrets or private reasoning", () => {
  it.each([
    {
      id: "records-authorized-operation-and-strips-secrets-and-private-reasoning",
      input: {
        correlationId: "corr-epure-101",
        repository: "Giskard-AI/consumer-app",
        issueNumber: 30,
        actorLogin: "maintainer",
        effectivePermission: "write",
        authorizationDecision: "allowed",
        agentRole: "implementer",
        harness: "pi",
        model: "gpt-5.4",
        workflowRefPinnedSha: "11bd71901bbe5b1630ceea73d27597364c9af683",
        runUrl: "https://github.com/Giskard-AI/consumer-app/actions/runs/999",
        retentionDays: 30,
        diagnosticNote:
          "Executed with token ghs_SecretToken1234567890 and key sk-proj-SecretKey1234567890",
        rawPrivatePromptOrReasoning:
          "INTERNAL CHAIN OF THOUGHT: secret prompt contents"
      } satisfies BuildAuditTraceInput,
      expectedDecision: "allowed",
      expectedRetentionDays: 30
    },
    {
      id: "records-refused-command-trace-and-clamps-retention-days",
      input: {
        correlationId: "corr-epure-102",
        repository: "Giskard-AI/consumer-app",
        issueNumber: 30,
        actorLogin: "external-user",
        effectivePermission: "read",
        authorizationDecision: "refused",
        agentRole: "none",
        harness: "pi",
        model: "gpt-5.4",
        workflowRefPinnedSha: "11bd71901bbe5b1630ceea73d27597364c9af683",
        runUrl: "https://github.com/Giskard-AI/consumer-app/actions/runs/1000",
        retentionDays: 0,
        diagnosticNote: "Refused read-only user",
        rawPrivatePromptOrReasoning: "Should never be stored"
      } satisfies BuildAuditTraceInput,
      expectedDecision: "refused",
      expectedRetentionDays: 30
    }
  ])(
    "buildMinimizedAuditTrace [$id]: produces verifiable trace and provenance footer while omitting secrets and private prompts",
    ({ input, expectedDecision, expectedRetentionDays }) => {
      const trace = buildMinimizedAuditTrace(input);
      const serialized = JSON.stringify(trace);

      expect(trace.authorization_decision).toBe(expectedDecision);
      expect(trace.retention_days).toBe(expectedRetentionDays);
      expect(trace.private_reasoning_omitted).toBe(true);
      expect(serialized).not.toContain("ghs_SecretToken1234567890");
      expect(serialized).not.toContain("sk-proj-SecretKey1234567890");
      expect(serialized).not.toContain("INTERNAL CHAIN OF THOUGHT");
      expect(trace.github_comment_footer).toContain(input.agentRole);
      expect(trace.github_comment_footer).toContain(input.model);
      expect(trace.github_comment_footer).toContain(input.runUrl);
    }
  );
});
