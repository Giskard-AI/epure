import {
  discoverVerificationProfile,
  type VerificationProfile
} from "../../bootstrap/ci-and-renovate.js";
import type {
  SandboxExecutionInput,
  SandboxExecutionResult
} from "../../sandbox/llm-sandbox.js";
import {
  isSensitiveTaskBranchPath,
  runPolyglotStage1Verification
} from "../../sandbox/polyglot-workspace-runner.js";
import type { GitHubRestHelper } from "../types.js";

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

export interface TicketImplementationDiffPayload {
  readonly commit_message: string;
  readonly test_summary: string;
  readonly files?:
    | ReadonlyArray<{
        readonly path: string;
        readonly content: string;
      }>
    | undefined;
  readonly patches?:
    | ReadonlyArray<{
        readonly path: string;
        readonly edits: ReadonlyArray<{
          readonly old_string?: string | undefined;
          readonly new_string?: string | undefined;
          readonly search?: string | undefined;
          readonly replace?: string | undefined;
        }>;
      }>
    | undefined;
  readonly deleted_files?: readonly string[] | undefined;
}

export async function applyTicketImplementationPayload(params: {
  readonly parsed: TicketImplementationDiffPayload;
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

export async function runTestsInIsolatedWorkspace(params: {
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly deleted_files?: readonly string[] | undefined;
  readonly changedPaths?: readonly string[] | undefined;
  readonly isTaskBranch?: boolean | undefined;
  readonly reviewersDir?: string | undefined;
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
      reviewersDir: params.reviewersDir,
      llmApiKey: params.llmApiKey,
      runnerEnv: process.env,
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

export interface BuildCompactWorkspaceFilesContextInput {
  readonly accumulatedFiles: ReadonlyMap<string, string>;
  readonly priorityPaths?: Iterable<string> | undefined;
  readonly maxInlineLinesPerFile?: number | undefined;
  readonly maxTotalInlineChars?: number | undefined;
  readonly reviewersDir?: string | undefined;
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
    if (
      !cleanPath ||
      isSensitiveTaskBranchPath(cleanPath, input.reviewersDir)
    ) {
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
        "--- WORKSPACE FILE CATALOG (inspect files in the workspace for full content) ---",
        ...catalogEntries
      ].join("\n")
    );
  }
  return sections.join("\n\n");
}
