import { describe, expect, it } from "vitest";
import {
  buildMinimizedAuditTrace,
  formatAgentProvenanceLine,
  splitProviderAndModel,
  type BuildAuditTraceInput
} from "../src/security/audit-trace.js";

describe("Ticket 29 (#30) & Step 6 (#100) — Emit minimized agent audit traces with real engine, provider and model provenance", () => {
  it.each([
    {
      id: "records-authorized-operation-splits-provider-and-model-and-strips-secrets",
      input: {
        correlationId: "corr-epure-101",
        repository: "Giskard-AI/consumer-app",
        issueNumber: 30,
        actorLogin: "maintainer",
        effectivePermission: "write",
        authorizationDecision: "allowed",
        agentRole: "implementer",
        engine: "pi",
        model: "google/gemini-3.8-flash",
        workflowRefPinnedSha: "11bd71901bbe5b1630ceea73d27597364c9af683",
        runUrl: "https://github.com/Giskard-AI/consumer-app/actions/runs/999",
        retentionDays: 30,
        diagnosticNote:
          "Executed with token ghs_SecretToken1234567890 and key sk-proj-SecretKey1234567890",
        rawPrivatePromptOrReasoning:
          "INTERNAL CHAIN OF THOUGHT: secret prompt contents"
      } satisfies BuildAuditTraceInput,
      expectedDecision: "allowed",
      expectedRetentionDays: 30,
      expectedEngine: "pi",
      expectedProvider: "google",
      expectedModel: "gemini-3.8-flash"
    },
    {
      id: "records-refused-command-trace-and-clamps-retention-days-with-explicit-provider",
      input: {
        correlationId: "corr-epure-102",
        repository: "Giskard-AI/consumer-app",
        issueNumber: 30,
        actorLogin: "external-user",
        effectivePermission: "read",
        authorizationDecision: "refused",
        agentRole: "none",
        harness: "pi",
        provider: "openai",
        model: "gpt-5.4",
        workflowRefPinnedSha: "11bd71901bbe5b1630ceea73d27597364c9af683",
        runUrl: "https://github.com/Giskard-AI/consumer-app/actions/runs/1000",
        retentionDays: 0,
        diagnosticNote: "Refused read-only user",
        rawPrivatePromptOrReasoning: "Should never be stored"
      } satisfies BuildAuditTraceInput,
      expectedDecision: "refused",
      expectedRetentionDays: 30,
      expectedEngine: "pi",
      expectedProvider: "openai",
      expectedModel: "gpt-5.4"
    },
    {
      id: "extracts-custom-gateway-provider-and-nested-model-id",
      input: {
        correlationId: "corr-epure-103",
        repository: "Giskard-AI/consumer-app",
        issueNumber: 30,
        actorLogin: "maintainer",
        effectivePermission: "write",
        authorizationDecision: "allowed",
        agentRole: "reviewer",
        engine: "pi",
        model: "openrouter/anthropic/claude-sonnet-4-6",
        workflowRefPinnedSha: "11bd71901bbe5b1630ceea73d27597364c9af683",
        runUrl: "https://github.com/Giskard-AI/consumer-app/actions/runs/1001",
        retentionDays: 30,
        diagnosticNote: "Review completed"
      } satisfies BuildAuditTraceInput,
      expectedDecision: "allowed",
      expectedRetentionDays: 30,
      expectedEngine: "pi",
      expectedProvider: "openrouter",
      expectedModel: "anthropic/claude-sonnet-4-6"
    }
  ])(
    "buildMinimizedAuditTrace [$id]: produces verifiable trace and provenance footer while omitting secrets and private prompts",
    ({
      input,
      expectedDecision,
      expectedRetentionDays,
      expectedEngine,
      expectedProvider,
      expectedModel
    }) => {
      const trace = buildMinimizedAuditTrace(input);
      const serialized = JSON.stringify(trace);

      expect(trace.authorization_decision).toBe(expectedDecision);
      expect(trace.retention_days).toBe(expectedRetentionDays);
      expect(trace.engine).toBe(expectedEngine);
      expect(trace.harness).toBe(expectedEngine);
      expect(trace.provider).toBe(expectedProvider);
      expect(trace.model).toBe(expectedModel);
      expect(trace.private_reasoning_omitted).toBe(true);
      expect(serialized).not.toContain("ghs_SecretToken1234567890");
      expect(serialized).not.toContain("sk-proj-SecretKey1234567890");
      expect(serialized).not.toContain("INTERNAL CHAIN OF THOUGHT");
      expect(trace.github_comment_footer).toContain(input.agentRole);
      expect(trace.github_comment_footer).toContain(`engine: \`${expectedEngine}\``);
      expect(trace.github_comment_footer).toContain(`provider: \`${expectedProvider}\``);
      expect(trace.github_comment_footer).toContain(`model: \`${expectedModel}\``);
      expect(trace.github_comment_footer).toContain(input.runUrl);
    }
  );

  it.each([
    {
      id: "splits-provider-and-model-from-slash-spec",
      engine: "pi",
      model: "google/gemini-3.8-flash",
      provider: undefined,
      expectedLine:
        "- **Agent Provenance**: engine `pi` | provider `google` | model `gemini-3.8-flash`"
    },
    {
      id: "handles-explicit-provider-and-prefixed-model",
      engine: "pi",
      model: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      expectedLine:
        "- **Agent Provenance**: engine `pi` | provider `anthropic` | model `claude-sonnet-4-6`"
    },
    {
      id: "falls-back-to-default-provider-when-unprefixed",
      engine: "pi",
      model: "gpt-5.4",
      provider: undefined,
      expectedLine:
        "- **Agent Provenance**: engine `pi` | provider `default` | model `gpt-5.4`"
    }
  ])(
    "formatAgentProvenanceLine [$id]: renders real engine, provider, and model for PR provenance",
    ({ engine, model, provider, expectedLine }) => {
      expect(splitProviderAndModel(model, provider)).toEqual({
        provider: provider ?? (model.includes("/") ? model.split("/")[0] : "default"),
        model: model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
      });
      expect(formatAgentProvenanceLine({ engine, model, provider })).toBe(
        expectedLine
      );
    }
  );
});
