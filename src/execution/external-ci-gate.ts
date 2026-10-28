import { basename } from "node:path";
import { redactSecrets } from "../auth/issue-command-gate.js";
import { appendEpureCommandsSpoiler } from "../orchestrator/formatting/comments.js";
import {
  AuthenticationError,
  isTransientLLMError,
  LLMError,
  QuotaExhaustedError
} from "../llm/errors.js";
import { matchesPathPattern } from "../sandbox/polyglot-workspace-runner.js";
import { wrapUntrustedContent } from "../security/prompt-injection-guard.js";

export interface ExpectedExternalWorkflow {
  readonly path: string;
  readonly fileName: string;
  readonly workflowName: string;
  readonly triggers: readonly ("pull_request" | "push")[];
  readonly hasServices: boolean;
}

export interface DiscoverExpectedExternalWorkflowsInput {
  readonly workflowFilesMap:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>;
  readonly changedPaths: readonly string[];
  readonly targetBranch?: string | undefined;
}

export interface CheckRunAnnotationRecord {
  readonly path?: string | undefined;
  readonly start_line?: number | undefined;
  readonly end_line?: number | undefined;
  readonly annotation_level?: string | undefined;
  readonly title?: string | undefined;
  readonly message?: string | undefined;
}

export interface ExternalWorkflowRunRecord {
  readonly id: number;
  readonly name?: string | undefined;
  readonly path?: string | undefined;
  readonly status: string;
  readonly conclusion?: string | null | undefined;
  readonly html_url?: string | undefined;
  readonly head_sha?: string | undefined;
}

export interface ExternalCheckRunRecord {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null | undefined;
  readonly html_url?: string | undefined;
  readonly details_url?: string | undefined;
}

export interface ClassifyCiFailureInput {
  readonly conclusion: string;
  readonly checkName?: string | undefined;
  readonly rawLog: string;
  readonly annotations?: readonly CheckRunAnnotationRecord[] | undefined;
  readonly headSha: string;
  readonly infraRerunsUsedForSha: number;
  readonly maxInfraRerunsPerSha?: number | undefined;
}

export interface CiFailureClassification {
  readonly classification: "transient_infra" | "code_or_test_failure";
  readonly shouldRerunWorkflow: boolean;
  readonly reason: string;
}

export interface SanitizeCheckLogsInput {
  readonly checkName: string;
  readonly htmlUrl?: string | undefined;
  readonly annotations?: readonly CheckRunAnnotationRecord[] | undefined;
  readonly rawLog: string;
  readonly extraSecrets?: readonly string[] | undefined;
  readonly maxBytes?: number | undefined;
}

export interface SanitizedCheckLogResult {
  readonly sanitizedExcerpt: string;
  readonly wrappedUntrustedOutput: string;
  readonly neutralizedWorkflowCommands: number;
}

export interface ExternalCiProgressUpdate {
  readonly pollIndex: number;
  readonly elapsedMs: number;
  readonly activeWorkflowRuns: number;
  readonly completedWorkflowRuns: number;
  readonly activeCheckRuns: number;
  readonly completedCheckRuns: number;
  readonly infraRerunsTriggered: number;
}

export interface WaitForExternalCiChecksInput {
  readonly headSha: string;
  readonly expectedWorkflows: readonly (ExpectedExternalWorkflow | string)[];
  readonly waitForExternalCi?: boolean | undefined;
  readonly timeoutMinutes?: number | undefined;
  readonly graceWindowSeconds?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly remainingWallClockMs?: number | undefined;
  readonly extraSecrets?: readonly string[] | undefined;
  readonly infraRerunsBySha?: Map<string, number> | undefined;
  readonly listWorkflowRunsForSha: (
    headSha: string
  ) => Promise<readonly ExternalWorkflowRunRecord[]>;
  readonly listCheckRunsForRef: (
    headSha: string
  ) => Promise<readonly ExternalCheckRunRecord[]>;
  readonly listCheckRunAnnotations?:
    | ((checkRunId: number) => Promise<readonly CheckRunAnnotationRecord[]>)
    | undefined;
  readonly getJobLogs?: ((jobId: number) => Promise<string>) | undefined;
  readonly rerunFailedJobs?: ((runId: number) => Promise<void>) | undefined;
  readonly onProgress?:
    | ((progress: ExternalCiProgressUpdate) => Promise<void> | void)
    | undefined;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
  readonly nowFn?: (() => number) | undefined;
}

export interface FailedExternalCheckSummary {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string;
  readonly html_url: string;
  readonly sanitized_log: string;
  readonly wrapped_untrusted_output: string;
}

export type ExternalCiGateOutcomeReason =
  | "all_passed"
  | "no_external_workflows"
  | "disabled_by_config"
  | "check_failure"
  | "grace_window_timeout"
  | "poll_timeout"
  | "wall_clock_budget_exhausted";

export interface WaitForExternalCiChecksResult {
  readonly passed: boolean;
  readonly reason: ExternalCiGateOutcomeReason;
  readonly infraRerunsTriggered: number;
  readonly failedChecks: readonly FailedExternalCheckSummary[];
  readonly formattedDiagnostics: string;
  readonly registeredWorkflowNames: readonly string[];
  readonly registeredCheckNames: readonly string[];
}

export type NeedsHumanEscalationReason =
  | "remediation_exhausted"
  | "grace_window_timeout"
  | "sensitive_path_violation"
  | "wall_clock_budget_exhausted"
  | "transient_llm_api_exhausted"
  | "llm_quota_or_auth_failure"
  | "llm_request_invalid"
  | "internal_error";

/**
 * Maps an LLM error to its needs-human reason. Only transient failures (5xx, 408,
 * 429 after waits, timeouts) are reported as transient exhaustion; malformed
 * responses after corrective retries and rejected requests get `llm_request_invalid`.
 */
export function resolveLlmEscalationReason(
  err: LLMError
): NeedsHumanEscalationReason {
  if (err instanceof AuthenticationError || err instanceof QuotaExhaustedError) {
    return "llm_quota_or_auth_failure";
  }
  if (isTransientLLMError(err)) {
    return "transient_llm_api_exhausted";
  }
  return "llm_request_invalid";
}

export interface FormatNeedsHumanEscalationInput {
  readonly issueNumber: number;
  readonly ticketIssueNumber?: number | undefined;
  readonly prNumber?: number | undefined;
  readonly prUrl?: string | undefined;
  readonly branch: string;
  readonly reason: NeedsHumanEscalationReason;
  readonly codeFixAttemptsUsed?: number | undefined;
  readonly maxCodeFixAttempts?: number | undefined;
  readonly graceWindowSeconds?: number | undefined;
  readonly expectedWorkflows?: readonly string[] | undefined;
  readonly sensitivePaths?: readonly string[] | undefined;
  readonly traversalPaths?: readonly string[] | undefined;
  readonly failedChecks?:
    | ReadonlyArray<{
        readonly name: string;
        readonly conclusion: string;
        readonly html_url?: string | undefined;
      }>
    | undefined;
  readonly mustFixFindings?:
    | ReadonlyArray<{
        readonly reviewer: string;
        readonly path: string;
        readonly line: number;
        readonly title: string;
        readonly rationale: string;
      }>
    | undefined;
  readonly diagnosticExcerpt?: string | undefined;
  readonly stateMirrorMarkdown?: string | undefined;
}

const EPURE_SYNTHETIC_CHECK_NAMES = new Set([
  "ai-review",
  "impeccable-gate",
  "pr title",
  "verify epure consumer contract",
  "verify-contract / verify epure consumer contract",
  "verify-contract",
  "authorize /epure issue command",
  "orchestrate authorized /epure lifecycle"
]);

const TEST_OR_CODE_FAILURE_PATTERNS: readonly RegExp[] = [
  /(?:^|\n|\s)FAIL\s+\S+/m,
  /---\s*FAIL:/,
  /\bAssertionError\b/,
  /\bTS\d{4}:/,
  /Traceback \(most recent call last\)/,
  /\bpanicked at\b/,
  /\bSyntaxError:/,
  /\bReferenceError:/,
  /\bTypeError:/,
  /\bexpect\(.*\)\.(?:to|not)/
];

const TRANSIENT_INFRA_PATTERNS: readonly RegExp[] = [
  /\bETIMEDOUT\b/i,
  /\bECONNRESET\b/i,
  /\bEAI_AGAIN\b/i,
  /\b502 Bad Gateway\b/i,
  /\b503 Service Unavailable\b/i,
  /\b504 Gateway Timeout\b/i,
  /\bRunner\.Worker\b/i,
  /The hosted runner lost communication/i,
  /runner has received a shutdown signal/i,
  /failed to fetch .* from registry/i,
  /TLS handshake timeout/i,
  /rate limit exceeded/i
];

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ISO_TIMESTAMP_PREFIX_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/gm;
const GHA_WORKFLOW_COMMAND_REGEX =
  /::(error|warning|notice|debug|group|endgroup|add-mask|set-env|set-output|save-state|stop-commands)\b/gi;

const LOG_FAILURE_ANCHOR_REGEX =
  /(?:##\[error\]|:\[error\]|\bFAIL\s+\S+|---\s*FAIL:|^\s*(?:●|✕|×|❯)\s+|\b(?:AssertionError|RangeError|TypeError|ReferenceError|SyntaxError)\b|\bError:|\bTS\d{4}:|Traceback \(most recent call last\)|\bpanicked at\b)/i;

const APP_LOGGER_NOISE_REGEX =
  /^\d{2}:\d{2}:\d{2}\s+\[(?:error|warn|info|debug)\]/i;

const COVERAGE_TABLE_ROW_REGEX =
  /^(?:\s*[^|]+\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+|\s*[-|]{20,}\s*|\s*File\s*\|\s*% Stmts\s*\|)/;

function unquoteYamlString(raw: string): string {
  const trimmed = raw.trim().replace(/\s+#.*$/, "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineYamlList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  return inner
    .split(",")
    .map((s) => unquoteYamlString(s))
    .filter((s) => s.length > 0);
}

function parseWorkflowOnTriggersAndFilters(content: string): {
  readonly workflowName: string;
  readonly triggers: readonly ("pull_request" | "push")[];
  readonly pathsInclude: readonly string[];
  readonly pathsIgnore: readonly string[];
  readonly branchesInclude: readonly string[];
  readonly hasServices: boolean;
} {
  const lines = content.split(/\r?\n/);
  let workflowName = "CI";
  const triggersSet = new Set<"pull_request" | "push">();
  const pathsInclude: string[] = [];
  const pathsIgnore: string[] = [];
  const branchesInclude: string[] = [];
  const hasServices = /^\s+services:\s*(?:#.*)?$/m.test(content);

  for (const line of lines) {
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch && nameMatch[1]) {
      workflowName = unquoteYamlString(nameMatch[1]);
      break;
    }
  }

  let inOnBlock = false;
  let activeEvent: "pull_request" | "push" | "other" | null = null;
  let activeFilterKey: "paths" | "paths-ignore" | "branches" | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;

    if (indent === 0) {
      activeEvent = null;
      activeFilterKey = null;
      const onMatch = /^(?:on|"on"|'on'):\s*(.*)$/.exec(trimmed);
      if (onMatch) {
        inOnBlock = true;
        const rest = (onMatch[1] ?? "").replace(/\s+#.*$/, "").trim();
        if (rest.startsWith("[")) {
          for (const item of parseInlineYamlList(rest)) {
            if (item === "pull_request" || item === "pull_request_target") {
              triggersSet.add("pull_request");
            } else if (item === "push") {
              triggersSet.add("push");
            }
          }
          inOnBlock = false;
        } else if (rest === "pull_request") {
          triggersSet.add("pull_request");
          inOnBlock = false;
        } else if (rest === "push") {
          triggersSet.add("push");
          inOnBlock = false;
        }
        continue;
      }
      if (inOnBlock) {
        inOnBlock = false;
      }
      continue;
    }

    if (!inOnBlock) {
      continue;
    }

    if (indent === 2) {
      activeFilterKey = null;
      const evMatch = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(trimmed);
      if (evMatch && evMatch[1]) {
        const evName = evMatch[1];
        if (evName === "pull_request" || evName === "pull_request_target") {
          triggersSet.add("pull_request");
          activeEvent = "pull_request";
        } else if (evName === "push") {
          triggersSet.add("push");
          activeEvent = "push";
        } else {
          activeEvent = "other";
        }
      }
      continue;
    }

    if (activeEvent === "pull_request" || activeEvent === "push") {
      if (indent === 4) {
        const filterMatch = /^(paths|paths-ignore|branches):\s*(.*)$/.exec(
          trimmed
        );
        if (filterMatch && filterMatch[1]) {
          const key = filterMatch[1] as "paths" | "paths-ignore" | "branches";
          const rest = (filterMatch[2] ?? "").replace(/\s+#.*$/, "").trim();
          if (rest.startsWith("[")) {
            const list = parseInlineYamlList(rest);
            if (key === "paths") pathsInclude.push(...list);
            else if (key === "paths-ignore") pathsIgnore.push(...list);
            else if (key === "branches" && activeEvent === "pull_request") {
              branchesInclude.push(...list);
            }
            activeFilterKey = null;
          } else {
            activeFilterKey = key;
          }
        } else {
          activeFilterKey = null;
        }
        continue;
      }

      if (indent >= 6 && activeFilterKey && trimmed.startsWith("-")) {
        const val = unquoteYamlString(trimmed.replace(/^-\s*/, ""));
        if (val) {
          if (activeFilterKey === "paths") pathsInclude.push(val);
          else if (activeFilterKey === "paths-ignore") pathsIgnore.push(val);
          else if (
            activeFilterKey === "branches" &&
            activeEvent === "pull_request"
          ) {
            branchesInclude.push(val);
          }
        }
      }
    }
  }

  return {
    workflowName,
    triggers: Array.from(triggersSet),
    pathsInclude,
    pathsIgnore,
    branchesInclude,
    hasServices
  };
}

export function isEpureManagedWorkflow(
  filePath: string,
  content: string
): boolean {
  const fileName = basename(filePath).toLowerCase();
  if (
    fileName.startsWith("epure-") ||
    fileName === "pr-title.yml" ||
    fileName === "pr-title.yaml" ||
    fileName === "release.yml" ||
    fileName === "release.yaml"
  ) {
    return true;
  }
  if (
    content.includes("Giskard-AI/epure/actions/") ||
    content.includes("Giskard-AI/epure/.github/workflows/")
  ) {
    return true;
  }
  return false;
}

export function isEpureSyntheticCheckOrRun(nameOrPath: string): boolean {
  const clean = nameOrPath.trim().toLowerCase();
  const base = basename(clean);
  if (
    base.startsWith("epure-") ||
    base === "pr-title.yml" ||
    base === "release.yml"
  ) {
    return true;
  }
  if (EPURE_SYNTHETIC_CHECK_NAMES.has(clean)) {
    return true;
  }
  if (
    clean.startsWith("epure ") ||
    clean.startsWith("verify-contract") ||
    clean.includes("verify epure consumer contract")
  ) {
    return true;
  }
  return false;
}

export function discoverExpectedExternalWorkflows(
  input: DiscoverExpectedExternalWorkflowsInput
): readonly ExpectedExternalWorkflow[] {
  const entries: Array<[string, string]> =
    input.workflowFilesMap instanceof Map ||
    typeof (input.workflowFilesMap as ReadonlyMap<string, string>).entries ===
      "function"
      ? Array.from(
          (input.workflowFilesMap as ReadonlyMap<string, string>).entries()
        )
      : Object.entries(
          input.workflowFilesMap as Readonly<Record<string, string>>
        );

  const cleanChanged = input.changedPaths
    .map((p) => p.trim().replace(/^\/+/, ""))
    .filter((p) => p.length > 0);

  const expected: ExpectedExternalWorkflow[] = [];

  for (const [rawPath, content] of entries) {
    if (typeof content !== "string") {
      continue;
    }
    const normalizedPath = rawPath.startsWith(".github/workflows/")
      ? rawPath
      : `.github/workflows/${rawPath.replace(/^\/+/, "")}`;
    const fileName = basename(normalizedPath);
    if (!/\.ya?ml$/i.test(fileName)) {
      continue;
    }

    if (isEpureManagedWorkflow(normalizedPath, content)) {
      continue;
    }

    const parsed = parseWorkflowOnTriggersAndFilters(content);
    if (parsed.triggers.length === 0) {
      continue;
    }

    // Check targetBranch against branchesInclude if only pull_request trigger is used
    if (
      input.targetBranch &&
      parsed.branchesInclude.length > 0 &&
      !parsed.triggers.includes("push")
    ) {
      const branchMatched = parsed.branchesInclude.some((pat) =>
        matchesPathPattern(input.targetBranch!, pat)
      );
      if (!branchMatched) {
        continue;
      }
    }

    // Check pathsInclude filter
    if (parsed.pathsInclude.length > 0 && cleanChanged.length > 0) {
      const anyPathMatches = cleanChanged.some((filePath) =>
        parsed.pathsInclude.some((pat) => matchesPathPattern(filePath, pat))
      );
      if (!anyPathMatches) {
        continue;
      }
    }

    // Check pathsIgnore filter
    if (parsed.pathsIgnore.length > 0 && cleanChanged.length > 0) {
      const allIgnored = cleanChanged.every((filePath) =>
        parsed.pathsIgnore.some((pat) => matchesPathPattern(filePath, pat))
      );
      if (allIgnored) {
        continue;
      }
    }

    expected.push({
      path: normalizedPath,
      fileName,
      workflowName: parsed.workflowName,
      triggers: parsed.triggers,
      hasServices: parsed.hasServices
    });
  }

  return expected;
}

export function classifyCiFailure(
  input: ClassifyCiFailureInput
): CiFailureClassification {
  const maxReruns = input.maxInfraRerunsPerSha ?? 1;
  const combinedAnnotationText = (input.annotations ?? [])
    .map((a) => `${a.title ?? ""} ${a.message ?? ""}`)
    .join("\n");
  const fullDiagnosticText = `${input.rawLog}\n${combinedAnnotationText}`;

  const hasTestOrCodeFailure = TEST_OR_CODE_FAILURE_PATTERNS.some((re) =>
    re.test(fullDiagnosticText)
  );

  if (hasTestOrCodeFailure) {
    return {
      classification: "code_or_test_failure",
      shouldRerunWorkflow: false,
      reason:
        "Test assertion or compiler failure marker detected in check logs/annotations."
    };
  }

  const hasTransientInfraMarker =
    TRANSIENT_INFRA_PATTERNS.some((re) => re.test(fullDiagnosticText)) ||
    (input.conclusion === "timed_out" && fullDiagnosticText.trim().length === 0);

  if (!hasTransientInfraMarker) {
    return {
      classification: "code_or_test_failure",
      shouldRerunWorkflow: false,
      reason: "Check run failed without transient infrastructure signature."
    };
  }

  if (input.infraRerunsUsedForSha >= maxReruns) {
    return {
      classification: "code_or_test_failure",
      shouldRerunWorkflow: false,
      reason: `Transient infrastructure signature detected, but rerun quota (${input.infraRerunsUsedForSha}/${maxReruns}) is already exhausted for SHA ${input.headSha.slice(0, 7)}.`
    };
  }

  return {
    classification: "transient_infra",
    shouldRerunWorkflow: true,
    reason: `Transient infrastructure failure detected with zero test assertion failures (rerun ${input.infraRerunsUsedForSha + 1}/${maxReruns} for SHA ${input.headSha.slice(0, 7)}).`
  };
}

export function sanitizeAndFormatFailedCheckLogs(
  input: SanitizeCheckLogsInput
): SanitizedCheckLogResult {
  const maxBytes = input.maxBytes ?? 12_288;
  const secrets = input.extraSecrets ?? [];

  let neutralizedCount = 0;
  const neutralizeCommands = (text: string): string =>
    text.replace(GHA_WORKFLOW_COMMAND_REGEX, (_match, cmdName: string) => {
      neutralizedCount += 1;
      return `:[${cmdName.toLowerCase()}]`;
    });

  // 1. Format GitHub Check annotations
  const annotationLines: string[] = [];
  for (const ann of (input.annotations ?? []).slice(0, 25)) {
    const loc = ann.path
      ? `${ann.path}${ann.start_line ? `:${ann.start_line}` : ""}`
      : "check";
    const titlePart = ann.title ? `${ann.title}: ` : "";
    const msgPart = ann.message ?? "";
    const rawAnn = `[Annotation] ${loc} — ${titlePart}${msgPart}`.trim();
    annotationLines.push(neutralizeCommands(rawAnn.replace(ANSI_ESCAPE_REGEX, "")));
  }

  // 2. Clean raw log (strip ANSI, strip ISO timestamps, neutralize :: commands)
  const strippedLog = neutralizeCommands(
    input.rawLog
      .replace(ANSI_ESCAPE_REGEX, "")
      .replace(ISO_TIMESTAMP_PREFIX_REGEX, "")
  );

  const rawLines = strippedLog
    .split(/\r?\n/)
    .filter((line) => !COVERAGE_TABLE_ROW_REGEX.test(line));
  // Truncate GitHub Actions post-job cleanup & service container teardown dumps
  // (e.g. `Post job cleanup.` / `Stop containers` dumping thousands of lines of `docker logs`)
  const postJobCleanupIdx = rawLines.findIndex((line) =>
    /^(?:Post job cleanup\.|##\[group\]Stop containers\b|Stop and remove container:)/.test(
      line.trim()
    )
  );
  const allLines =
    postJobCleanupIdx > 0 ? rawLines.slice(0, postJobCleanupIdx) : rawLines;
  const selectedIndices = new Set<number>();

  // Extract lines around failure markers (-5 .. +18 lines), ignoring structured app logger lines
  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i] ?? "";
    if (APP_LOGGER_NOISE_REGEX.test(line)) {
      continue;
    }
    if (LOG_FAILURE_ANCHOR_REGEX.test(line)) {
      const start = Math.max(0, i - 5);
      const end = Math.min(allLines.length - 1, i + 18);
      for (let idx = start; idx <= end; idx += 1) {
        selectedIndices.add(idx);
      }
    }
  }

  // Also include the last 120 lines
  const tailStart = Math.max(0, allLines.length - 120);
  for (let idx = tailStart; idx < allLines.length; idx += 1) {
    selectedIndices.add(idx);
  }

  const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
  const excerptLines: string[] = [];
  let prevIdx = -1;
  for (const idx of sortedIndices) {
    if (prevIdx !== -1 && idx > prevIdx + 1) {
      excerptLines.push("... [log lines omitted] ...");
    }
    excerptLines.push(allLines[idx] ?? "");
    prevIdx = idx;
  }

  const header = `### External CI Failure: ${input.checkName}${input.htmlUrl ? ` (${input.htmlUrl})` : ""}`;
  const sections: string[] = [header];
  if (annotationLines.length > 0) {
    sections.push("#### Check Annotations", ...annotationLines);
  }
  if (excerptLines.length > 0 && excerptLines.some((l) => l.trim().length > 0)) {
    sections.push("#### Job Log Excerpt", ...excerptLines);
  }

  const combinedRaw = sections.join("\n");
  const redacted = redactSecrets(combinedRaw, secrets);
  const bounded =
    redacted.length > maxBytes ? redacted.slice(-maxBytes) : redacted;

  const wrapped = wrapUntrustedContent(
    "untrusted_test_output",
    bounded,
    maxBytes
  );

  return {
    sanitizedExcerpt: bounded,
    wrappedUntrustedOutput: wrapped,
    neutralizedWorkflowCommands: neutralizedCount
  };
}

export const getFailedCheckRunLogs = sanitizeAndFormatFailedCheckLogs;

function isFailedConclusion(conclusion: string | null | undefined): boolean {
  const norm = (conclusion ?? "").trim().toLowerCase();
  return (
    norm === "failure" ||
    norm === "timed_out" ||
    norm === "cancelled" ||
    norm === "action_required" ||
    norm === "startup_failure"
  );
}

export async function waitForExternalCiChecks(
  input: WaitForExternalCiChecksInput
): Promise<WaitForExternalCiChecksResult> {
  if (input.waitForExternalCi === false) {
    return {
      passed: true,
      reason: "disabled_by_config",
      infraRerunsTriggered: 0,
      failedChecks: [],
      formattedDiagnostics: "",
      registeredWorkflowNames: [],
      registeredCheckNames: []
    };
  }

  const timeoutMs = (input.timeoutMinutes ?? 15) * 60 * 1000;
  const graceWindowMs = (input.graceWindowSeconds ?? 45) * 1000;
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  const sleepFn =
    input.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let simulatedElapsedMs = 0;
  const startWallMs = input.nowFn ? input.nowFn() : Date.now();
  const getElapsedMs = (): number => {
    if (input.nowFn) {
      return Math.max(simulatedElapsedMs, input.nowFn() - startWallMs);
    }
    return simulatedElapsedMs;
  };

  const infraRerunsMap = input.infraRerunsBySha ?? new Map<string, number>();
  let infraRerunsTriggered = 0;
  let pollIndex = 0;

  while (true) {
    pollIndex += 1;
    const elapsedMs = getElapsedMs();

    if (
      input.remainingWallClockMs !== undefined &&
      elapsedMs >= input.remainingWallClockMs
    ) {
      return {
        passed: false,
        reason: "wall_clock_budget_exhausted",
        infraRerunsTriggered,
        failedChecks: [],
        formattedDiagnostics: `Runner wall-clock budget exhausted after ${Math.round(elapsedMs / 1000)}s while waiting for external CI checks on ${input.headSha.slice(0, 7)}.`,
        registeredWorkflowNames: [],
        registeredCheckNames: []
      };
    }

    const [allWorkflowRuns, allCheckRuns] = await Promise.all([
      input.listWorkflowRunsForSha(input.headSha),
      input.listCheckRunsForRef(input.headSha)
    ]);

    const externalWorkflowRuns = allWorkflowRuns.filter(
      (r) => !isEpureSyntheticCheckOrRun(r.path ?? r.name ?? "")
    );
    const externalCheckRuns = allCheckRuns.filter(
      (c) => !isEpureSyntheticCheckOrRun(c.name)
    );

    const registeredWorkflowNames = externalWorkflowRuns.map(
      (r) => r.name ?? r.path ?? `run-${r.id}`
    );
    const registeredCheckNames = externalCheckRuns.map((c) => c.name);

    const totalExternalRegistered =
      externalWorkflowRuns.length + externalCheckRuns.length;

    // 1. If 0 external workflows are expected AND 0 external runs/checks exist -> immediate pass
    if (
      input.expectedWorkflows.length === 0 &&
      totalExternalRegistered === 0
    ) {
      return {
        passed: true,
        reason: "no_external_workflows",
        infraRerunsTriggered,
        failedChecks: [],
        formattedDiagnostics: "",
        registeredWorkflowNames: [],
        registeredCheckNames: []
      };
    }

    // 2. If expectedWorkflows > 0 but 0 external runs/checks have registered yet -> 45s grace window (fail-closed)
    if (
      input.expectedWorkflows.length > 0 &&
      totalExternalRegistered === 0
    ) {
      if (elapsedMs >= graceWindowMs) {
        const expectedNames = input.expectedWorkflows.map((w) =>
          typeof w === "string" ? w : w.path
        );
        return {
          passed: false,
          reason: "grace_window_timeout",
          infraRerunsTriggered,
          failedChecks: [],
          formattedDiagnostics: `Fail-closed: 0 external workflow runs or check runs registered on SHA ${input.headSha.slice(0, 7)} after ${Math.round(graceWindowMs / 1000)}s grace window (expected: ${expectedNames.join(", ")}).`,
          registeredWorkflowNames: [],
          registeredCheckNames: []
        };
      }

      await sleepFn(pollIntervalMs);
      simulatedElapsedMs += pollIntervalMs;
      continue;
    }

    // 3. Check overall timeout
    if (elapsedMs > timeoutMs) {
      return {
        passed: false,
        reason: "poll_timeout",
        infraRerunsTriggered,
        failedChecks: [],
        formattedDiagnostics: `External CI timed out after ${Math.round(timeoutMs / 60000)} minutes on SHA ${input.headSha.slice(0, 7)}.`,
        registeredWorkflowNames,
        registeredCheckNames
      };
    }

    const activeWorkflowRuns = externalWorkflowRuns.filter(
      (r) => r.status !== "completed"
    );
    const activeCheckRuns = externalCheckRuns.filter(
      (c) => c.status !== "completed"
    );

    if (input.onProgress) {
      await input.onProgress({
        pollIndex,
        elapsedMs,
        activeWorkflowRuns: activeWorkflowRuns.length,
        completedWorkflowRuns:
          externalWorkflowRuns.length - activeWorkflowRuns.length,
        activeCheckRuns: activeCheckRuns.length,
        completedCheckRuns: externalCheckRuns.length - activeCheckRuns.length,
        infraRerunsTriggered
      });
    }

    // Wait while any registered workflow run or check run is still queued/in_progress
    // Also wait if expectedWorkflows has more workflows than registered workflowRuns while within graceWindow
    const waitingOnMoreExpectedWorkflows =
      externalWorkflowRuns.length > 0 &&
      externalWorkflowRuns.length < input.expectedWorkflows.length &&
      elapsedMs < graceWindowMs;

    if (
      activeWorkflowRuns.length > 0 ||
      activeCheckRuns.length > 0 ||
      waitingOnMoreExpectedWorkflows
    ) {
      await sleepFn(pollIntervalMs);
      simulatedElapsedMs += pollIntervalMs;
      continue;
    }

    // 4. All registered external workflow runs and check runs have status === "completed"
    const failedCheckRuns = externalCheckRuns.filter((c) =>
      isFailedConclusion(c.conclusion)
    );
    const failedWorkflowRuns = externalWorkflowRuns.filter((r) =>
      isFailedConclusion(r.conclusion)
    );

    if (failedCheckRuns.length === 0 && failedWorkflowRuns.length === 0) {
      return {
        passed: true,
        reason: "all_passed",
        infraRerunsTriggered,
        failedChecks: [],
        formattedDiagnostics: "",
        registeredWorkflowNames,
        registeredCheckNames
      };
    }

    // Synthesize failure targets (prefer check runs; fallback to workflow runs if check runs list is empty)
    const failureItems: Array<{
      readonly id: number;
      readonly name: string;
      readonly conclusion: string;
      readonly html_url: string;
    }> =
      failedCheckRuns.length > 0
        ? failedCheckRuns.map((c) => ({
            id: c.id,
            name: c.name,
            conclusion: c.conclusion ?? "failure",
            html_url: c.html_url ?? c.details_url ?? ""
          }))
        : failedWorkflowRuns.map((r) => ({
            id: r.id,
            name: r.name ?? r.path ?? `workflow-${r.id}`,
            conclusion: r.conclusion ?? "failure",
            html_url: r.html_url ?? ""
          }));

    const fetchedFailureDetails = await Promise.all(
      failureItems.map(async (item) => {
        const [annotations, rawLog] = await Promise.all([
          input.listCheckRunAnnotations
            ? input.listCheckRunAnnotations(item.id).catch(() => [])
            : Promise.resolve([]),
          input.getJobLogs
            ? input.getJobLogs(item.id).catch(() => "")
            : Promise.resolve("")
        ]);
        const usedReruns = infraRerunsMap.get(input.headSha) ?? 0;
        const classification = classifyCiFailure({
          conclusion: item.conclusion,
          checkName: item.name,
          rawLog,
          annotations,
          headSha: input.headSha,
          infraRerunsUsedForSha: usedReruns
        });
        return {
          item,
          annotations,
          rawLog,
          classification
        };
      })
    );

    const allTransientInfra =
      fetchedFailureDetails.length > 0 &&
      fetchedFailureDetails.every(
        (d) => d.classification.shouldRerunWorkflow
      );

    if (allTransientInfra && input.rerunFailedJobs) {
      const currentUsed = infraRerunsMap.get(input.headSha) ?? 0;
      infraRerunsMap.set(input.headSha, currentUsed + 1);
      infraRerunsTriggered += 1;

      const runIdsToRerun =
        failedWorkflowRuns.length > 0
          ? failedWorkflowRuns.map((r) => r.id)
          : failureItems.map((f) => f.id);

      for (const runId of runIdsToRerun) {
        await input.rerunFailedJobs(runId);
      }

      await sleepFn(pollIntervalMs);
      simulatedElapsedMs += pollIntervalMs;
      continue;
    }

    // Format sanitized diagnostics for the remediation loop
    const failedChecksSummary: FailedExternalCheckSummary[] = [];
    const diagnosticBlocks: string[] = [];

    for (const detail of fetchedFailureDetails) {
      const sanitized = sanitizeAndFormatFailedCheckLogs({
        checkName: detail.item.name,
        htmlUrl: detail.item.html_url,
        annotations: detail.annotations,
        rawLog: detail.rawLog,
        extraSecrets: input.extraSecrets
      });
      failedChecksSummary.push({
        id: detail.item.id,
        name: detail.item.name,
        conclusion: detail.item.conclusion,
        html_url: detail.item.html_url,
        sanitized_log: sanitized.sanitizedExcerpt,
        wrapped_untrusted_output: sanitized.wrappedUntrustedOutput
      });
      diagnosticBlocks.push(sanitized.wrappedUntrustedOutput);
    }

    return {
      passed: false,
      reason: "check_failure",
      infraRerunsTriggered,
      failedChecks: failedChecksSummary,
      formattedDiagnostics: diagnosticBlocks.join("\n\n"),
      registeredWorkflowNames,
      registeredCheckNames
    };
  }
}

export function formatNeedsHumanEscalationComment(
  input: FormatNeedsHumanEscalationInput
): string {
  const ticketRef = input.ticketIssueNumber
    ? `Ticket #${input.ticketIssueNumber} (Plan #${input.issueNumber})`
    : `Issue #${input.issueNumber}`;
  const prRef =
    input.prNumber && input.prUrl
      ? ` — [PR #${input.prNumber}](${input.prUrl})`
      : input.prNumber
        ? ` — PR #${input.prNumber}`
        : "";

  let reasonHeadline = "";
  if (input.reason === "remediation_exhausted") {
    const used = input.codeFixAttemptsUsed ?? 3;
    const max = input.maxCodeFixAttempts ?? 3;
    reasonHeadline = `\`${used}/${max}\` remediation rounds exhausted (\`max_code_fix_attempts = ${max}\`)`;
  } else if (input.reason === "grace_window_timeout") {
    const gw = input.graceWindowSeconds ?? 45;
    reasonHeadline = `${gw}s external CI workflow registration timeout (fail-closed)`;
  } else if (input.reason === "sensitive_path_violation") {
    reasonHeadline =
      "Forbidden modification of sensitive path or path traversal blocked pre-Stage-1";
  } else if (input.reason === "transient_llm_api_exhausted") {
    reasonHeadline =
      "Transient LLM API retries or unitary request timeout exhausted (`max_transient_api_retries`) — code-fix budget preserved";
  } else if (input.reason === "llm_quota_or_auth_failure") {
    reasonHeadline =
      "LLM provider quota/billing exhaustion or authentication failure (ADR-0012: no automatic fallback)";
  } else if (input.reason === "llm_request_invalid") {
    reasonHeadline =
      "LLM request rejected or response invalid after structured-output retry (non-transient) — code-fix budget preserved";
  } else if (input.reason === "internal_error") {
    reasonHeadline =
      "Internal orchestrator error — code-fix budget preserved";
  } else {
    reasonHeadline = "Runner wall-clock timeout budget exhausted";
  }

  const lines: string[] = [];
  if (input.stateMirrorMarkdown) {
    lines.push(input.stateMirrorMarkdown, "");
  }

  lines.push(
    `### ⚠️ Escalade humaine (\`needs-human\`) — ${ticketRef}${prRef}`,
    "",
    `- **Branche active** : \`${input.branch}\``,
    `- **Statut d'orchestration** : \`suspended\` (label \`needs-human\` appliqué)`,
    `- **Cause de l'escalade** : ${reasonHeadline}`
  );

  if (input.prUrl) {
    lines.push(`- **Pull Request** : ${input.prUrl}`);
  }

  if (
    input.sensitivePaths &&
    input.sensitivePaths.length > 0
  ) {
    lines.push(
      `- **Chemins sensibles bloqués** : ${input.sensitivePaths.map((p) => `\`${p}\``).join(", ")}`
    );
  }

  if (
    input.traversalPaths &&
    input.traversalPaths.length > 0
  ) {
    lines.push(
      `- **Chemins hors périmètre bloqués** : ${input.traversalPaths.map((p) => `\`${p}\``).join(", ")}`
    );
  }

  if (
    input.expectedWorkflows &&
    input.expectedWorkflows.length > 0 &&
    input.reason === "grace_window_timeout"
  ) {
    lines.push(
      `- **Workflows externes attendus depuis \`dev\`** : ${input.expectedWorkflows.map((w) => `\`${w}\``).join(", ")}`
    );
  }

  if (input.failedChecks && input.failedChecks.length > 0) {
    lines.push("", "#### Checks CI externes en échec :");
    for (const check of input.failedChecks) {
      const link = check.html_url
        ? `[${check.name}](${check.html_url})`
        : `\`${check.name}\``;
      lines.push(`- ❌ ${link} (\`${check.conclusion}\`)`);
    }
  }

  if (input.mustFixFindings && input.mustFixFindings.length > 0) {
    lines.push("", "#### Constats `must_fix` restants (Revue Multi-Agents) :");
    for (const f of input.mustFixFindings) {
      lines.push(
        `- **[${f.reviewer}]** (\`${f.path}:${f.line}\`) **${f.title}** — ${f.rationale}`
      );
    }
  }

  if (input.diagnosticExcerpt && input.diagnosticExcerpt.trim().length > 0) {
    lines.push(
      "",
      "<details>",
      "<summary>📋 Diagnostic CI & extrait des journaux assainis</summary>",
      "",
      "```text",
      input.diagnosticExcerpt.trim().slice(0, 6000),
      "```",
      "</details>"
    );
  }

  lines.push(
    "",
    "#### 🛠️ Playbook de reprise (`/epure approve`)",
    "1. Inspectez les checks ou fichiers signalés ci-dessus (ou ajustez `verification.targets` dans `.github/agents.yml` sur `dev` si nécessaire).",
    `2. Poussez un correctif sur \`${input.branch}\` ou mettez à jour la configuration sur \`dev\`.`,
    `3. Postez \`/epure approve\` sur cette issue (#${input.issueNumber}) : l'orchestrateur réconciliera automatiquement la PR existante et reprendra la validation sans dupliquer le travail (ADR-0028, Q110).`
  );

  return appendEpureCommandsSpoiler(lines.join("\n"), {
    phase: "suspended",
    status: "suspended",
    issueNumber: input.issueNumber
  });
}
