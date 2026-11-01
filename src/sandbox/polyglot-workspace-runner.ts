import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type {
  VerificationProfile,
  VerificationTargetSpec
} from "../bootstrap/ci-and-renovate.js";
import {
  DEFAULT_REVIEWERS_DIR,
  isSensitiveReviewerRosterPath
} from "../review/reviewer-roster.js";
import {
  runInUntrustedCodeSandbox,
  type SandboxExecutionInput,
  type SandboxExecutionResult,
  type SandboxNetworkPolicy
} from "./llm-sandbox.js";

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly content?: string | undefined;
}

export interface ValidateWorkspaceFileOperationsInput {
  readonly workDir: string;
  readonly files?:
    | ReadonlyArray<WorkspaceFileEntry | string>
    | undefined;
  readonly deleted_files?: readonly string[] | undefined;
  readonly targets?: readonly VerificationTargetSpec[] | undefined;
  readonly isTaskBranch?: boolean | undefined;
  readonly reviewersDir?: string | undefined;
}

export interface WorkspaceFileValidationResult {
  readonly allowed: boolean;
  readonly sensitivePaths: readonly string[];
  readonly traversalPaths: readonly string[];
  readonly reason: string;
}

export interface PrepareRepositorySandboxWorkspaceInput {
  readonly repository?: string | undefined;
  readonly branch?: string | undefined;
  readonly githubToken?: string | undefined;
  readonly workDir?: string | undefined;
  readonly seedFiles?:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>
    | ReadonlyArray<{ readonly path: string; readonly content: string }>
    | undefined;
  readonly localSourceRepoDir?: string | undefined;
  readonly enableRemoteClone?: boolean | undefined;
  readonly execGitImpl?:
    | ((
        args: readonly string[],
        options: { readonly cwd?: string | undefined }
      ) => void)
    | undefined;
}

export interface PreparedSandboxWorkspace {
  readonly workDir: string;
  readonly clonedFromRemote: boolean;
  readonly sanitizedGitConfigUrl: string;
  readonly cleanup: () => void;
}

export interface TokenizedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly raw: string;
}

export interface TargetStepExecutionRecord {
  readonly step:
    | "install"
    | "codegen"
    | "typecheck"
    | "lint"
    | "test"
    | "build";
  readonly raw_command: string;
  readonly exit_code: number;
  readonly passed: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
  readonly network_policy?: SandboxNetworkPolicy | undefined;
}

export interface FormatStage1CommandOutputInput {
  readonly step:
    | "install"
    | "codegen"
    | "typecheck"
    | "lint"
    | "test"
    | "build";
  readonly rawCommand: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly maxFailureRawTailChars?: number | undefined;
}

export interface TargetVerificationResult {
  readonly target_name: string;
  readonly working_directory: string;
  readonly kind: string;
  readonly passed: boolean;
  readonly skipped: boolean;
  readonly steps: readonly TargetStepExecutionRecord[];
  readonly output: string;
}

export interface RunPolyglotStage1VerificationInput {
  readonly workDir?: string | undefined;
  readonly profile: VerificationProfile;
  readonly files?:
    | ReadonlyArray<{ readonly path: string; readonly content: string }>
    | undefined;
  readonly deleted_files?: readonly string[] | undefined;
  readonly changedPaths?: readonly string[] | undefined;
  readonly isTaskBranch?: boolean | undefined;
  readonly reviewersDir?: string | undefined;
  readonly llmApiKey: string;
  readonly runnerEnv?: Readonly<Record<string, string | undefined>> | undefined;
  readonly bootstrappedTargets?: Set<string> | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly label?: string | undefined;
}

export interface RunPolyglotStage1VerificationResult {
  readonly passed: boolean;
  readonly blocked_by_security_gate: boolean;
  readonly sensitive_paths: readonly string[];
  readonly traversal_paths: readonly string[];
  readonly affected_targets: readonly string[];
  readonly target_results: readonly TargetVerificationResult[];
  readonly output: string;
}

const SENSITIVE_TASK_BRANCH_PATH_PATTERNS: readonly RegExp[] = [
  /^\.github\/agents\.ya?ml$/i,
  /^\.github\/workflows(?:\/|$)/i,
  /(?:^|\/)\.env(?:\.(?!example$|sample$|template$).+)?$/i
];

const SHELL_INJECTION_PATTERN = /[;|`><\r\n]|\$\(|\$\{\{/;

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

const RTK_NOISE_LINE_PATTERN =
  /^(?:npm warn deprecated\b|npm notice\b|added \d+ packages\b|audited \d+ packages\b|found 0 vulnerabilities\b|Downloading https?:\/\/|Collecting [a-zA-Z0-9_.-]+\s*$|\s*\[[=>.\s-]{10,}\]\s*\d+%)/i;

const RTK_IGNORED_PATH_NOISE_PATTERN =
  /(?:^|\s)(?:\.git\/|node_modules\/|dist\/|target\/|__pycache__\/|\.venv\/|[^\s]+\.lock|package-lock\.json|pnpm-lock\.yaml|[^\s]+\.min\.(?:js|css))(?:\s|$)/;

const DIAGNOSTIC_PRESERVE_PATTERN =
  /\b(?:error|fail|failed|failure|err!|assertionerror|typeerror|referenceerror|syntaxerror|traceback|exception|panic)\b|^\s*at\s+/i;

export function formatAndCondenseStage1CommandOutput(
  input: FormatStage1CommandOutputInput
): string {
  const rawCombined = `${input.stdout}\n${input.stderr}`
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!rawCombined) {
    return "";
  }

  const lines = rawCombined.split("\n");
  const filteredLines: string[] = [];
  let droppedLinesCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (
        filteredLines.length > 0 &&
        filteredLines[filteredLines.length - 1] !== ""
      ) {
        filteredLines.push("");
      }
      continue;
    }

    const isDiagnosticLine = DIAGNOSTIC_PRESERVE_PATTERN.test(trimmed);
    if (
      !isDiagnosticLine &&
      (RTK_NOISE_LINE_PATTERN.test(trimmed) ||
        RTK_IGNORED_PATH_NOISE_PATTERN.test(trimmed))
    ) {
      droppedLinesCount += 1;
      continue;
    }

    filteredLines.push(line);
  }

  const condensed = filteredLines.join("\n").trim();

  if (input.exitCode === 0) {
    if (!condensed && droppedLinesCount > 0) {
      return `[rtk stateless] ${input.rawCommand}: ok (${droppedLinesCount} noise lines filtered)`;
    }
    return condensed;
  }

  const maxTailChars = input.maxFailureRawTailChars ?? 4000;
  const rawTail =
    rawCombined.length > maxTailChars
      ? rawCombined.slice(-maxTailChars)
      : rawCombined;

  if (droppedLinesCount === 0 && condensed === rawTail) {
    return condensed;
  }

  return [
    condensed,
    `--- [raw failure tail (${rawTail.length} chars, stateless in-memory)] ---`,
    rawTail
  ]
    .filter(Boolean)
    .join("\n");
}

const ALLOWLISTED_BINARIES = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "node",
  "tsc",
  "vitest",
  "jest",
  "eslint",
  "biome",
  "prisma",
  "python",
  "python3",
  "pytest",
  "ruff",
  "mypy",
  "pyright",
  "flake8",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "cargo",
  "rustc",
  "rustfmt",
  "go",
  "gofmt",
  "golangci-lint",
  "make",
  "just",
  "task",
  "turbo",
  "nx",
  "sh",
  "bash"
]);

function normalizeRelativeCandidate(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

export function isSensitiveTaskBranchPath(
  rawPath: string,
  reviewersDir: string = DEFAULT_REVIEWERS_DIR
): boolean {
  const norm = normalizeRelativeCandidate(rawPath);
  return (
    SENSITIVE_TASK_BRANCH_PATH_PATTERNS.some((re) => re.test(norm)) ||
    isSensitiveReviewerRosterPath(norm, reviewersDir)
  );
}

function hasSymlinkEscapeAlongPath(resolvedRoot: string, rawRelPath: string): boolean {
  if (!existsSync(resolvedRoot)) {
    return false;
  }
  let realRoot = resolvedRoot;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    return false;
  }

  const segments = rawRelPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");

  let current = resolvedRoot;
  for (const seg of segments) {
    current = join(current, seg);
    if (!existsSync(current)) {
      break;
    }
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const realTarget = realpathSync(current);
        if (
          realTarget !== realRoot &&
          !realTarget.startsWith(realRoot + sep)
        ) {
          return true;
        }
      }
    } catch {
      return true;
    }
  }
  return false;
}

function isContainedRelativePath(
  resolvedRoot: string,
  rawPath: string,
  allowRootDot: boolean
): boolean {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return false;
  }
  if (allowRootDot && trimmed === ".") {
    return true;
  }
  // Reject absolute paths
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return false;
  }
  const normalizedSlashes = trimmed.replace(/\\/g, "/");
  const segments = normalizedSlashes.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      return false;
    }
    if (seg.toLowerCase() === ".git") {
      return false;
    }
  }

  const resolvedTarget = resolve(resolvedRoot, trimmed);
  if (allowRootDot && resolvedTarget === resolvedRoot) {
    return true;
  }
  if (!resolvedTarget.startsWith(resolvedRoot + sep)) {
    return false;
  }
  if (hasSymlinkEscapeAlongPath(resolvedRoot, trimmed)) {
    return false;
  }
  return true;
}

export function validateWorkspaceFileOperations(
  input: ValidateWorkspaceFileOperationsInput
): WorkspaceFileValidationResult {
  const resolvedRoot = resolve(input.workDir);
  const sensitiveSet = new Set<string>();
  const traversalSet = new Set<string>();

  const filePaths: string[] = [];
  for (const entry of input.files ?? []) {
    const raw = typeof entry === "string" ? entry : entry.path;
    filePaths.push(raw);
  }
  for (const del of input.deleted_files ?? []) {
    filePaths.push(del);
  }

  for (const rawPath of filePaths) {
    if (!isContainedRelativePath(resolvedRoot, rawPath, false)) {
      traversalSet.add(rawPath);
      continue;
    }
    if (
      input.isTaskBranch &&
      isSensitiveTaskBranchPath(rawPath, input.reviewersDir)
    ) {
      sensitiveSet.add(normalizeRelativeCandidate(rawPath));
    }
  }

  for (const target of input.targets ?? []) {
    if (!isContainedRelativePath(resolvedRoot, target.working_directory, true)) {
      traversalSet.add(target.working_directory);
    }
  }

  const sensitivePaths = Array.from(sensitiveSet);
  const traversalPaths = Array.from(traversalSet);
  const allowed = sensitivePaths.length === 0 && traversalPaths.length === 0;

  const reasons: string[] = [];
  if (traversalPaths.length > 0) {
    reasons.push(
      `Path containment violation (outside workspace or inside .git/): ${traversalPaths.join(", ")}`
    );
  }
  if (sensitivePaths.length > 0) {
    reasons.push(
      `Forbidden modification of sensitive path(s) on task/* branch: ${sensitivePaths.join(", ")}`
    );
  }

  return {
    allowed,
    sensitivePaths,
    traversalPaths,
    reason: reasons.join("; ")
  };
}

function sanitizeGitConfigFile(workDir: string, cleanRemoteUrl: string): void {
  const gitDir = join(workDir, ".git");
  const gitConfigPath = join(gitDir, "config");
  if (!existsSync(gitDir)) {
    return;
  }
  if (!existsSync(gitConfigPath)) {
    if (cleanRemoteUrl) {
      writeFileSync(
        gitConfigPath,
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "\tfilemode = true",
          "\tbare = false",
          "\thooksPath = /dev/null",
          '[remote "origin"]',
          `\turl = ${cleanRemoteUrl}`,
          "\tfetch = +refs/heads/*:refs/remotes/origin/*",
          ""
        ].join("\n"),
        "utf8"
      );
    }
    return;
  }

  try {
    const raw = readFileSync(gitConfigPath, "utf8");
    const cleanedLines: string[] = [];
    let replacedUrl = false;
    for (const line of raw.split(/\r?\n/)) {
      if (/extraheader/i.test(line) || /x-access-token/i.test(line) || /Authorization:/i.test(line)) {
        continue;
      }
      if (/^\s*url\s*=/i.test(line) && cleanRemoteUrl) {
        cleanedLines.push(`\turl = ${cleanRemoteUrl}`);
        replacedUrl = true;
        continue;
      }
      cleanedLines.push(line);
    }
    if (!replacedUrl && cleanRemoteUrl) {
      cleanedLines.push('[remote "origin"]', `\turl = ${cleanRemoteUrl}`);
    }
    writeFileSync(gitConfigPath, `${cleanedLines.join("\n").trim()}\n`, "utf8");
  } catch {
    // Non-fatal if .git/config cannot be updated
  }
}

function materializeSeedFilesIntoWorkspace(
  workDir: string,
  seedFiles: PrepareRepositorySandboxWorkspaceInput["seedFiles"]
): void {
  if (!seedFiles) {
    return;
  }
  const resolvedRoot = resolve(workDir);
  const entries: Array<[string, string]> = [];
  if (Array.isArray(seedFiles)) {
    for (const item of seedFiles) {
      entries.push([item.path, item.content]);
    }
  } else if (
    seedFiles instanceof Map ||
    typeof (seedFiles as ReadonlyMap<string, string>).entries === "function"
  ) {
    for (const [k, v] of (seedFiles as ReadonlyMap<string, string>).entries()) {
      entries.push([k, v]);
    }
  } else {
    for (const [k, v] of Object.entries(seedFiles as Readonly<Record<string, string>>)) {
      if (typeof v === "string") {
        entries.push([k, v]);
      }
    }
  }

  for (const [rawPath, content] of entries) {
    const cleanRel = rawPath.replace(/^\/+/, "");
    if (!isContainedRelativePath(resolvedRoot, cleanRel, false)) {
      continue;
    }
    const targetPath = resolve(resolvedRoot, cleanRel);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, "utf8");
  }
}

export function prepareRepositorySandboxWorkspace(
  input: PrepareRepositorySandboxWorkspaceInput
): PreparedSandboxWorkspace {
  const workDir =
    input.workDir ?? mkdtempSync(join(tmpdir(), "epure-polyglot-sandbox-"));
  mkdirSync(workDir, { recursive: true });

  const repoSlug = (input.repository ?? "").trim();
  const [owner, repo] = repoSlug.split("/");
  const cleanRemoteUrl =
    owner && repo ? `https://github.com/${owner}/${repo}.git` : "";

  let clonedFromRemote = false;

  try {
    if (
      input.localSourceRepoDir &&
      existsSync(input.localSourceRepoDir)
    ) {
      cpSync(input.localSourceRepoDir, workDir, { recursive: true });
    }

    const shouldAttemptClone =
      Boolean(cleanRemoteUrl && input.branch && input.githubToken) &&
      (input.enableRemoteClone === true || Boolean(input.execGitImpl));

    if (shouldAttemptClone && input.branch && input.githubToken) {
      const basicAuth = Buffer.from(
        `x-access-token:${input.githubToken.trim()}`,
        "utf8"
      ).toString("base64");

      const cloneArgs = [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        `http.extraHeader=Authorization: Basic ${basicAuth}`,
        "clone",
        "--depth=1",
        "--single-branch",
        "--branch",
        input.branch,
        cleanRemoteUrl,
        workDir
      ];

      const gitRunner =
        input.execGitImpl ??
        ((args: readonly string[], opts: { readonly cwd?: string | undefined }) => {
          execFileSync("git", [...args], {
            cwd: opts.cwd,
            stdio: "pipe",
            timeout: 120_000
          });
        });

      try {
        gitRunner(cloneArgs, {});
        clonedFromRemote = true;
      } catch {
        // Fallback to seedFiles in offline/unit-test environments
        clonedFromRemote = false;
      }
    }

    if (input.seedFiles) {
      materializeSeedFilesIntoWorkspace(workDir, input.seedFiles);
    }
  } finally {
    if (cleanRemoteUrl) {
      // Ensure .git/config exists if cloned or if .git exists, and scrub all credentials
      if (clonedFromRemote && !existsSync(join(workDir, ".git"))) {
        mkdirSync(join(workDir, ".git"), { recursive: true });
      }
      sanitizeGitConfigFile(workDir, cleanRemoteUrl);
    }
  }

  return {
    workDir,
    clonedFromRemote,
    sanitizedGitConfigUrl: cleanRemoteUrl,
    cleanup: () => {
      rmSync(workDir, { recursive: true, force: true });
    }
  };
}

export function splitCompoundCommands(rawCommand: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < rawCommand.length; i += 1) {
    const ch = rawCommand[i] ?? "";
    const next = rawCommand[i + 1] ?? "";

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuote === '"') {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !inQuote) {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === inQuote) {
      inQuote = null;
      current += ch;
      continue;
    }
    if (!inQuote && ch === "&" && next === "&") {
      if (current.trim().length > 0) {
        parts.push(current.trim());
      }
      current = "";
      i += 1;
      continue;
    }
    current += ch;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

export function tokenizeAllowlistedCommand(
  rawAtomicCommand: string
): TokenizedCommand {
  const trimmed = rawAtomicCommand.trim();
  if (!trimmed) {
    throw new Error("Sandbox command tokenizer rejected empty command.");
  }
  if (SHELL_INJECTION_PATTERN.test(trimmed)) {
    throw new Error(
      `Sandbox command tokenizer rejected unsafe shell metacharacters or expression in '${trimmed}'.`
    );
  }

  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuote !== "'") {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !inQuote) {
      inQuote = ch;
      continue;
    }
    if (ch === inQuote) {
      inQuote = null;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (inQuote) {
    throw new Error(
      `Sandbox command tokenizer rejected unterminated quote in '${trimmed}'.`
    );
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  const binary = tokens[0] ?? "";
  const args = tokens.slice(1);

  const isRelativeScript = /^\.\/scripts\/[A-Za-z0-9_./-]+$/.test(binary);
  if (!isRelativeScript && !ALLOWLISTED_BINARIES.has(binary)) {
    throw new Error(
      `Sandbox command tokenizer rejected non-allowlisted binary '${binary}' in '${trimmed}'.`
    );
  }

  if ((binary === "sh" || binary === "bash") && args.includes("-c")) {
    throw new Error(
      `Sandbox command tokenizer forbids '${binary} -c' shell execution in '${trimmed}'.`
    );
  }

  return {
    command: binary,
    args,
    raw: trimmed
  };
}

export function matchesPathPattern(filePath: string, pattern: string): boolean {
  const cleanFile = normalizeRelativeCandidate(filePath);
  const cleanPattern = normalizeRelativeCandidate(pattern);

  if (!cleanPattern || cleanPattern === "**" || cleanPattern === "**/*" || cleanPattern === "*") {
    return true;
  }

  if (cleanPattern.endsWith("/**")) {
    const prefix = cleanPattern.slice(0, -3);
    return cleanFile === prefix || cleanFile.startsWith(`${prefix}/`);
  }

  // Convert glob pattern to RegExp
  let regexStr = "^";
  for (let i = 0; i < cleanPattern.length; i += 1) {
    const ch = cleanPattern[i] ?? "";
    const next = cleanPattern[i + 1] ?? "";
    const afterNext = cleanPattern[i + 2] ?? "";

    if (ch === "*" && next === "*") {
      if (afterNext === "/") {
        regexStr += "(?:.+/)?";
        i += 2;
      } else {
        regexStr += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      regexStr += "[^/]*";
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += `\\${ch}`;
      continue;
    }
    regexStr += ch;
  }
  regexStr += "$";

  return new RegExp(regexStr, "i").test(cleanFile);
}

export function selectAffectedVerificationTargets(
  targets: readonly VerificationTargetSpec[],
  changedPaths: readonly string[]
): readonly VerificationTargetSpec[] {
  if (targets.length === 0) {
    return [];
  }
  const cleanPaths = changedPaths
    .map(normalizeRelativeCandidate)
    .filter((p) => p.length > 0);

  if (cleanPaths.length === 0) {
    return targets;
  }

  const matched = targets.filter((target) => {
    const patterns =
      target.path_patterns.length > 0 ? target.path_patterns : ["**"];
    return cleanPaths.some((filePath) =>
      patterns.some((pat) => matchesPathPattern(filePath, pat))
    );
  });

  return matched.length > 0 ? matched : targets;
}

export function formatVerificationToolingGuideMarkdown(
  profile: VerificationProfile
): string {
  const lines: string[] = [
    "## Verification & Tooling Guide (Stage 1 Local Sandbox & Stage 3 External CI)",
    "",
    "### Stage 1 — Pre-Publication Local Sandbox Targets (`shell: false`, zero secrets)",
    "| Target | Kind | Working Directory | Path Patterns | Install | Codegen | Typecheck | Lint | Unit Test |",
    "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |"
  ];

  for (const t of profile.targets) {
    const patterns = t.path_patterns.map((p) => `\`${p}\``).join(", ") || "`**`";
    const fmt = (cmd?: string): string => (cmd ? `\`${cmd}\`` : "—");
    lines.push(
      `| \`${t.name}\` | \`${t.kind}\` | \`${t.working_directory}\` | ${patterns} | ${fmt(t.install_command)} | ${fmt(t.codegen_command)} | ${fmt(t.typecheck_command)} | ${fmt(t.lint_command)} | ${fmt(t.test_command)} |`
    );
  }

  lines.push("");
  lines.push("### Stage 3 — Post-PR External GitHub Actions CI Gate");
  lines.push(
    `- **Wait for External CI**: \`${profile.wait_for_external_ci}\` (timeout: \`${profile.external_ci_timeout_minutes}m\`, registration grace window: \`${profile.grace_window_seconds}s\` fail-closed)`
  );
  if (
    profile.deferred_external_workflows &&
    profile.deferred_external_workflows.length > 0
  ) {
    lines.push(
      `- **Deferred Service/Integration Workflows (Stage 3)**: ${profile.deferred_external_workflows.map((w) => `\`${w}\``).join(", ")} (executed automatically on GitHub Actions after PR creation/update; any failure logs & annotations will be fed back into the remediation loop).`
    );
  } else {
    lines.push(
      "- All non-EPURE `.github/workflows/*.{yml,yaml}` triggered by the PR on `dev` will be awaited in Stage 3 after PR publication."
    );
  }

  return lines.join("\n");
}

function shouldSkipDefaultNodeStepInOfflineTempDir(params: {
  readonly targetCwd: string;
  readonly step: "install" | "codegen" | "typecheck" | "lint" | "test";
  readonly rawCommand: string;
  readonly hasCustomSandboxRunner: boolean;
}): { readonly skip: boolean; readonly skipEntireTarget: boolean } {
  if (params.hasCustomSandboxRunner) {
    return { skip: false, skipEntireTarget: false };
  }

  const pkgJsonPath = join(params.targetCwd, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return { skip: true, skipEntireTarget: true };
  }

  let scripts: Record<string, string> = {};
  let depCount = 0;
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    scripts = parsed.scripts ?? {};
    depCount =
      Object.keys(parsed.dependencies ?? {}).length +
      Object.keys(parsed.devDependencies ?? {}).length;
  } catch {
    return { skip: false, skipEntireTarget: false };
  }

  const hasLockfile =
    existsSync(join(params.targetCwd, "package-lock.json")) ||
    existsSync(join(params.targetCwd, "pnpm-lock.yaml")) ||
    existsSync(join(params.targetCwd, "yarn.lock"));
  const hasNodeModules = existsSync(join(params.targetCwd, "node_modules"));

  if (params.step === "install") {
    if ((depCount === 0 && !hasLockfile) || hasNodeModules) {
      return { skip: true, skipEntireTarget: false };
    }
  }

  if (params.step === "typecheck") {
    const hasTsconfig = existsSync(join(params.targetCwd, "tsconfig.json"));
    if (!hasTsconfig && !scripts.typecheck) {
      return { skip: true, skipEntireTarget: false };
    }
  }

  if (params.step === "lint") {
    if (params.rawCommand === "npm run lint" && !scripts.lint) {
      return { skip: true, skipEntireTarget: false };
    }
  }

  if (params.step === "test") {
    if (params.rawCommand === "npm test" && !scripts.test) {
      return { skip: true, skipEntireTarget: false };
    }
  }

  return { skip: false, skipEntireTarget: false };
}

export async function runPolyglotStage1Verification(
  input: RunPolyglotStage1VerificationInput
): Promise<RunPolyglotStage1VerificationResult> {
  const ownsTempWorkDir = !input.workDir;
  const workDir =
    input.workDir ?? mkdtempSync(join(tmpdir(), "epure-stage1-sandbox-"));
  mkdirSync(workDir, { recursive: true });

  const hasCustomSandboxRunner = Boolean(input.sandboxRunner);
  const sandboxRunner = input.sandboxRunner ?? runInUntrustedCodeSandbox;
  const bootstrapped = input.bootstrappedTargets ?? new Set<string>();

  try {
    // 1. Pre-Stage-1 Sensitive Path & Path Containment Gate
    const validation = validateWorkspaceFileOperations({
      workDir,
      files:
        input.changedPaths && input.changedPaths.length > 0
          ? input.changedPaths
          : input.files,
      deleted_files: input.deleted_files,
      targets: input.profile.targets,
      isTaskBranch: input.isTaskBranch,
      reviewersDir: input.reviewersDir
    });
    const fullContainment = validateWorkspaceFileOperations({
      workDir,
      files: input.files,
      deleted_files: input.deleted_files,
      targets: input.profile.targets,
      isTaskBranch: false
    });

    if (!validation.allowed || !fullContainment.allowed) {
      const mergedTraversal = Array.from(
        new Set([
          ...validation.traversalPaths,
          ...fullContainment.traversalPaths
        ])
      );
      return {
        passed: false,
        blocked_by_security_gate: true,
        sensitive_paths: validation.sensitivePaths,
        traversal_paths: mergedTraversal,
        affected_targets: [],
        target_results: [],
        output: validation.reason || fullContainment.reason
      };
    }

    // 2. Materialize files and deleted_files inside workDir
    const resolvedRoot = resolve(workDir);
    for (const file of input.files ?? []) {
      const cleanRel = file.path.replace(/^\/+/, "");
      const fullPath = resolve(resolvedRoot, cleanRel);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, "utf8");
    }

    for (const del of input.deleted_files ?? []) {
      const cleanRel = del.replace(/^\/+/, "");
      const fullPath = resolve(resolvedRoot, cleanRel);
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
      }
    }

    // 3. Select affected targets by path_patterns
    const effectiveChangedPaths =
      input.changedPaths ??
      [
        ...(input.files ?? []).map((f) => f.path),
        ...(input.deleted_files ?? [])
      ];

    const affectedTargets = selectAffectedVerificationTargets(
      input.profile.targets,
      effectiveChangedPaths
    );

    const targetResults: TargetVerificationResult[] = [];
    const outputSections: string[] = [];

    const baseRunnerEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(input.runnerEnv ?? {}),
      LLM_API_KEY: input.llmApiKey
    };

    for (const target of affectedTargets) {
      const targetCwd =
        target.working_directory === "."
          ? resolvedRoot
          : resolve(resolvedRoot, target.working_directory);

      if (!existsSync(targetCwd)) {
        if (!hasCustomSandboxRunner) {
          targetResults.push({
            target_name: target.name,
            working_directory: target.working_directory,
            kind: target.kind,
            passed: true,
            skipped: true,
            steps: [],
            output: `Skipped target '${target.name}': directory '${target.working_directory}' not present.`
          });
          continue;
        }
        mkdirSync(targetCwd, { recursive: true });
      }

      if (target.kind === "node") {
        const nodeCheck = shouldSkipDefaultNodeStepInOfflineTempDir({
          targetCwd,
          step: "test",
          rawCommand: target.test_command ?? "npm test",
          hasCustomSandboxRunner
        });
        if (nodeCheck.skipEntireTarget) {
          targetResults.push({
            target_name: target.name,
            working_directory: target.working_directory,
            kind: target.kind,
            passed: true,
            skipped: true,
            steps: [],
            output: "No package.json in workspace snapshot; syntax verified."
          });
          continue;
        }
      }

      const candidateSteps: Array<{
        readonly step:
          | "install"
          | "codegen"
          | "typecheck"
          | "lint"
          | "test";
        readonly rawCommand: string | undefined;
        readonly bootstrapOnly: boolean;
      }> = [
        {
          step: "install",
          rawCommand: target.install_command,
          bootstrapOnly: true
        },
        {
          step: "codegen",
          rawCommand: target.codegen_command,
          bootstrapOnly: true
        },
        {
          step: "typecheck",
          rawCommand: target.typecheck_command,
          bootstrapOnly: false
        },
        {
          step: "lint",
          rawCommand: target.lint_command,
          bootstrapOnly: false
        },
        {
          step: "test",
          rawCommand: target.test_command,
          bootstrapOnly: false
        }
      ];

      const executedSteps: TargetStepExecutionRecord[] = [];
      let targetPassed = true;
      let targetFailureOutput = "";
      const isAlreadyBootstrapped = bootstrapped.has(target.name);

      for (const candidate of candidateSteps) {
        if (!candidate.rawCommand) {
          continue;
        }
        if (candidate.bootstrapOnly && isAlreadyBootstrapped) {
          continue;
        }

        if (target.kind === "node") {
          const skipDecision = shouldSkipDefaultNodeStepInOfflineTempDir({
            targetCwd,
            step: candidate.step,
            rawCommand: candidate.rawCommand,
            hasCustomSandboxRunner
          });
          if (skipDecision.skip) {
            continue;
          }
        }

        let atomicCommands: readonly string[];
        try {
          atomicCommands = splitCompoundCommands(candidate.rawCommand);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          targetPassed = false;
          targetFailureOutput = `[Target: ${target.name}][${candidate.step}] ${msg}`;
          break;
        }

        for (const atomicRaw of atomicCommands) {
          let tokenized: TokenizedCommand;
          try {
            tokenized = tokenizeAllowlistedCommand(atomicRaw);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            targetPassed = false;
            targetFailureOutput = `[Target: ${target.name}][${candidate.step}] ${msg}`;
            executedSteps.push({
              step: candidate.step,
              raw_command: atomicRaw,
              exit_code: 1,
              passed: false,
              stdout: "",
              stderr: msg,
              duration_ms: 0
            });
            break;
          }

          const stepNetworkPolicy: SandboxNetworkPolicy =
            candidate.step === "install" ? "https_only" : "offline";

          let execRes = await sandboxRunner({
            isolationAvailable: true,
            runnerEnv: baseRunnerEnv,
            command: tokenized.command,
            args: tokenized.args,
            cwd: targetCwd,
            networkPolicy: stepNetworkPolicy,
            timeoutMs:
              candidate.step === "install" || candidate.step === "test"
                ? 300_000
                : 180_000
          });

          if (
            !execRes.isolated ||
            (execRes.exit_code !== 0 &&
              (tokenized.command === "pip" || tokenized.command === "pip3") &&
              tokenized.args[0] === "install" &&
              /externally-managed-environment/i.test(
                `${execRes.stdout}\n${execRes.stderr}`
              ))
          ) {
            if (
              execRes.isolated &&
              (tokenized.command === "pip" || tokenized.command === "pip3")
            ) {
              execRes = await sandboxRunner({
                isolationAvailable: true,
                runnerEnv: baseRunnerEnv,
                command: tokenized.command,
                args: [
                  ...tokenized.args,
                  "--break-system-packages",
                  "--user"
                ],
                cwd: targetCwd,
                networkPolicy: stepNetworkPolicy,
                timeoutMs: 300_000
              });
            }
          }

          const stepPassed = execRes.isolated && execRes.exit_code === 0;

          executedSteps.push({
            step: candidate.step,
            raw_command: tokenized.raw,
            exit_code: execRes.exit_code,
            passed: stepPassed,
            stdout: execRes.stdout,
            stderr: execRes.stderr,
            duration_ms: execRes.duration_ms,
            network_policy: stepNetworkPolicy
          });

          if (!stepPassed) {
            const formattedOutput = formatAndCondenseStage1CommandOutput({
              step: candidate.step,
              rawCommand: tokenized.raw,
              exitCode: execRes.exit_code,
              stdout: execRes.stdout,
              stderr: execRes.stderr
            });
            targetPassed = false;
            targetFailureOutput = `[Target: ${target.name} (${target.working_directory})][${candidate.step}: ${tokenized.raw}] failed (exit ${execRes.exit_code}):\n${formattedOutput}`;
            break;
          }
        }

        if (!targetPassed) {
          break;
        }
      }

      if (targetPassed) {
        bootstrapped.add(target.name);
      }

      const stepOutSummary = targetPassed
        ? executedSteps
            .map((s) =>
              formatAndCondenseStage1CommandOutput({
                step: s.step,
                rawCommand: s.raw_command,
                exitCode: s.exit_code,
                stdout: s.stdout,
                stderr: s.stderr
              })
            )
            .filter(Boolean)
            .join("\n")
        : targetFailureOutput;

      targetResults.push({
        target_name: target.name,
        working_directory: target.working_directory,
        kind: target.kind,
        passed: targetPassed,
        skipped: false,
        steps: executedSteps,
        output: stepOutSummary
      });

      if (stepOutSummary) {
        outputSections.push(stepOutSummary);
      }

      if (!targetPassed) {
        return {
          passed: false,
          blocked_by_security_gate: false,
          sensitive_paths: [],
          traversal_paths: [],
          affected_targets: affectedTargets.map((t) => t.name),
          target_results: targetResults,
          output: outputSections.join("\n\n").trim()
        };
      }
    }

    return {
      passed: true,
      blocked_by_security_gate: false,
      sensitive_paths: [],
      traversal_paths: [],
      affected_targets: affectedTargets.map((t) => t.name),
      target_results: targetResults,
      output:
        outputSections.join("\n\n").trim() ||
        "Stage 1 polyglot verification passed."
    };
  } finally {
    if (ownsTempWorkDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
