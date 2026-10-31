import {
  discoverVerificationProfile,
  type VerificationProfile
} from "../../bootstrap/ci-and-renovate.js";
import type { WebToolsConfig } from "../../bootstrap/setup-repo.js";
import type {
  SandboxExecutionInput,
  SandboxExecutionResult
} from "../../sandbox/llm-sandbox.js";
import {
  isSensitiveTaskBranchPath,
  runPolyglotStage1Verification
} from "../../sandbox/polyglot-workspace-runner.js";
import { wrapUntrustedContent } from "../../security/prompt-injection-guard.js";
import type {
  GeminiFunctionDeclaration,
  GeminiToolHandler
} from "../gemini-client.js";
import type {
  EpicGoalContract,
  GeneratedTicketImplementation,
  GitHubRestHelper,
  IssueCommentRecord,
  TrackedTicketCommentMetadata
} from "../types.js";
import {
  buildWebExplorationToolsAndHandlers,
  type WebToolsPhase
} from "./web-tools.js";

export type TicketIntegrityViolationCategory =
  | "unauthorized_test_deletion"
  | "out_of_scope_file_truncation"
  | "verification_script_degradation";

export interface TicketIntegrityViolation {
  readonly kind: TicketIntegrityViolationCategory;
  readonly path: string;
  readonly details: string;
}

export interface ValidateTicketIntegrityGuardInput {
  readonly baseFiles: ReadonlyMap<string, string>;
  readonly changedFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly deletedFiles?: readonly string[] | undefined;
  readonly ticketFilesToTouch: readonly string[];
  readonly ticketDescription?: string | undefined;
}

export interface TicketIntegrityCheckResult {
  readonly passed: boolean;
  readonly violations: readonly TicketIntegrityViolation[];
  readonly diagnosticMarkdown: string;
}

export type ValidateTicketIntegrityGuardResult = TicketIntegrityCheckResult;

const GUARDED_VERIFICATION_KEYS = [
  "build",
  "test",
  "lint",
  "typecheck",
  "check"
] as const;

function createIntegrityViolation(
  kind: TicketIntegrityViolationCategory,
  path: string,
  details: string
): TicketIntegrityViolation {
  return {
    kind,
    path,
    details
  };
}

function isTestFilePath(filePath: string): boolean {
  const clean = filePath.trim().replace(/^\/+/, "");
  const baseName = clean.split("/").pop() ?? clean;
  return (
    /(?:^|\/)(?:__tests__|tests?|specs?)\//i.test(clean) ||
    /(?:\.test|\.spec|_test|_spec)\.[a-z0-9]+$/i.test(baseName) ||
    /^test_[^/]+\.py$/i.test(baseName)
  );
}

function isNoopStubCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) {
    return true;
  }
  return /^\s*(?:@?echo\b|true\b|:\s*$|exit\s+0\b)/i.test(trimmed);
}

function isUnitTestOnlyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  return (
    /\b(?:vitest|jest|mocha|pytest|unittest|cargo\s+test|go\s+test|node\s+--test)\b/i.test(
      trimmed
    ) &&
    !/\b(?:tsc|vite\s+build|next\s+build|tsup|esbuild|webpack|rollup|cargo\s+build|go\s+build|poetry\s+build|hatch\s+build|maturin\s+build|python\s+-m\s+build)\b/i.test(
      trimmed
    )
  );
}

function extractTomlVerificationScripts(tomlContent: string): Map<string, string> {
  const scripts = new Map<string, string>();
  let currentSection = "";
  for (const rawLine of tomlContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch?.[1]) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const isScriptOrAliasSection =
      currentSection === "package" ||
      currentSection === "alias" ||
      currentSection === "scripts" ||
      currentSection.endsWith(".scripts") ||
      currentSection.endsWith(".tasks") ||
      currentSection.endsWith(".alias");
    if (!isScriptOrAliasSection) {
      continue;
    }
    const kvMatch =
      /^(build|test|lint|typecheck|check)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{[^}]*cmd\s*=\s*"([^"]*)"[^}]*\})/.exec(
        line
      );
    if (kvMatch?.[1]) {
      const key = kvMatch[1].toLowerCase();
      const val = (kvMatch[2] ?? kvMatch[3] ?? kvMatch[4] ?? "").trim();
      if (currentSection === "package" && key !== "build") {
        continue;
      }
      scripts.set(key, val);
    }
  }
  return scripts;
}

function evaluateManifestScriptMapDegradation(params: {
  readonly cleanPath: string;
  readonly baseMap: ReadonlyMap<string, string>;
  readonly newMap: ReadonlyMap<string, string>;
  readonly violations: TicketIntegrityViolation[];
}): void {
  for (const key of GUARDED_VERIFICATION_KEYS) {
    const baseCmd = (params.baseMap.get(key) ?? "").trim();
    if (!baseCmd || isNoopStubCommand(baseCmd)) {
      continue;
    }
    const newCmd = (params.newMap.get(key) ?? "").trim();
    if (!newCmd || isNoopStubCommand(newCmd)) {
      params.violations.push(
        createIntegrityViolation(
          "verification_script_degradation",
          params.cleanPath,
          `Manifest '${params.cleanPath}' degraded verification command '${key}' from '${baseCmd}' to '${newCmd || "<deleted>"}'. Replacing verification scripts with echo/true stubs is strictly forbidden (ADR-0032, Q113).`
        )
      );
      continue;
    }
    if (key === "build" && !isUnitTestOnlyCommand(baseCmd)) {
      const newTestCmd = (
        params.newMap.get("test") ??
        params.baseMap.get("test") ??
        ""
      ).trim();
      if (
        isUnitTestOnlyCommand(newCmd) ||
        (newTestCmd.length > 0 && newCmd === newTestCmd)
      ) {
        params.violations.push(
          createIntegrityViolation(
            "verification_script_degradation",
            params.cleanPath,
            `Manifest '${params.cleanPath}' degraded 'build' command from '${baseCmd}' to unit-test command '${newCmd}'. Preserve the real build/compilation command (ADR-0032, Q113).`
          )
        );
      }
    }
  }
}

function countNonEmptyLines(content: string): number {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("#"))
    .length;
}

function countPublicSymbolDeclarations(content: string): number {
  const matches = content.match(
    /^\s*(?:export\s+(?:async\s+)?(?:function|class|const|let|type|interface|enum)\b|pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|mod)\b|def\s+[A-Za-z0-9_]+\s*\(|func\s+[A-Z][A-Za-z0-9_]*\s*\()/gm
  );
  return matches ? matches.length : 0;
}

function isDirectBarrelNeighbor(
  filePath: string,
  ticketFilesToTouch: readonly string[]
): boolean {
  const clean = filePath.trim().replace(/^\/+/, "").toLowerCase();
  const baseName = clean.split("/").pop() ?? clean;
  if (
    !/^(?:index\.[a-z0-9]+|mod\.rs|lib\.rs|__init__\.py)$/i.test(baseName)
  ) {
    return false;
  }
  const barrelDir = clean.includes("/")
    ? clean.slice(0, clean.lastIndexOf("/"))
    : "";
  return ticketFilesToTouch.some((rawTarget) => {
    const target = rawTarget.trim().replace(/^\/+/, "").toLowerCase();
    const targetDir = target.includes("/")
      ? target.slice(0, target.lastIndexOf("/"))
      : "";
    return (
      targetDir === barrelDir ||
      (barrelDir.length > 0 && targetDir.startsWith(`${barrelDir}/`))
    );
  });
}

function isPathInTicketScope(
  filePath: string,
  ticketFilesToTouch: readonly string[]
): boolean {
  const clean = filePath.trim().replace(/^\/+/, "").toLowerCase();
  for (const rawTarget of ticketFilesToTouch) {
    const target = rawTarget.trim().replace(/^\/+/, "").toLowerCase();
    if (!target) {
      continue;
    }
    if (
      clean === target ||
      clean.endsWith(`/${target}`) ||
      target.endsWith(`/${clean}`)
    ) {
      return true;
    }
    if (target.endsWith("/**") || target.endsWith("/*")) {
      const prefix = target.replace(/\/\*+$/, "");
      if (clean.startsWith(`${prefix}/`)) {
        return true;
      }
    }
  }
  return false;
}

export function validateTicketIntegrityGuard(
  input: ValidateTicketIntegrityGuardInput
): TicketIntegrityCheckResult {
  const violations: TicketIntegrityViolation[] = [];
  const deletedList = (input.deletedFiles ?? []).map((p) =>
    p.trim().replace(/^\/+/, "")
  );
  const explicitDeletionAllowedByDescription =
    typeof input.ticketDescription === "string" &&
    /(?:delete|remove|supprim|remplac|renomm|rename|deprecate|obsol)/i.test(
      input.ticketDescription
    );

  // 1. Check unauthorized deletion or emptying of existing test files
  for (const delPath of deletedList) {
    if (!input.baseFiles.has(delPath)) {
      continue;
    }
    if (isTestFilePath(delPath)) {
      const inScope = isPathInTicketScope(delPath, input.ticketFilesToTouch);
      if (!inScope || !explicitDeletionAllowedByDescription) {
        violations.push(
          createIntegrityViolation(
            "unauthorized_test_deletion",
            delPath,
            `Existing test file '${delPath}' cannot be deleted by a ticket unless explicitly targeted for removal/replacement in the ticket scope (ADR-0032, Q113).`
          )
        );
      }
    }
  }

  for (const file of input.changedFiles) {
    const cleanPath = file.path.trim().replace(/^\/+/, "");
    const baseContent = input.baseFiles.get(cleanPath);
    if (baseContent === undefined) {
      continue;
    }

    const baseNonEmptyLines = countNonEmptyLines(baseContent);
    const newNonEmptyLines = countNonEmptyLines(file.content);

    if (
      isTestFilePath(cleanPath) &&
      ((baseNonEmptyLines >= 1 && newNonEmptyLines === 0) ||
        (baseNonEmptyLines >= 5 &&
          newNonEmptyLines < Math.ceil(baseNonEmptyLines * 0.4)))
    ) {
      const inScope = isPathInTicketScope(cleanPath, input.ticketFilesToTouch);
      if (!inScope || !explicitDeletionAllowedByDescription) {
        violations.push(
          createIntegrityViolation(
            "unauthorized_test_deletion",
            cleanPath,
            `Existing test file '${cleanPath}' lost ${baseNonEmptyLines - newNonEmptyLines}/${baseNonEmptyLines} non-empty lines. Tickets must preserve existing regression tests from prior tickets and base branch (ADR-0032, Q113).`
          )
        );
        continue;
      }
    }

    // 2. Check out-of-scope file truncation (> 30% lines or public symbols lost on existing files outside filesToTouch)
    const inScope =
      input.ticketFilesToTouch.length === 0 ||
      isPathInTicketScope(cleanPath, input.ticketFilesToTouch) ||
      isDirectBarrelNeighbor(cleanPath, input.ticketFilesToTouch);
    if (!inScope && baseNonEmptyLines >= 15) {
      const baseSymbols = countPublicSymbolDeclarations(baseContent);
      const newSymbols = countPublicSymbolDeclarations(file.content);
      const lineRatio = newNonEmptyLines / baseNonEmptyLines;
      const symbolRatio = baseSymbols >= 3 ? newSymbols / baseSymbols : 1;

      if (lineRatio < 0.7 || symbolRatio < 0.7) {
        violations.push(
          createIntegrityViolation(
            "out_of_scope_file_truncation",
            cleanPath,
            `Out-of-scope file '${cleanPath}' (not in ticket filesToTouch) was truncated from ${baseNonEmptyLines} to ${newNonEmptyLines} non-empty lines (${baseSymbols} -> ${newSymbols} public symbols). Use surgical patches and preserve existing code outside ticket scope (ADR-0032, Q113).`
          )
        );
      }
    }

    // 3. Check verification script degradation in manifests (package.json, Makefile, Justfile, pyproject.toml, Cargo.toml)
    const lowerName = (cleanPath.split("/").pop() ?? cleanPath).toLowerCase();
    if (lowerName === "package.json") {
      try {
        const basePkg = JSON.parse(baseContent) as {
          scripts?: Record<string, unknown>;
        };
        const newPkg = JSON.parse(file.content) as {
          scripts?: Record<string, unknown>;
        };
        const baseMap = new Map<string, string>();
        const newMap = new Map<string, string>();
        for (const key of GUARDED_VERIFICATION_KEYS) {
          if (typeof basePkg.scripts?.[key] === "string") {
            baseMap.set(key, basePkg.scripts[key]);
          }
          if (typeof newPkg.scripts?.[key] === "string") {
            newMap.set(key, newPkg.scripts[key]);
          }
        }
        evaluateManifestScriptMapDegradation({
          cleanPath,
          baseMap,
          newMap,
          violations
        });
      } catch {
        // Ignore malformed JSON here; Stage 1 will catch syntax errors
      }
    } else if (lowerName === "makefile" || lowerName === "justfile") {
      const targetRegex =
        /^(build|test|lint|typecheck|check)\s*:[^\n]*\n((?:[ \t]+[^\n]+\n?)+)/gm;
      const baseTargets = new Map<string, string>();
      let m: RegExpExecArray | null;
      while ((m = targetRegex.exec(baseContent)) !== null) {
        if (m[1] && m[2]) {
          baseTargets.set(
            m[1].toLowerCase(),
            m[2]
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .join(" && ")
          );
        }
      }
      targetRegex.lastIndex = 0;
      const newTargets = new Map<string, string>();
      while ((m = targetRegex.exec(file.content)) !== null) {
        if (m[1] && m[2]) {
          newTargets.set(
            m[1].toLowerCase(),
            m[2]
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .join(" && ")
          );
        }
      }
      evaluateManifestScriptMapDegradation({
        cleanPath,
        baseMap: baseTargets,
        newMap: newTargets,
        violations
      });
    } else if (lowerName === "pyproject.toml" || lowerName === "cargo.toml") {
      const baseScripts = extractTomlVerificationScripts(baseContent);
      const newScripts = extractTomlVerificationScripts(file.content);
      evaluateManifestScriptMapDegradation({
        cleanPath,
        baseMap: baseScripts,
        newMap: newScripts,
        violations
      });
    }
  }

  const diagnosticMarkdown =
    violations.length === 0
      ? ""
      : [
          "[EPURE][TicketIntegrityGuard] Inter-ticket integrity violation(s) blocked pre-commit (ADR-0032, Q113):",
          ...violations.map(
            (v) => `- [${v.kind}] (${v.path}): ${v.details}`
          ),
          "Restore the deleted tests, truncated out-of-scope code, or degraded manifest scripts while implementing the ticket requirements."
        ].join("\n");

  return {
    passed: violations.length === 0,
    violations,
    diagnosticMarkdown
  };
}

export async function applyTicketImplementationPayload(params: {
  readonly parsed: GeneratedTicketImplementation;
  readonly accumulatedFiles: Map<string, string>;
  readonly featureChangedFilesMap: Map<string, string>;
  readonly ticketChangedFilesMap: Map<string, string>;
  readonly featureDeletedFilesSet?: Set<string> | undefined;
  readonly ticketDeletedFilesSet?: Set<string> | undefined;
  readonly gh: GitHubRestHelper;
  readonly branch: string;
}): Promise<Array<{ path: string; content: string }>> {
  for (const f of params.parsed.files ?? []) {
    const cleanPath = f.path.replace(/^\/+/, "");
    params.accumulatedFiles.set(cleanPath, f.content);
    params.featureChangedFilesMap.set(cleanPath, f.content);
    params.ticketChangedFilesMap.set(cleanPath, f.content);
    params.featureDeletedFilesSet?.delete(cleanPath);
    params.ticketDeletedFilesSet?.delete(cleanPath);
  }

  for (const del of params.parsed.deleted_files ?? []) {
    const cleanPath = del.replace(/^\/+/, "");
    params.accumulatedFiles.delete(cleanPath);
    params.featureChangedFilesMap.delete(cleanPath);
    params.ticketChangedFilesMap.delete(cleanPath);
    params.featureDeletedFilesSet?.add(cleanPath);
    params.ticketDeletedFilesSet?.add(cleanPath);
  }

  for (const patch of params.parsed.patches ?? []) {
    const cleanPath = patch.path.replace(/^\/+/, "");
    let baseContent = params.accumulatedFiles.get(cleanPath) ?? null;
    if (baseContent === null) {
      baseContent = await params.gh.readSingleBranchFile(
        params.branch,
        cleanPath
      );
    }
    if (baseContent === null) {
      continue;
    }
    let updatedContent = baseContent;
    let appliedAny = false;
    for (const edit of patch.edits ?? []) {
      const oldStr = edit.old_string || edit.search || "";
      const newStr = edit.new_string ?? edit.replace ?? "";
      if (!oldStr) {
        continue;
      }
      if (updatedContent.includes(oldStr)) {
        updatedContent = updatedContent.replace(oldStr, newStr);
        appliedAny = true;
        continue;
      }
      const normalizedOld = oldStr.replace(/\r\n/g, "\n").trim();
      const normalizedDoc = updatedContent.replace(/\r\n/g, "\n");
      if (normalizedOld && normalizedDoc.includes(normalizedOld)) {
        updatedContent = normalizedDoc.replace(
          normalizedOld,
          newStr.replace(/\r\n/g, "\n").trim()
        );
        appliedAny = true;
      } else if (process.env.GITHUB_ACTIONS === "true") {
        process.stdout.write(
          `[EPURE][Patch] Warning: edit old_string (${oldStr.length} chars) did not match in ${cleanPath}\n`
        );
      }
    }
    if (!appliedAny && (patch.edits?.length ?? 0) > 0) {
      continue;
    }
    params.accumulatedFiles.set(cleanPath, updatedContent);
    params.featureChangedFilesMap.set(cleanPath, updatedContent);
    params.ticketChangedFilesMap.set(cleanPath, updatedContent);
    params.featureDeletedFilesSet?.delete(cleanPath);
    params.ticketDeletedFilesSet?.delete(cleanPath);
  }

  return Array.from(params.ticketChangedFilesMap.entries()).map(
    ([path, content]) => ({ path, content })
  );
}

export interface ParsedPlanManifestFromComments {
  readonly planBranch?: string | undefined;
  readonly specPath?: string | undefined;
  readonly epicGoalContract?: EpicGoalContract | undefined;
  readonly tickets: TrackedTicketCommentMetadata[];
}

export function parsePlanManifestFromComments(
  comments: readonly IssueCommentRecord[]
): ParsedPlanManifestFromComments | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body ?? "";
    const match = /<!-- epure-plan-manifest:([\s\S]*?)-->/.exec(body);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim()) as {
          planBranch?: string;
          specPath?: string;
          epicGoalContract?: EpicGoalContract;
          tickets?: TrackedTicketCommentMetadata[];
        };
        if (Array.isArray(parsed.tickets) && parsed.tickets.length > 0) {
          return {
            ...(typeof parsed.planBranch === "string"
              ? { planBranch: parsed.planBranch }
              : {}),
            ...(typeof parsed.specPath === "string"
              ? { specPath: parsed.specPath }
              : {}),
            ...(parsed.epicGoalContract
              ? { epicGoalContract: parsed.epicGoalContract }
              : {}),
            tickets: parsed.tickets
          };
        }
      } catch {
        // continue
      }
    }
  }
  return null;
}

export function parseTrackedTicketsFromComments(
  comments: readonly IssueCommentRecord[]
): TrackedTicketCommentMetadata[] {
  return parsePlanManifestFromComments(comments)?.tickets ?? [];
}

export async function runTestsInIsolatedWorkspace(params: {
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly deleted_files?: readonly string[] | undefined;
  readonly changedPaths?: readonly string[] | undefined;
  readonly isTaskBranch?: boolean | undefined;
  readonly verificationProfile?: VerificationProfile | undefined;
  readonly workDir?: string | undefined;
  readonly bootstrappedTargets?: Set<string> | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly llmApiKey: string;
  readonly label?: string | undefined;
}): Promise<{
  readonly passed: boolean;
  readonly output: string;
  readonly blocked_by_security_gate?: boolean;
  readonly sensitive_paths?: readonly string[];
  readonly traversal_paths?: readonly string[];
}> {
  const isGha = process.env.GITHUB_ACTIONS === "true";
  const groupTitle = params.label
    ? `[EPURE][Sandbox] ${params.label}`
    : "[EPURE][Sandbox] Verify Polyglot Stage 1 Suite";
  if (isGha) {
    process.stdout.write(`::group::${groupTitle}\n`);
  }
  try {
    const profile =
      params.verificationProfile ??
      discoverVerificationProfile({
        targetFilesHint: params.files.map((f) => f.path)
      });

    const stage1Result = await runPolyglotStage1Verification({
      workDir: params.workDir,
      profile,
      files: params.files,
      deleted_files: params.deleted_files,
      changedPaths: params.changedPaths,
      isTaskBranch: params.isTaskBranch,
      llmApiKey: params.llmApiKey,
      bootstrappedTargets: params.bootstrappedTargets,
      sandboxRunner: params.sandboxRunner,
      label: params.label
    });

    if (isGha) {
      process.stdout.write(
        `[EPURE][Sandbox] Stage 1 -> ${stage1Result.passed ? "PASSED" : "FAILED"}\n${stage1Result.output.slice(-4000)}\n`
      );
    }

    return {
      passed: stage1Result.passed,
      output: stage1Result.output,
      blocked_by_security_gate: stage1Result.blocked_by_security_gate,
      sensitive_paths: stage1Result.sensitive_paths,
      traversal_paths: stage1Result.traversal_paths
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isGha) {
      process.stdout.write(`[EPURE][Sandbox] ERROR: ${msg}\n`);
    }
    return { passed: false, output: msg };
  } finally {
    if (isGha) {
      process.stdout.write("::endgroup::\n");
    }
  }
}

const SUBPACKAGE_PREFIX_REGEX =
  /^(?:backend|frontend|packages|apps|services|crates)\//;

export function checkIsExistingRepoWorkspace(
  accumulatedFiles: ReadonlyMap<string, string>,
  devBranchPaths: readonly string[]
): boolean {
  return accumulatedFiles.size > 0 || devBranchPaths.length > 0;
}

export function checkIsBrownfieldSubpackageRepo(
  accumulatedFiles: ReadonlyMap<string, string>,
  devBranchPaths: readonly string[]
): boolean {
  return (
    checkIsExistingRepoWorkspace(accumulatedFiles, devBranchPaths) ||
    (accumulatedFiles.size > 0 &&
      !accumulatedFiles.has("package.json") &&
      Array.from(accumulatedFiles.keys()).some((k) =>
        SUBPACKAGE_PREFIX_REGEX.test(k)
      )) ||
    (!devBranchPaths.includes("package.json") &&
      devBranchPaths.some((k) => SUBPACKAGE_PREFIX_REGEX.test(k)))
  );
}

export interface StagedTicketImplementationBuffer {
  readonly files: Map<string, string>;
  readonly deletedFiles: Set<string>;
  readonly hasMutations: () => boolean;
  readonly ensureBaselineLoaded?:
    | ((paths: readonly string[]) => Promise<void>)
    | undefined;
}

export function createStagedTicketImplementationBuffer(
  ensureBaselineLoaded?:
    | ((paths: readonly string[]) => Promise<void>)
    | undefined
): StagedTicketImplementationBuffer {
  const files = new Map<string, string>();
  const deletedFiles = new Set<string>();
  return {
    files,
    deletedFiles,
    hasMutations: () => files.size > 0 || deletedFiles.size > 0,
    ...(ensureBaselineLoaded ? { ensureBaselineLoaded } : {})
  };
}

export function mergeStagedBufferIntoImplementationPayload(
  staged: StagedTicketImplementationBuffer,
  parsed: GeneratedTicketImplementation
): GeneratedTicketImplementation {
  if (!staged.hasMutations()) {
    return parsed;
  }
  const mergedFilesMap = new Map<string, string>();
  const mergedDeletedSet = new Set<string>();

  for (const [path, content] of staged.files.entries()) {
    const clean = path.trim().replace(/^\/+/, "");
    if (clean) {
      mergedFilesMap.set(clean, content);
      mergedDeletedSet.delete(clean);
    }
  }
  for (const del of staged.deletedFiles) {
    const clean = del.trim().replace(/^\/+/, "");
    if (clean) {
      mergedFilesMap.delete(clean);
      mergedDeletedSet.add(clean);
    }
  }
  for (const f of parsed.files ?? []) {
    const clean = f.path.trim().replace(/^\/+/, "");
    if (clean) {
      mergedFilesMap.set(clean, f.content);
      mergedDeletedSet.delete(clean);
    }
  }
  for (const del of parsed.deleted_files ?? []) {
    const clean = del.trim().replace(/^\/+/, "");
    if (clean) {
      mergedFilesMap.delete(clean);
      mergedDeletedSet.add(clean);
    }
  }

  return {
    commit_message: parsed.commit_message,
    test_summary: parsed.test_summary,
    files: Array.from(mergedFilesMap.entries()).map(([path, content]) => ({
      path,
      content
    })),
    ...(parsed.patches && parsed.patches.length > 0
      ? { patches: parsed.patches }
      : {}),
    deleted_files: Array.from(mergedDeletedSet)
  };
}

export interface BuildCompactWorkspaceFilesContextInput {
  readonly accumulatedFiles: ReadonlyMap<string, string>;
  readonly priorityPaths?: Iterable<string> | undefined;
  readonly maxInlineLinesPerFile?: number | undefined;
  readonly maxTotalInlineChars?: number | undefined;
}

export function buildCompactWorkspaceFilesContext(
  input: BuildCompactWorkspaceFilesContextInput
): string {
  const maxLines = input.maxInlineLinesPerFile ?? 400;
  const maxChars = input.maxTotalInlineChars ?? 60_000;

  const priorityNormalized = new Set<string>();
  for (const raw of input.priorityPaths ?? []) {
    const clean = raw.trim().replace(/^\/+/, "");
    if (clean) {
      priorityNormalized.add(clean);
    }
  }

  const isPriorityFile = (filePath: string): boolean => {
    const clean = filePath.trim().replace(/^\/+/, "");
    if (priorityNormalized.has(clean)) {
      return true;
    }
    return isPathInTicketScope(clean, Array.from(priorityNormalized));
  };

  const inlinedBlocks: string[] = [];
  const catalogEntries: string[] = [];
  let usedChars = 0;

  const sortedEntries = Array.from(input.accumulatedFiles.entries()).sort(
    ([a], [b]) => {
      const aPrio = isPriorityFile(a) ? 0 : 1;
      const bPrio = isPriorityFile(b) ? 0 : 1;
      if (aPrio !== bPrio) {
        return aPrio - bPrio;
      }
      return a.localeCompare(b);
    }
  );

  for (const [rawPath, content] of sortedEntries) {
    const cleanPath = rawPath.trim().replace(/^\/+/, "");
    if (!cleanPath || isSensitiveTaskBranchPath(cleanPath)) {
      continue;
    }
    const lineCount = content.split("\n").length;
    const block = `--- FILE: ${cleanPath} ---\n${content}`;
    const shouldInline =
      (priorityNormalized.size === 0 || isPriorityFile(cleanPath)) &&
      lineCount <= maxLines &&
      usedChars + block.length <= maxChars;

    if (shouldInline) {
      inlinedBlocks.push(block);
      usedChars += block.length;
    } else {
      catalogEntries.push(`- ${cleanPath} (${lineCount} lines)`);
    }
  }

  const sections: string[] = [];
  if (inlinedBlocks.length > 0) {
    sections.push(inlinedBlocks.join("\n\n"));
  }
  if (catalogEntries.length > 0) {
    sections.push(
      [
        "--- WORKSPACE FILE CATALOG (use `read_repo_file` or `search_in_repo_file` to inspect full content) ---",
        ...catalogEntries
      ].join("\n")
    );
  }
  return sections.join("\n\n");
}

export function buildRepoExplorationToolsAndHandlers(params: {
  readonly branch: string;
  readonly featureBranch: string;
  readonly accumulatedFiles: Map<string, string>;
  readonly deletedFilesSet?: ReadonlySet<string> | undefined;
  readonly stagedImplementation?: StagedTicketImplementationBuffer | undefined;
  readonly devBranchPaths: readonly string[];
  readonly gh: Pick<
    GitHubRestHelper,
    "readSingleBranchFile" | "listBranchPaths"
  >;
  readonly phase?: WebToolsPhase | undefined;
  readonly webToolsConfig?: WebToolsConfig | undefined;
  readonly alwaysEnableRepoTools?: boolean | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): {
  readonly tools?: readonly GeminiFunctionDeclaration[];
  readonly toolHandlers?: Readonly<Record<string, GeminiToolHandler>>;
} {
  if (
    !params.alwaysEnableRepoTools &&
    !params.stagedImplementation &&
    params.devBranchPaths.length === 0 &&
    params.accumulatedFiles.size === 0 &&
    process.env.GITHUB_ACTIONS !== "true" &&
    params.webToolsConfig === undefined
  ) {
    return {};
  }

  const webExploration = buildWebExplorationToolsAndHandlers({
    phase: params.phase,
    webToolsConfig: params.webToolsConfig,
    fetchImpl: params.fetchImpl
  });

  const isEffectiveDeleted = (cleanPath: string): boolean => {
    if (params.stagedImplementation?.deletedFiles.has(cleanPath)) {
      return true;
    }
    if (params.stagedImplementation?.files.has(cleanPath)) {
      return false;
    }
    return Boolean(params.deletedFilesSet?.has(cleanPath));
  };

  const resolveEffectiveFileContent = async (
    cleanPath: string
  ): Promise<string | null> => {
    if (isEffectiveDeleted(cleanPath)) {
      return null;
    }
    const stagedContent = params.stagedImplementation?.files.get(cleanPath);
    if (stagedContent !== undefined) {
      return stagedContent;
    }
    let content = params.accumulatedFiles.get(cleanPath) ?? null;
    if (content === null) {
      content =
        (await params.gh.readSingleBranchFile(params.branch, cleanPath)) ??
        (params.branch !== params.featureBranch
          ? await params.gh.readSingleBranchFile(
              params.featureBranch,
              cleanPath
            )
          : null);
      if (content !== null) {
        params.accumulatedFiles.set(cleanPath, content);
      }
    }
    return content;
  };

  const searchInRepoHandler: GeminiToolHandler = async (
    args: Readonly<Record<string, unknown>>
  ) => {
    const p = String(args.path ?? "")
      .trim()
      .replace(/^\/+/, "");
    const q = String(args.query ?? "").trim();
    if (!p) {
      if (!q) {
        return { error: "Missing search query." };
      }
      const combinedFiles = new Map<string, string>(params.accumulatedFiles);
      if (params.stagedImplementation) {
        for (const [sp, sc] of params.stagedImplementation.files.entries()) {
          combinedFiles.set(sp, sc);
        }
      }
      const crossFileMatches: Array<{ path: string; line: number; text: string }> =
        [];
      for (const [filePath, fileContent] of combinedFiles.entries()) {
        if (
          isEffectiveDeleted(filePath) ||
          isSensitiveTaskBranchPath(filePath)
        ) {
          continue;
        }
        const fileLines = fileContent.split("\n");
        for (let idx = 0; idx < fileLines.length; idx += 1) {
          if (fileLines[idx]!.toLowerCase().includes(q.toLowerCase())) {
            crossFileMatches.push({
              path: filePath,
              line: idx + 1,
              text: wrapUntrustedContent(
                "untrusted_workspace_files",
                fileLines[idx]!
              )
            });
            if (crossFileMatches.length >= 25) {
              break;
            }
          }
        }
        if (crossFileMatches.length >= 25) {
          break;
        }
      }
      return { query: q, matches: crossFileMatches };
    }
    if (p.includes("..") || isSensitiveTaskBranchPath(p)) {
      return { error: `Access denied or invalid path: ${p}` };
    }
    if (isEffectiveDeleted(p)) {
      return { error: `File '${p}' was deleted in the current branch.` };
    }
    const content = await resolveEffectiveFileContent(p);
    if (content === null) {
      return { error: `File not found: ${p}` };
    }
    const lines = content.split("\n");
    const snippets: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.toLowerCase().includes(q.toLowerCase())) {
        const start = Math.max(0, i - 15);
        const end = Math.min(lines.length, i + 20);
        snippets.push(
          wrapUntrustedContent(
            "untrusted_workspace_files",
            `Lines ${start + 1}-${end}:\n` +
              lines
                .slice(start, end)
                .map((l, idx) => `${start + idx + 1}| ${l}`)
                .join("\n")
          )
        );
        i = end - 1;
        if (snippets.length >= 8) {
          break;
        }
      }
    }
    return {
      path: p,
      total_lines: lines.length,
      matches: snippets
    };
  };

  const mutationTools: GeminiFunctionDeclaration[] = params.stagedImplementation
    ? [
        {
          name: "write_repo_file",
          description:
            "Create or overwrite a repository file in the transactional ticket buffer during implementation or remediation.",
          parameters: {
            type: "OBJECT" as const,
            properties: {
              path: {
                type: "STRING" as const,
                description: "Repository-relative file path"
              },
              content: {
                type: "STRING" as const,
                description: "Complete file content to stage"
              }
            },
            required: ["path", "content"]
          }
        },
        {
          name: "patch_repo_file",
          description:
            "Apply exact old_string -> new_string surgical replacements to an existing repository file in the transactional ticket buffer.",
          parameters: {
            type: "OBJECT" as const,
            properties: {
              path: {
                type: "STRING" as const,
                description: "Repository-relative file path"
              },
              edits: {
                type: "ARRAY" as const,
                description: "Ordered list of surgical string replacements",
                items: {
                  type: "OBJECT" as const,
                  properties: {
                    old_string: {
                      type: "STRING" as const,
                      description: "Exact existing snippet to replace"
                    },
                    new_string: {
                      type: "STRING" as const,
                      description: "Replacement snippet"
                    }
                  },
                  required: ["old_string", "new_string"]
                }
              }
            },
            required: ["path", "edits"]
          }
        },
        {
          name: "delete_repo_file",
          description:
            "Stage the deletion of an obsolete repository file in the transactional ticket buffer.",
          parameters: {
            type: "OBJECT" as const,
            properties: {
              path: {
                type: "STRING" as const,
                description: "Repository-relative file path to delete"
              }
            },
            required: ["path"]
          }
        }
      ]
    : [];

  const mutationToolHandlers: Record<string, GeminiToolHandler> =
    params.stagedImplementation
      ? {
          write_repo_file: async (args: Readonly<Record<string, unknown>>) => {
            const p = String(args.path ?? "")
              .trim()
              .replace(/^\/+/, "");
            if (!p || p.includes("..") || isSensitiveTaskBranchPath(p)) {
              return { error: `Access denied or invalid path: ${p}` };
            }
            if (typeof args.content !== "string") {
              return { error: `Content for '${p}' must be a string.` };
            }
            await params.stagedImplementation!.ensureBaselineLoaded?.([p]);
            params.stagedImplementation!.files.set(p, args.content);
            params.stagedImplementation!.deletedFiles.delete(p);
            return {
              staged: true,
              path: p,
              total_lines: args.content.split("\n").length
            };
          },
          patch_repo_file: async (args: Readonly<Record<string, unknown>>) => {
            const p = String(args.path ?? "")
              .trim()
              .replace(/^\/+/, "");
            if (!p || p.includes("..") || isSensitiveTaskBranchPath(p)) {
              return { error: `Access denied or invalid path: ${p}` };
            }
            const rawEdits = Array.isArray(args.edits) ? args.edits : [];
            if (rawEdits.length === 0) {
              return {
                error: `patch_repo_file requires at least one edit for '${p}'.`
              };
            }
            await params.stagedImplementation!.ensureBaselineLoaded?.([p]);
            const baseContent = await resolveEffectiveFileContent(p);
            if (baseContent === null) {
              return { error: `File not found for patching: ${p}` };
            }
            let updatedContent = baseContent;
            for (let idx = 0; idx < rawEdits.length; idx += 1) {
              const editItem = rawEdits[idx];
              const editRec =
                editItem && typeof editItem === "object"
                  ? (editItem as Record<string, unknown>)
                  : {};
              const oldStr =
                typeof editRec.old_string === "string"
                  ? editRec.old_string
                  : typeof editRec.search === "string"
                    ? editRec.search
                    : "";
              const newStr =
                typeof editRec.new_string === "string"
                  ? editRec.new_string
                  : typeof editRec.replace === "string"
                    ? editRec.replace
                    : "";
              if (!oldStr) {
                return {
                  error: `Edit #${idx + 1} in '${p}' has an empty old_string.`
                };
              }
              if (updatedContent.includes(oldStr)) {
                updatedContent = updatedContent.replace(oldStr, newStr);
                continue;
              }
              const normalizedOld = oldStr.replace(/\r\n/g, "\n").trim();
              const normalizedDoc = updatedContent.replace(/\r\n/g, "\n");
              if (normalizedOld && normalizedDoc.includes(normalizedOld)) {
                updatedContent = normalizedDoc.replace(
                  normalizedOld,
                  newStr.replace(/\r\n/g, "\n").trim()
                );
                continue;
              }
              return {
                error: `Edit #${idx + 1} old_string (${oldStr.length} chars) did not match in '${p}'. Read the file first with read_repo_file.`
              };
            }
            params.stagedImplementation!.files.set(p, updatedContent);
            params.stagedImplementation!.deletedFiles.delete(p);
            return {
              applied: true,
              path: p,
              edits_applied: rawEdits.length,
              total_lines: updatedContent.split("\n").length
            };
          },
          delete_repo_file: async (args: Readonly<Record<string, unknown>>) => {
            const p = String(args.path ?? "")
              .trim()
              .replace(/^\/+/, "");
            if (!p || p.includes("..") || isSensitiveTaskBranchPath(p)) {
              return { error: `Access denied or invalid path: ${p}` };
            }
            await params.stagedImplementation!.ensureBaselineLoaded?.([p]);
            params.stagedImplementation!.files.delete(p);
            params.stagedImplementation!.deletedFiles.add(p);
            return { deleted: true, path: p };
          }
        }
      : {};

  return {
    tools: [
      {
        name: "list_repo_files",
        description:
          "Search file paths in the repository matching a substring or keyword (e.g. 'router', 'auth', 'config', 'cli').",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            query: {
              type: "STRING" as const,
              description: "Case-insensitive path substring to match"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "search_in_repo_file",
        description:
          "Search for a substring inside a repository file and return matching line numbers with surrounding lines.",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            path: {
              type: "STRING" as const,
              description: "Repository-relative file path"
            },
            query: {
              type: "STRING" as const,
              description: "Substring or identifier to search for"
            }
          },
          required: ["path", "query"]
        }
      },
      ...(params.alwaysEnableRepoTools
        ? [
            {
              name: "search_repo_code",
              description:
                "Search for a substring or symbol across repository files (or inside an optional file path) and return matching lines.",
              parameters: {
                type: "OBJECT" as const,
                properties: {
                  query: {
                    type: "STRING" as const,
                    description: "Substring or identifier to search for"
                  },
                  path: {
                    type: "STRING" as const,
                    description:
                      "Optional repository-relative file path to scope the search"
                  }
                },
                required: ["query"]
              }
            }
          ]
        : []),
      {
        name: "read_repo_file",
        description:
          "Read a file (or line range start_line..end_line) from the repository branch.",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            path: {
              type: "STRING" as const,
              description: "Repository-relative file path"
            },
            start_line: {
              type: "INTEGER" as const,
              description: "Optional 1-based start line"
            },
            end_line: {
              type: "INTEGER" as const,
              description: "Optional 1-based end line"
            }
          },
          required: ["path"]
        }
      },
      ...mutationTools,
      ...webExploration.tools
    ],
    toolHandlers: {
      ...webExploration.toolHandlers,
      ...mutationToolHandlers,
      list_repo_files: async (args: Readonly<Record<string, unknown>>) => {
        const rawQuery = String(args.query ?? "")
          .trim()
          .toLowerCase();
        const q =
          rawQuery === "*" ||
          rawQuery === "**" ||
          rawQuery === "." ||
          rawQuery === "./"
            ? ""
            : rawQuery;
        const queryTokens = q.split("*").filter(Boolean);
        let allPaths = await params.gh.listBranchPaths(params.branch);
        if (allPaths.length === 0 && params.branch !== params.featureBranch) {
          allPaths = await params.gh.listBranchPaths(params.featureBranch);
        }
        const pathSet = new Set<string>(
          allPaths.map((p) => p.trim().replace(/^\/+/, "")).filter(Boolean)
        );
        for (const k of params.accumulatedFiles.keys()) {
          const cleanK = k.trim().replace(/^\/+/, "");
          if (cleanK) {
            pathSet.add(cleanK);
          }
        }
        if (params.stagedImplementation) {
          for (const k of params.stagedImplementation.files.keys()) {
            const cleanK = k.trim().replace(/^\/+/, "");
            if (cleanK) {
              pathSet.add(cleanK);
            }
          }
        }
        const matches = Array.from(pathSet).filter((cleanP) => {
          if (isEffectiveDeleted(cleanP)) {
            return false;
          }
          const lower = cleanP.toLowerCase();
          return queryTokens.length === 0
            ? true
            : queryTokens.every((token) => lower.includes(token));
        });
        return {
          total_matches: matches.length,
          matches
        };
      },
      search_in_repo_file: searchInRepoHandler,
      search_repo_code: searchInRepoHandler,
      read_repo_file: async (args: Readonly<Record<string, unknown>>) => {
        const p = String(args.path ?? "")
          .trim()
          .replace(/^\/+/, "");
        if (!p || p.includes("..") || isSensitiveTaskBranchPath(p)) {
          return { error: `Access denied or invalid path: ${p}` };
        }
        if (isEffectiveDeleted(p)) {
          return { error: `File '${p}' was deleted in the current branch.` };
        }
        const content = await resolveEffectiveFileContent(p);
        if (content === null) {
          return { error: `File not found: ${p}` };
        }
        const lines = content.split("\n");
        const startLine = Math.max(1, Number(args.start_line ?? 1) || 1);
        const endLine =
          args.end_line !== undefined && args.end_line !== null
            ? Math.min(
                lines.length,
                Math.max(startLine, Number(args.end_line) || lines.length)
              )
            : lines.length;
        return {
          path: p,
          total_lines: lines.length,
          start_line: startLine,
          end_line: endLine,
          content: wrapUntrustedContent(
            "untrusted_workspace_files",
            lines.slice(startLine - 1, endLine).join("\n")
          )
        };
      }
    }
  };
}
