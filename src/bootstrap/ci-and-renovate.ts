import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type DetectedStackKind =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "generic";

export type NodePackageManager = "npm" | "pnpm" | "yarn";

export type VerificationTargetKind =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "make"
  | "custom";

export interface VerificationTargetSpec {
  readonly name: string;
  readonly working_directory: string;
  readonly kind: VerificationTargetKind;
  readonly path_patterns: readonly string[];
  readonly install_command?: string | undefined;
  readonly codegen_command?: string | undefined;
  readonly typecheck_command?: string | undefined;
  readonly lint_command?: string | undefined;
  readonly test_command?: string | undefined;
  readonly build_command?: string | undefined;
}

export interface VerificationProfile {
  readonly wait_for_external_ci: boolean;
  readonly external_ci_timeout_minutes: number;
  readonly grace_window_seconds: number;
  readonly deferred_external_workflows?: readonly string[] | undefined;
  readonly targets: readonly VerificationTargetSpec[];
}

export interface DetectedStackProfile {
  readonly kind: DetectedStackKind;
  readonly nodePackageManager: NodePackageManager;
  readonly hasMakefile: boolean;
  readonly makeTargets: readonly string[];
  readonly hasDockerfile: boolean;
  readonly hasDockerCompose: boolean;
  readonly hasPlaywrightOrE2e: boolean;
  readonly nodeScripts: Readonly<Record<string, string>>;
  readonly subprojects: readonly string[];
  readonly verification: VerificationProfile;
}

export interface GeneratedRepoGovernanceFile {
  readonly path: string;
  readonly content: string;
}

const PINNED_ACTIONS_CHECKOUT_SHA =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const PINNED_ACTIONS_SETUP_NODE_SHA =
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0";
const PINNED_ACTIONS_SETUP_PYTHON_SHA =
  "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5.6.0";
const PINNED_ACTIONS_SETUP_GO_SHA =
  "actions/setup-go@41dfa10bad2bb2ae585af6ee5bb4d7d973ad74ed # v5.5.0";
const PINNED_ZIZMOR_ACTION_SHA =
  "zizmorcore/zizmor-action@85b2b9fb8e3325e7a23d7d0a9d7ba5ae0f999e3e # v0.7.1";

// # renovate: datasource=github-releases depName=rtk-ai/rtk
export const PINNED_RTK_VERSION = "v1.0.1";

const SAFE_RTK_VERSION_PATTERN = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export function buildSandboxToolingSetupSteps(
  rtkVersion: string = PINNED_RTK_VERSION
): readonly string[] {
  const safeRtkVersion = SAFE_RTK_VERSION_PATTERN.test(rtkVersion.trim())
    ? rtkVersion.trim()
    : PINNED_RTK_VERSION;
  return [
    "      - name: Provision Ubuntu 26.04 kernel sandbox (landrun + bubblewrap) & stateless RTK",
    "        run: |",
    "          sudo apt-get update -qq",
    "          sudo apt-get install -y --no-install-recommends landrun bubblewrap ca-certificates curl",
    "          # renovate: datasource=github-releases depName=rtk-ai/rtk",
    `          RTK_VERSION="${safeRtkVersion}"`,
    '          RTK_ARCHIVE="rtk-x86_64-unknown-linux-musl.tar.gz"',
    '          curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/${RTK_ARCHIVE}" -o "/tmp/${RTK_ARCHIVE}"',
    '          curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/checksums.txt" -o "/tmp/rtk-checksums.txt"',
    "          (cd /tmp && sha256sum --check --ignore-missing rtk-checksums.txt)",
    '          mkdir -p "$RUNNER_TEMP/bin"',
    '          tar -xzf "/tmp/${RTK_ARCHIVE}" -C "$RUNNER_TEMP/bin" rtk',
    '          chmod 0755 "$RUNNER_TEMP/bin/rtk"',
    '          echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"',
    '          echo "RTK_TELEMETRY_DISABLED=1" >> "$GITHUB_ENV"',
    '          echo "RTK_RECALL=0" >> "$GITHUB_ENV"',
    '          echo "RTK_TEE=0" >> "$GITHUB_ENV"',
    '          echo "NO_COLOR=1" >> "$GITHUB_ENV"'
  ];
}

function parseMakefileTargets(makefileContent: string): readonly string[] {
  const targets = new Set<string>();
  for (const line of makefileContent.split("\n")) {
    const match = /^([a-zA-Z0-9_-]+)\s*:/.exec(line);
    if (match && match[1] && !match[1].startsWith(".")) {
      targets.add(match[1]);
    }
  }
  return Array.from(targets);
}

function normalizeWorkingDir(raw: string | undefined): string {
  if (!raw) {
    return ".";
  }
  const cleaned = raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  return cleaned.length > 0 ? cleaned : ".";
}

interface ExtractedWorkflowTargetCommands {
  kindHint?: VerificationTargetKind | undefined;
  hasServices: boolean;
  install_command?: string | undefined;
  codegen_command?: string | undefined;
  typecheck_command?: string | undefined;
  lint_commands: string[];
  test_command?: string | undefined;
  build_command?: string | undefined;
}

interface ParsedWorkflowSummary {
  readonly byWorkingDir: Map<string, ExtractedWorkflowTargetCommands>;
  readonly customScriptCommands: readonly string[];
  readonly deferredWorkflows: readonly string[];
}

function classifySingleShellCommand(
  rawCmd: string,
  hasServices: boolean,
  target: ExtractedWorkflowTargetCommands,
  customScripts: Set<string>,
  markWorkflowDeferred: () => void
): void {
  const cmd = rawCmd.trim();
  if (!cmd || cmd.startsWith("#") || cmd.startsWith("echo ")) {
    return;
  }

  // Detect docker / playwright / e2e / container orchestration that belongs to Stage 3
  if (
    /\b(?:docker(?:\s+compose|-compose|\s+build|\s+run)|playwright\s+test|cypress\s+run|test:e2e|\be2e\b)\b/i.test(
      cmd
    )
  ) {
    markWorkflowDeferred();
    return;
  }

  // Custom script check: python3 scripts/..., python scripts/..., node scripts/..., bash scripts/..., ./scripts/...
  if (
    /^(?:python3?|node|bash|sh)\s+(?:\.\/)?scripts\/[^\s;&|]+(?:\s+[^\s;&|]+)*$/i.test(
      cmd
    ) ||
    /^\.\/scripts\/[^\s;&|]+(?:\s+[^\s;&|]+)*$/i.test(cmd)
  ) {
    if (
      !/\b(?:conventional-commit-title|coverage-summary|image-advisories|nginx-check)\b/i.test(
        cmd
      )
    ) {
      customScripts.add(cmd);
    }
    return;
  }
  if (
    !hasServices &&
    /^\s*python3?\s+-m\s+unittest\s+discover\s+-s\s+scripts\/tests\b/i.test(cmd)
  ) {
    customScripts.add(cmd);
    return;
  }

  // Codegen: prisma generate, graphql-codegen, etc.
  if (
    /\bprisma\s+generate\b/.test(cmd) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:prisma:generate|codegen)\b/.test(cmd)
  ) {
    target.kindHint = target.kindHint ?? "node";
    if (!target.codegen_command) {
      target.codegen_command = cmd;
    }
    return;
  }

  // Install commands
  if (
    /^(?:npm\s+(?:ci|install)|pnpm\s+install(?:\s+--frozen-lockfile)?|yarn\s+install(?:\s+--frozen-lockfile)?)$/.test(
      cmd
    )
  ) {
    target.kindHint = target.kindHint ?? "node";
    if (!target.install_command) {
      target.install_command = cmd;
    }
    return;
  }
  if (
    /^(?:(?:python3?\s+-m\s+)?pip\s+install\s+(?!--upgrade\s+pip|-U\s+pip).+|uv\s+sync.*|poetry\s+install.*)$/.test(
      cmd
    )
  ) {
    target.kindHint = target.kindHint ?? "python";
    if (!target.install_command) {
      target.install_command = cmd;
    }
    return;
  }

  // Typecheck commands
  if (
    /\btsc\b/.test(cmd) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?typecheck\b/.test(cmd)
  ) {
    target.kindHint = target.kindHint ?? "node";
    if (!target.typecheck_command) {
      target.typecheck_command = cmd.replace(/\s+--if-present\b/, "");
    }
    return;
  }
  if (/\b(?:mypy|pyright)\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "python";
    if (!target.typecheck_command) {
      target.typecheck_command = cmd;
    }
    return;
  }
  if (/\bcargo\s+check\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "rust";
    if (!target.typecheck_command) {
      target.typecheck_command = cmd;
    }
    return;
  }
  if (/\bgo\s+vet\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "go";
    if (!target.typecheck_command) {
      target.typecheck_command = cmd;
    }
    return;
  }

  // Lint commands
  if (
    /\b(?:eslint|biome)\b/.test(cmd) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b/.test(cmd)
  ) {
    target.kindHint = target.kindHint ?? "node";
    const cleanLint = cmd.replace(/\s+--if-present\b/, "");
    if (!target.lint_commands.includes(cleanLint)) {
      target.lint_commands.push(cleanLint);
    }
    return;
  }
  if (/\b(?:ruff\s+(?:check|format)|flake8)\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "python";
    if (!target.lint_commands.includes(cmd)) {
      target.lint_commands.push(cmd);
    }
    return;
  }
  if (/\bcargo\s+(?:clippy|fmt)\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "rust";
    if (!target.lint_commands.includes(cmd)) {
      target.lint_commands.push(cmd);
    }
    return;
  }
  if (/\b(?:gofmt|golangci-lint)\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "go";
    if (!target.lint_commands.includes(cmd)) {
      target.lint_commands.push(cmd);
    }
    return;
  }

  // Test commands
  const isUnitOnlyTest =
    /\btest:unit\b|tests\/unit|\bunit\b|-m\s+["']?not\s+integration/i.test(cmd);
  if (
    /\b(?:vitest|jest)\b/.test(cmd) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::unit)?\b/.test(cmd)
  ) {
    target.kindHint = target.kindHint ?? "node";
    if (!hasServices || isUnitOnlyTest) {
      if (!target.test_command || isUnitOnlyTest) {
        target.test_command = cmd
          .replace(/\s+2>\/dev\/null.*$/, "")
          .replace(/\s+--coverage(?:\.[A-Za-z0-9_.-]+)?(?:=\S+)?/g, "")
          .replace(/\s+--coverageReporters=\S+/g, "")
          .trim();
      }
    }
    return;
  }
  if (
    /\bpytest\b/.test(cmd) ||
    /\bpython3?\s+-m\s+(?:pytest|unittest)\b/.test(cmd)
  ) {
    target.kindHint = target.kindHint ?? "python";
    if (!hasServices || isUnitOnlyTest) {
      if (!target.test_command || isUnitOnlyTest) {
        target.test_command = cmd;
      }
    }
    return;
  }
  if (/\bcargo\s+test\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "rust";
    if (!hasServices || isUnitOnlyTest) {
      if (!target.test_command) {
        target.test_command = cmd;
      }
    }
    return;
  }
  if (/\bgo\s+test\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "go";
    if (!hasServices || isUnitOnlyTest) {
      if (!target.test_command) {
        target.test_command = cmd;
      }
    }
    return;
  }

  // Build commands
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "node";
    if (!target.build_command) {
      target.build_command = cmd.replace(/\s+--if-present\b/, "");
    }
    return;
  }
  if (/\bcargo\s+build\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "rust";
    if (!target.build_command) {
      target.build_command = cmd;
    }
    return;
  }
  if (/\bgo\s+build\b/.test(cmd)) {
    target.kindHint = target.kindHint ?? "go";
    if (!target.build_command) {
      target.build_command = cmd;
    }
  }
}

function parseNonEpureWorkflows(
  workflowEntries: ReadonlyArray<{ readonly path: string; readonly content: string }>
): ParsedWorkflowSummary {
  const byWorkingDir = new Map<string, ExtractedWorkflowTargetCommands>();
  const customScripts = new Set<string>();
  const deferredWorkflows = new Set<string>();

  const getOrCreateDirEntry = (dir: string): ExtractedWorkflowTargetCommands => {
    const normalized = normalizeWorkingDir(dir);
    let existing = byWorkingDir.get(normalized);
    if (!existing) {
      existing = {
        hasServices: false,
        lint_commands: []
      };
      byWorkingDir.set(normalized, existing);
    }
    return existing;
  };

  for (const wf of workflowEntries) {
    const fileName = basename(wf.path);
    if (
      fileName.toLowerCase().startsWith("epure-") ||
      wf.content.includes("Giskard-AI/epure")
    ) {
      continue;
    }

    const lines = wf.content.split(/\r?\n/);
    let inJobs = false;
    let currentJobLines: string[] = [];
    const jobBlocks: string[][] = [];

    for (const line of lines) {
      if (/^jobs:\s*(?:#.*)?$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (inJobs) {
        if (/^[a-zA-Z0-9_-]+:\s*(?:#.*)?$/.test(line)) {
          if (currentJobLines.length > 0) {
            jobBlocks.push(currentJobLines);
            currentJobLines = [];
          }
          inJobs = false;
          continue;
        }
        if (/^  [a-zA-Z0-9_-]+:\s*(?:#.*)?$/.test(line)) {
          if (currentJobLines.length > 0) {
            jobBlocks.push(currentJobLines);
          }
          currentJobLines = [line];
          continue;
        }
        if (currentJobLines.length > 0) {
          currentJobLines.push(line);
        }
      }
    }
    if (currentJobLines.length > 0) {
      jobBlocks.push(currentJobLines);
    }

    let workflowDeferred = false;
    const markDeferred = (): void => {
      workflowDeferred = true;
    };

    for (const jobLines of jobBlocks) {
      const jobText = jobLines.join("\n");
      const hasServices = /^    services:\s*(?:#.*)?$/m.test(jobText);
      const isContainerOrE2eJob =
        /\bdocker(?:\s+compose|\s+build|\s+run)\b|\bplaywright\s+(?:install|test)\b/i.test(
          jobText
        );
      if (hasServices || isContainerOrE2eJob) {
        workflowDeferred = true;
      }
      if (isContainerOrE2eJob) {
        continue;
      }

      // Extract job-level default working-directory (before steps:)
      let jobWorkingDir = ".";
      const stepsIdx = jobLines.findIndex((l) => /^    steps:\s*(?:#.*)?$/.test(l));
      const headerLines = stepsIdx >= 0 ? jobLines.slice(0, stepsIdx) : jobLines;
      for (const hl of headerLines) {
        const wdMatch = /^\s*working-directory:\s*(.+)$/.exec(hl);
        if (wdMatch && wdMatch[1]) {
          jobWorkingDir = normalizeWorkingDir(wdMatch[1].replace(/#.*$/, ""));
        }
      }

      if (hasServices) {
        const targetEntry = getOrCreateDirEntry(jobWorkingDir);
        targetEntry.hasServices = true;
      }

      const stepLines = stepsIdx >= 0 ? jobLines.slice(stepsIdx + 1) : [];
      // Group into individual step blocks
      const steps: string[][] = [];
      let currentStep: string[] = [];
      for (const sl of stepLines) {
        if (/^ {4,6}-\s+/.test(sl)) {
          if (currentStep.length > 0) {
            steps.push(currentStep);
          }
          currentStep = [sl];
        } else if (currentStep.length > 0) {
          currentStep.push(sl);
        }
      }
      if (currentStep.length > 0) {
        steps.push(currentStep);
      }

      for (const step of steps) {
        let stepWorkingDir = jobWorkingDir;
        for (const sl of step) {
          const wdMatch = /^\s*(?:-\s*)?working-directory:\s*(.+)$/.exec(sl);
          if (wdMatch && wdMatch[1]) {
            stepWorkingDir = normalizeWorkingDir(wdMatch[1].replace(/#.*$/, ""));
          }
        }

        if (hasServices) {
          const stepEntry = getOrCreateDirEntry(stepWorkingDir);
          stepEntry.hasServices = true;
        }

        // Extract run commands from step
        const runCommands: string[] = [];
        for (let i = 0; i < step.length; i += 1) {
          const sl = step[i] ?? "";
          const runMatch = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(sl);
          if (!runMatch) {
            continue;
          }
          const indentLen = (runMatch[1] ?? "").length;
          const rest = (runMatch[2] ?? "").trim();
          if (/^[|>][-+]?$/.test(rest) || rest === "") {
            for (let j = i + 1; j < step.length; j += 1) {
              const nextLine = step[j] ?? "";
              if (nextLine.trim() === "") {
                continue;
              }
              const nextIndent = /^(\s*)/.exec(nextLine)?.[1]?.length ?? 0;
              if (nextIndent <= indentLen) {
                break;
              }
              runCommands.push(nextLine.trim());
              i = j;
            }
          } else {
            runCommands.push(rest.replace(/^["']|["']$/g, ""));
          }
        }

        let activeDir = stepWorkingDir;
        for (const rawLine of runCommands) {
          const stripped = rawLine.replace(/\s+#.*$/, "").trim();
          if (!stripped || stripped.startsWith("#")) {
            continue;
          }
          const parts = stripped.split(/\s*&&\s*/);
          for (const part of parts) {
            const cdMatch = /^cd\s+([^\s;&|]+)$/.exec(part.trim());
            if (cdMatch && cdMatch[1]) {
              activeDir = normalizeWorkingDir(cdMatch[1]);
              if (hasServices) {
                getOrCreateDirEntry(activeDir).hasServices = true;
              }
              continue;
            }
            const prefixMatch = /^npm\s+--prefix\s+([^\s]+)\s+(.+)$/.exec(
              part.trim()
            );
            const effectiveDir =
              prefixMatch && prefixMatch[1]
                ? normalizeWorkingDir(prefixMatch[1])
                : activeDir;
            const effectiveCmd =
              prefixMatch && prefixMatch[2]
                ? `npm ${prefixMatch[2]}`
                : part.trim();
            const dirEntry = getOrCreateDirEntry(effectiveDir);
            if (hasServices) {
              dirEntry.hasServices = true;
            }
            classifySingleShellCommand(
              effectiveCmd,
              hasServices,
              dirEntry,
              customScripts,
              markDeferred
            );
          }
        }
      }
    }

    if (workflowDeferred) {
      deferredWorkflows.add(wf.path);
    }
  }

  return {
    byWorkingDir,
    customScriptCommands: Array.from(customScripts),
    deferredWorkflows: Array.from(deferredWorkflows)
  };
}

export function discoverVerificationProfile(params: {
  readonly repoRootDir?: string | undefined;
  readonly targetFilesHint?: readonly string[] | undefined;
  readonly workflowFilesMap?: Readonly<Record<string, string>> | undefined;
}): VerificationProfile {
  const root = params.repoRootDir;
  const hints = (params.targetFilesHint ?? []).map((f) =>
    f.trim().replace(/^\/+/, "")
  );

  const fileExists = (relPath: string): boolean => {
    const clean = relPath.replace(/^\.\/+/, "");
    if (hints.includes(clean)) {
      return true;
    }
    if (root && existsSync(join(root, clean))) {
      return true;
    }
    return false;
  };

  const readFileSafe = (relPath: string): string | undefined => {
    const clean = relPath.replace(/^\.\/+/, "");
    if (root && existsSync(join(root, clean))) {
      try {
        return readFileSync(join(root, clean), "utf8");
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  // 1. Collect workflow files from workflowFilesMap and repoRootDir/.github/workflows
  const workflowMap = new Map<string, string>();
  if (params.workflowFilesMap) {
    for (const [rawPath, content] of Object.entries(params.workflowFilesMap)) {
      const normalizedPath = rawPath.startsWith(".github/workflows/")
        ? rawPath
        : `.github/workflows/${rawPath.replace(/^\/+/, "")}`;
      workflowMap.set(normalizedPath, content);
    }
  }
  if (root && existsSync(join(root, ".github", "workflows"))) {
    try {
      const entries = readdirSync(join(root, ".github", "workflows")).sort();
      for (const entry of entries) {
        if (!/\.ya?ml$/i.test(entry)) {
          continue;
        }
        const relWfPath = `.github/workflows/${entry}`;
        if (!workflowMap.has(relWfPath)) {
          const content = readFileSafe(relWfPath);
          if (content !== undefined) {
            workflowMap.set(relWfPath, content);
          }
        }
      }
    } catch {
      // ignore unreadable workflows directory
    }
  }

  const parsedWorkflows = parseNonEpureWorkflows(
    Array.from(workflowMap.entries()).map(([path, content]) => ({
      path,
      content
    }))
  );

  // 2. Discover candidate directories (root, frontend, backend, packages/*, services/*, apps/*, crates/*, cmd/*, scripts)
  const candidateDirsOrdered: string[] = ["."];
  const addCandidateDir = (dir: string): void => {
    const norm = normalizeWorkingDir(dir);
    if (norm !== "scripts" && !candidateDirsOrdered.includes(norm)) {
      candidateDirsOrdered.push(norm);
    }
  };

  for (const firstLevel of ["frontend", "backend"]) {
    addCandidateDir(firstLevel);
  }

  const secondLevelParents = ["packages", "services", "apps", "crates", "cmd"];
  for (const parent of secondLevelParents) {
    if (root && existsSync(join(root, parent))) {
      try {
        const subEntries = readdirSync(join(root, parent), {
          withFileTypes: true
        })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
        for (const sub of subEntries) {
          addCandidateDir(`${parent}/${sub}`);
        }
      } catch {
        // ignore
      }
    }
    for (const hint of hints) {
      const match = new RegExp(`^(${parent}/[^/]+)/`).exec(hint);
      if (match && match[1]) {
        addCandidateDir(match[1]);
      }
    }
  }

  for (const wfDir of parsedWorkflows.byWorkingDir.keys()) {
    addCandidateDir(wfDir);
  }

  const dirFile = (dir: string, file: string): string =>
    dir === "." ? file : `${dir}/${file}`;

  // Check if any subproject has a manifest or workflow commands
  const subprojectDirsWithManifestOrJob = candidateDirsOrdered.filter((dir) => {
    if (dir === ".") {
      return false;
    }
    return (
      fileExists(dirFile(dir, "package.json")) ||
      fileExists(dirFile(dir, "pyproject.toml")) ||
      fileExists(dirFile(dir, "requirements.txt")) ||
      fileExists(dirFile(dir, "Cargo.toml")) ||
      fileExists(dirFile(dir, "go.mod")) ||
      fileExists(dirFile(dir, "go.work")) ||
      fileExists(dirFile(dir, "Makefile")) ||
      fileExists(dirFile(dir, "Justfile")) ||
      fileExists(dirFile(dir, "Taskfile.yml")) ||
      parsedWorkflows.byWorkingDir.has(dir)
    );
  });

  const targets: VerificationTargetSpec[] = [];

  for (const dir of candidateDirsOrdered) {
    const wfEntry = parsedWorkflows.byWorkingDir.get(dir);
    const hasPkgJson = fileExists(dirFile(dir, "package.json"));
    const hasPyproject = fileExists(dirFile(dir, "pyproject.toml"));
    const hasRequirements = fileExists(dirFile(dir, "requirements.txt"));
    const hasCargo = fileExists(dirFile(dir, "Cargo.toml"));
    const hasGoMod =
      fileExists(dirFile(dir, "go.mod")) || fileExists(dirFile(dir, "go.work"));
    const hasMakefile = fileExists(dirFile(dir, "Makefile"));
    const hasJustfile =
      fileExists(dirFile(dir, "Justfile")) ||
      fileExists(dirFile(dir, "justfile"));
    const hasTaskfile =
      fileExists(dirFile(dir, "Taskfile.yml")) ||
      fileExists(dirFile(dir, "Taskfile.yaml"));
    const hasTurboOrNx =
      fileExists(dirFile(dir, "turbo.json")) ||
      fileExists(dirFile(dir, "nx.json"));

    const hasRootHintsForLang =
      dir === "." &&
      subprojectDirsWithManifestOrJob.length === 0 &&
      hints.some((f) => /\.(?:ts|tsx|js|jsx|mjs|py|rs|go)$/.test(f));

    const hasWfCommands =
      wfEntry !== undefined &&
      Boolean(
        wfEntry.install_command ||
          wfEntry.codegen_command ||
          wfEntry.typecheck_command ||
          wfEntry.lint_commands.length > 0 ||
          wfEntry.test_command ||
          wfEntry.build_command
      );

    if (
      !hasPkgJson &&
      !hasPyproject &&
      !hasRequirements &&
      !hasCargo &&
      !hasGoMod &&
      !hasMakefile &&
      !hasJustfile &&
      !hasTaskfile &&
      !hasTurboOrNx &&
      !hasWfCommands &&
      !hasRootHintsForLang
    ) {
      continue;
    }

    // If root only has task runner/orchestrator and subprojects already cover the codebase without root language manifest or root workflow commands, skip redundant root unless Makefile/turbo/nx has explicit targets
    let kind: VerificationTargetKind = "node";
    if (hasPkgJson || wfEntry?.kindHint === "node") {
      kind = "node";
    } else if (
      hasPyproject ||
      hasRequirements ||
      wfEntry?.kindHint === "python" ||
      (dir === "." &&
        subprojectDirsWithManifestOrJob.length === 0 &&
        hints.some((f) => f.endsWith(".py")))
    ) {
      kind = "python";
    } else if (
      hasCargo ||
      wfEntry?.kindHint === "rust" ||
      (dir === "." &&
        subprojectDirsWithManifestOrJob.length === 0 &&
        hints.some((f) => f.endsWith(".rs")))
    ) {
      kind = "rust";
    } else if (
      hasGoMod ||
      wfEntry?.kindHint === "go" ||
      (dir === "." &&
        subprojectDirsWithManifestOrJob.length === 0 &&
        hints.some((f) => f.endsWith(".go")))
    ) {
      kind = "go";
    } else if (hasMakefile || hasJustfile || hasTaskfile) {
      kind = "make";
    } else if (hasTurboOrNx) {
      kind = "node";
    }

    const name = dir === "." ? "root" : dir;
    const pathPatterns = dir === "." ? ["**"] : [`${dir}/**`];

    if (kind === "node") {
      const pkgRaw = readFileSafe(dirFile(dir, "package.json"));
      let scripts: Record<string, string> = {};
      let allDeps: Record<string, string> = {};
      if (pkgRaw) {
        try {
          const parsed = JSON.parse(pkgRaw) as {
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          scripts = parsed.scripts ?? {};
          allDeps = {
            ...(parsed.dependencies ?? {}),
            ...(parsed.devDependencies ?? {})
          };
        } catch {
          // ignore
        }
      }

      const hasLock = fileExists(dirFile(dir, "package-lock.json"));
      const isPnpm =
        fileExists(dirFile(dir, "pnpm-lock.yaml")) ||
        fileExists("pnpm-lock.yaml");
      const isYarn =
        fileExists(dirFile(dir, "yarn.lock")) || fileExists("yarn.lock");

      const defaultInstall = isPnpm
        ? "pnpm install"
        : isYarn
          ? "yarn install"
          : hasLock
            ? "npm ci"
            : "npm install";

      const hasPrisma =
        fileExists(dirFile(dir, "prisma/schema.prisma")) ||
        hints.some(
          (h) =>
            h.startsWith(dir === "." ? "prisma/" : `${dir}/prisma/`) &&
            h.endsWith(".prisma")
        ) ||
        "@prisma/client" in allDeps ||
        "prisma" in allDeps ||
        "prisma:generate" in scripts;

      const hasTs =
        fileExists(dirFile(dir, "tsconfig.json")) ||
        "typescript" in allDeps ||
        "typecheck" in scripts ||
        pkgRaw === undefined;

      const install_command = wfEntry?.install_command ?? defaultInstall;
      const codegen_command =
        wfEntry?.codegen_command ??
        (hasPrisma ? "npx prisma generate" : undefined);
      const typecheck_command =
        wfEntry?.typecheck_command ??
        (scripts.typecheck
          ? "npm run typecheck"
          : hasTs
            ? "npx tsc --noEmit"
            : undefined);
      const lint_command =
        wfEntry && wfEntry.lint_commands.length > 0
          ? wfEntry.lint_commands.join(" && ")
          : scripts.lint || pkgRaw === undefined
            ? "npm run lint"
            : undefined;

      let test_command: string | undefined = wfEntry?.test_command;
      if (!test_command) {
        if (scripts["test:unit"]) {
          test_command = "npm run test:unit";
        } else if (!wfEntry?.hasServices) {
          if (scripts.test || pkgRaw === undefined) {
            test_command = "npm test";
          }
        }
      }

      const build_command =
        wfEntry?.build_command ??
        (scripts.build || pkgRaw === undefined ? "npm run build" : undefined);

      targets.push({
        name,
        working_directory: dir,
        kind: "node",
        path_patterns: pathPatterns,
        ...(install_command ? { install_command } : {}),
        ...(codegen_command ? { codegen_command } : {}),
        ...(typecheck_command ? { typecheck_command } : {}),
        ...(lint_command ? { lint_command } : {}),
        ...(test_command ? { test_command } : {}),
        ...(build_command ? { build_command } : {})
      });
    } else if (kind === "python") {
      if (
        dir === "." &&
        !hasPyproject &&
        !hasRequirements &&
        subprojectDirsWithManifestOrJob.length > 0 &&
        !wfEntry?.typecheck_command &&
        (!wfEntry || wfEntry.lint_commands.length === 0) &&
        !wfEntry?.test_command
      ) {
        continue;
      }
      const pyRaw = readFileSafe(dirFile(dir, "pyproject.toml")) ?? "";
      const install_command =
        wfEntry?.install_command ??
        (hasRequirements && !hasPyproject
          ? "pip install -r requirements.txt"
          : "pip install -e .");
      const codegen_command = wfEntry?.codegen_command;
      const typecheck_command =
        wfEntry?.typecheck_command ??
        (pyRaw.includes("mypy") || fileExists(dirFile(dir, "mypy.ini"))
          ? "mypy ."
          : pyRaw.includes("pyright") ||
              fileExists(dirFile(dir, "pyrightconfig.json"))
            ? "pyright"
            : undefined);
      const lint_command =
        wfEntry && wfEntry.lint_commands.length > 0
          ? wfEntry.lint_commands.join(" && ")
          : "ruff check .";
      const test_command =
        wfEntry?.test_command ?? (!wfEntry?.hasServices ? "pytest -q" : undefined);

      targets.push({
        name,
        working_directory: dir,
        kind: "python",
        path_patterns: pathPatterns,
        install_command,
        ...(codegen_command ? { codegen_command } : {}),
        ...(typecheck_command ? { typecheck_command } : {}),
        ...(lint_command ? { lint_command } : {}),
        ...(test_command ? { test_command } : {})
      });
    } else if (kind === "rust") {
      const typecheck_command =
        wfEntry?.typecheck_command ?? "cargo check --all-targets";
      const lint_command =
        wfEntry && wfEntry.lint_commands.length > 0
          ? wfEntry.lint_commands.join(" && ")
          : "cargo clippy --all-targets --all-features -- -D warnings";
      const test_command =
        wfEntry?.test_command ??
        (!wfEntry?.hasServices ? "cargo test --all-targets" : undefined);
      const build_command = wfEntry?.build_command ?? "cargo build";

      targets.push({
        name,
        working_directory: dir,
        kind: "rust",
        path_patterns: pathPatterns,
        typecheck_command,
        lint_command,
        ...(test_command ? { test_command } : {}),
        build_command
      });
    } else if (kind === "go") {
      const typecheck_command = wfEntry?.typecheck_command ?? "go vet ./...";
      const lint_command =
        wfEntry && wfEntry.lint_commands.length > 0
          ? wfEntry.lint_commands.join(" && ")
          : undefined;
      const test_command =
        wfEntry?.test_command ??
        (!wfEntry?.hasServices ? "go test ./..." : undefined);
      const build_command = wfEntry?.build_command ?? "go build ./...";

      targets.push({
        name,
        working_directory: dir,
        kind: "go",
        path_patterns: pathPatterns,
        typecheck_command,
        ...(lint_command ? { lint_command } : {}),
        ...(test_command ? { test_command } : {}),
        build_command
      });
    } else if (kind === "make") {
      const mkContent = readFileSafe(dirFile(dir, "Makefile")) ?? "";
      const mkTargets = mkContent ? parseMakefileTargets(mkContent) : [];
      const runnerBin = hasMakefile ? "make" : hasJustfile ? "just" : "task";
      const lint_command =
        wfEntry && wfEntry.lint_commands.length > 0
          ? wfEntry.lint_commands.join(" && ")
          : mkTargets.includes("lint")
            ? `${runnerBin} lint`
            : undefined;
      const typecheck_command =
        wfEntry?.typecheck_command ??
        (mkTargets.includes("typecheck")
          ? `${runnerBin} typecheck`
          : undefined);
      const test_command =
        wfEntry?.test_command ??
        (mkTargets.includes("check") && !mkTargets.includes("test")
          ? `${runnerBin} check`
          : `${runnerBin} test`);
      const build_command =
        wfEntry?.build_command ??
        (mkTargets.includes("build") ? `${runnerBin} build` : undefined);

      targets.push({
        name,
        working_directory: dir,
        kind: "make",
        path_patterns: pathPatterns,
        ...(typecheck_command ? { typecheck_command } : {}),
        ...(lint_command ? { lint_command } : {}),
        ...(test_command ? { test_command } : {}),
        ...(build_command ? { build_command } : {})
      });
    }
  }

  // 3. Discover custom scripts target (from workflow `python3 scripts/...` or `scripts/*.py` files)
  const scriptCommands = [...parsedWorkflows.customScriptCommands];
  if (scriptCommands.length === 0) {
    const scriptFiles = new Set<string>();
    for (const h of hints) {
      if (/^scripts\/[^/]+\.py$/.test(h)) {
        scriptFiles.add(h);
      }
    }
    if (root && existsSync(join(root, "scripts"))) {
      try {
        for (const entry of readdirSync(join(root, "scripts")).sort()) {
          if (entry.endsWith(".py")) {
            scriptFiles.add(`scripts/${entry}`);
          }
        }
      } catch {
        // ignore
      }
    }
    for (const sf of scriptFiles) {
      scriptCommands.push(`python3 ${sf}`);
    }
  }

  if (scriptCommands.length > 0) {
    const scriptPatterns = ["scripts/**", "docs/**", "*.md"];
    if (targets.some((t) => t.working_directory === "backend")) {
      scriptPatterns.push("backend/**");
    }
    if (targets.some((t) => t.working_directory === "frontend")) {
      scriptPatterns.push("frontend/**");
    }
    const rootWfInstall = parsedWorkflows.byWorkingDir.get(".")?.install_command;
    const scriptsInstallCommand =
      rootWfInstall && !targets.some((t) => t.working_directory === ".")
        ? rootWfInstall
        : undefined;
    targets.push({
      name: "scripts",
      working_directory: ".",
      kind: "custom",
      path_patterns: scriptPatterns,
      ...(scriptsInstallCommand ? { install_command: scriptsInstallCommand } : {}),
      test_command: scriptCommands.join(" && ")
    });
  }

  // 4. Default fallback target when repository is empty (bootstrap branch)
  if (targets.length === 0) {
    targets.push({
      name: "root",
      working_directory: ".",
      kind: "node",
      path_patterns: ["**"],
      install_command: "npm install",
      typecheck_command: "npx tsc --noEmit",
      lint_command: "npm run lint",
      test_command: "npm test",
      build_command: "npm run build"
    });
  }

  return {
    wait_for_external_ci: true,
    external_ci_timeout_minutes: 15,
    grace_window_seconds: 45,
    ...(parsedWorkflows.deferredWorkflows.length > 0
      ? { deferred_external_workflows: parsedWorkflows.deferredWorkflows }
      : {}),
    targets
  };
}

export function detectRepositoryStack(params: {
  readonly repoRootDir?: string | undefined;
  readonly targetFilesHint?: readonly string[] | undefined;
  readonly workflowFilesMap?: Readonly<Record<string, string>> | undefined;
}): DetectedStackProfile {
  const root = params.repoRootDir;
  const hints = (params.targetFilesHint ?? []).map((f) =>
    f.trim().replace(/^\/+/, "")
  );

  const fileExists = (relPath: string): boolean => {
    if (hints.includes(relPath)) {
      return true;
    }
    if (root && existsSync(join(root, relPath))) {
      return true;
    }
    return false;
  };

  const readFileSafe = (relPath: string): string | undefined => {
    if (root && existsSync(join(root, relPath))) {
      try {
        return readFileSync(join(root, relPath), "utf8");
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const makefileContent = readFileSafe("Makefile");
  const hasMakefile = Boolean(makefileContent) || fileExists("Makefile");
  const makeTargets = makefileContent
    ? parseMakefileTargets(makefileContent)
    : [];

  const hasDockerfile =
    fileExists("Dockerfile") ||
    hints.some((f) => f.endsWith("/Dockerfile"));
  const hasDockerCompose =
    fileExists("docker-compose.yml") ||
    fileExists("docker-compose.yaml") ||
    fileExists("compose.yml");

  const subprojects: string[] = [];
  if (fileExists("frontend/package.json")) {
    subprojects.push("frontend");
  }
  if (fileExists("backend/package.json")) {
    subprojects.push("backend");
  }

  let nodePackageManager: NodePackageManager = "npm";
  if (fileExists("pnpm-lock.yaml")) {
    nodePackageManager = "pnpm";
  } else if (fileExists("yarn.lock")) {
    nodePackageManager = "yarn";
  }

  let nodeScripts: Record<string, string> = {};
  let hasPlaywrightOrE2e = hints.some(
    (f) =>
      f.includes("playwright.config") ||
      f.includes("cypress.config") ||
      f.startsWith("e2e/") ||
      f.includes(".e2e.")
  );

  const pkgContent = readFileSafe("package.json");
  if (pkgContent) {
    try {
      const parsed = JSON.parse(pkgContent) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      nodeScripts = parsed.scripts ?? {};
      const allDeps = {
        ...(parsed.dependencies ?? {}),
        ...(parsed.devDependencies ?? {})
      };
      if (
        Boolean(nodeScripts["test:e2e"]) ||
        Boolean(nodeScripts["e2e"]) ||
        "@playwright/test" in allDeps ||
        "playwright" in allDeps ||
        "cypress" in allDeps
      ) {
        hasPlaywrightOrE2e = true;
      }
    } catch {
      // ignore invalid package.json
    }
  }

  const isNode =
    Boolean(pkgContent) ||
    fileExists("package.json") ||
    subprojects.length > 0 ||
    hints.some((f) => /\.(?:ts|tsx|js|jsx|mjs)$/.test(f));
  const isPython =
    fileExists("pyproject.toml") ||
    fileExists("requirements.txt") ||
    hints.some((f) => f.endsWith(".py"));
  const isRust =
    fileExists("Cargo.toml") || hints.some((f) => f.endsWith(".rs"));
  const isGo = fileExists("go.mod") || hints.some((f) => f.endsWith(".go"));

  let kind: DetectedStackKind = "generic";
  if (isNode) {
    kind = "node";
  } else if (isPython) {
    kind = "python";
  } else if (isRust) {
    kind = "rust";
  } else if (isGo) {
    kind = "go";
  }

  const verification = discoverVerificationProfile(params);

  return {
    kind,
    nodePackageManager,
    hasMakefile,
    makeTargets,
    hasDockerfile,
    hasDockerCompose,
    hasPlaywrightOrE2e,
    nodeScripts,
    subprojects,
    verification
  };
}

export function buildZizmorConfigYaml(): GeneratedRepoGovernanceFile {
  return {
    path: ".github/zizmor.yml",
    content: [
      "# zizmor static analysis config for GitHub Actions workflows (ADR-0017).",
      "# https://docs.zizmor.sh/",
      "rules:",
      "  dangerous-triggers:",
      "    ignore:",
      "      # EPURE Issue Command Gate enforces write-permission verification before any privileged execution (ADR-0004).",
      "      - epure-issue-command.yml",
      "  ref-version-mismatch:",
      "    ignore:",
      "      - epure-issue-command.yml",
      "      - epure-check.yml",
      "      - release.yml",
      "  stale-action-refs:",
      "    ignore:",
      "      - epure-issue-command.yml",
      "      - epure-check.yml",
      "      - release.yml",
      ""
    ].join("\n")
  };
}

export function buildRenovateConfigJson(
  stack: DetectedStackProfile
): GeneratedRepoGovernanceFile {
  const packageRules: Array<Record<string, unknown>> = [
    {
      description:
        "Supply-chain protection: never merge or propose day-1 releases (default 3-day quarantine cooldown)",
      matchUpdateTypes: ["major", "minor", "patch", "pin", "digest"],
      minimumReleaseAge: "3 days"
    },
    {
      description:
        "Expedite verified security vulnerability patches while keeping PR review trace",
      matchCategories: ["security"],
      minimumReleaseAge: "0 days",
      automerge: false
    },
    {
      description:
        "Actions and container image cooldown (7 days) + automatic PR update for digests & versions",
      matchManagers: ["github-actions", "dockerfile", "docker-compose"],
      minimumReleaseAge: "7 days"
    },
    {
      description:
        "CLI and sandbox security binaries cooldown (7 days) on GitHub releases/tags (rtk-ai/rtk, zizmorcore/zizmor)",
      groupName: "cli-security-and-sandbox-tools",
      matchDatasources: ["github-releases", "github-tags"],
      minimumReleaseAge: "7 days",
      automerge: false
    },
    {
      description: "Group GitHub Actions digest & version updates",
      groupName: "github-actions",
      matchManagers: ["github-actions"],
      automerge: false
    },
    {
      description: "Require explicit maintainer review on major updates",
      matchUpdateTypes: ["major"],
      automerge: false,
      dependencyDashboardApproval: false
    }
  ];

  if (stack.hasDockerfile || stack.hasDockerCompose) {
    packageRules.push({
      description: "Group Docker and compose image updates",
      groupName: "docker",
      matchManagers: ["dockerfile", "docker-compose"],
      automerge: false
    });
  }

  if (stack.kind === "node") {
    packageRules.push(
      {
        description: "npm patch cooldown (hijacked publish window protection)",
        matchDatasources: ["npm"],
        matchUpdateTypes: ["patch"],
        minimumReleaseAge: "3 days"
      },
      {
        description: "npm minor cooldown",
        matchDatasources: ["npm"],
        matchUpdateTypes: ["minor"],
        minimumReleaseAge: "7 days"
      },
      {
        description: "npm major cooldown",
        matchDatasources: ["npm"],
        matchUpdateTypes: ["major"],
        minimumReleaseAge: "14 days",
        automerge: false
      }
    );

    if (stack.subprojects.length > 0) {
      for (const sub of stack.subprojects) {
        packageRules.push({
          description: `Group ${sub} npm minor, patch, and pin`,
          groupName: `${sub}-minor-and-patch`,
          matchFileNames: [`${sub}/package.json`],
          matchUpdateTypes: ["minor", "patch", "pin", "digest"]
        });
      }
    } else {
      packageRules.push({
        description: "Group npm minor, patch, and pin updates",
        groupName: "npm-minor-and-patch",
        matchDatasources: ["npm"],
        matchUpdateTypes: ["minor", "patch", "pin", "digest"]
      });
    }
  } else if (stack.kind === "python") {
    packageRules.push(
      {
        description: "PyPI patch cooldown (3 days)",
        matchDatasources: ["pypi"],
        matchUpdateTypes: ["patch"],
        minimumReleaseAge: "3 days"
      },
      {
        description: "PyPI minor/major cooldown (7 days)",
        matchDatasources: ["pypi"],
        matchUpdateTypes: ["minor", "major"],
        minimumReleaseAge: "7 days"
      },
      {
        description: "Group Python minor and patch updates",
        groupName: "python-minor-and-patch",
        matchDatasources: ["pypi"],
        matchUpdateTypes: ["minor", "patch", "pin", "digest"]
      }
    );
  } else if (stack.kind === "rust") {
    packageRules.push({
      description: "Crates.io cooldown and grouping",
      groupName: "cargo-minor-and-patch",
      matchDatasources: ["crate"],
      matchUpdateTypes: ["minor", "patch", "pin", "digest"],
      minimumReleaseAge: "3 days"
    });
  } else if (stack.kind === "go") {
    packageRules.push({
      description: "Go modules cooldown and grouping",
      groupName: "gomod-minor-and-patch",
      matchDatasources: ["go"],
      matchUpdateTypes: ["minor", "patch", "pin", "digest"],
      minimumReleaseAge: "3 days"
    });
  }

  const configObject = {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    extends: [
      "config:best-practices",
      ":dependencyDashboard",
      "helpers:pinGitHubActionDigests",
      ":pinAllExceptPeerDependencies",
      "docker:pinDigests",
      "security:openssf-scorecard",
      ":enableVulnerabilityAlertsWithLabel(security)"
    ],
    baseBranchPatterns: ["dev"],
    schedule: ["before 6am on monday"],
    timezone: "UTC",
    labels: ["dependencies", "renovate"],
    semanticCommits: "enabled",
    commitMessageAction: "bump",
    rangeStrategy: "pin",
    minimumReleaseAge: "3 days",
    internalChecksFilter: "strict",
    prCreation: "not-pending",
    rebaseWhen: "behind-base-branch",
    automerge: false,
    platformAutomerge: false,
    npmrc: "ignore-scripts=true\n",
    lockFileMaintenance: {
      enabled: true,
      schedule: ["before 6am on the first day of the month"]
    },
    vulnerabilityAlerts: {
      enabled: true,
      labels: ["security", "dependencies"],
      minimumReleaseAge: "0 days",
      automerge: false
    },
    prHourlyLimit: 2,
    prConcurrentLimit: 5,
    customManagers: [
      {
        customType: "regex",
        description:
          "Track pinned CLI and security binary versions via # renovate: comments",
        managerFilePatterns: [
          "/^\\.github/workflows/[^/]+\\.ya?ml$/",
          "/^src/.*\\.ts$/",
          "/^scripts/.*\\.sh$/"
        ],
        matchStrings: [
          "#\\s*renovate:\\s*datasource=(?<datasource>[a-z-]+)\\s+depName=(?<depName>[^\\s]+)(?:\\s+extractVersion=(?<extractVersion>[^\\s]+))?\\s*\\n\\s*(?:export\\s+const\\s+)?[A-Z0-9_]+\\s*=\\s*[\"'](?<currentValue>[^\"']+)[\"']"
        ]
      }
    ],
    packageRules
  };

  return {
    path: "renovate.json",
    content: `${JSON.stringify(configObject, null, 2)}\n`
  };
}

function buildQualityJobStepsForStack(stack: DetectedStackProfile): readonly string[] {
  if (stack.kind === "python") {
    return [
      `      - uses: ${PINNED_ACTIONS_CHECKOUT_SHA}`,
      "        with:",
      "          persist-credentials: false",
      `      - uses: ${PINNED_ACTIONS_SETUP_PYTHON_SHA}`,
      "        with:",
      '          python-version: "3.12"',
      "      - name: Install dependencies",
      "        run: |",
      "          python -m pip install --upgrade pip",
      "          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi",
      "          if [ -f pyproject.toml ]; then pip install -e . || pip install .; fi",
      "      - name: Format & Lint (ruff / flake8)",
      "        run: |",
      "          if command -v ruff >/dev/null 2>&1; then ruff check . && ruff format --check .; fi",
      "      - name: Unit & Integration Tests (pytest)",
      "        run: |",
      "          if command -v pytest >/dev/null 2>&1; then pytest -q; else python -m unittest discover; fi"
    ];
  }

  if (stack.kind === "rust") {
    return [
      `      - uses: ${PINNED_ACTIONS_CHECKOUT_SHA}`,
      "        with:",
      "          persist-credentials: false",
      "      - name: Format check (cargo fmt)",
      "        run: cargo fmt --all -- --check",
      "      - name: Lint check (cargo clippy)",
      "        run: cargo clippy --all-targets --all-features -- -D warnings",
      "      - name: Tests (cargo test)",
      "        run: cargo test --all-targets"
    ];
  }

  if (stack.kind === "go") {
    return [
      `      - uses: ${PINNED_ACTIONS_CHECKOUT_SHA}`,
      "        with:",
      "          persist-credentials: false",
      `      - uses: ${PINNED_ACTIONS_SETUP_GO_SHA}`,
      "        with:",
      '          go-version: "1.24"',
      "      - name: Format & Vet (gofmt + go vet)",
      "        run: |",
      '          test -z "$(gofmt -l .)"',
      "          go vet ./...",
      "      - name: Tests (go test)",
      "        run: go test -v ./..."
    ];
  }

  // Default / Node / TypeScript / React / Vite stack (also handles empty repo that will receive Node/TS tickets)
  return [
    `      - uses: ${PINNED_ACTIONS_CHECKOUT_SHA}`,
    "        with:",
    "          persist-credentials: false",
    `      - uses: ${PINNED_ACTIONS_SETUP_NODE_SHA}`,
    "        with:",
    '          node-version: "24"',
    "      - name: Install dependencies",
    "        run: |",
    "          if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; else echo 'No package.json yet (bootstrap branch)'; fi",
    "      - name: Format check (if present)",
    "        run: |",
    "          if [ -f package.json ] && node -e 'const p=require(\"./package.json\"); process.exit(p.scripts && (p.scripts[\"format:check\"] || p.scripts.format) ? 0 : 1)'; then",
    "            npm run format:check --if-present || npm run format --if-present",
    "          fi",
    "      - name: Lint & Typecheck (strict)",
    "        run: |",
    "          if [ -f package.json ]; then",
    "            npm run lint --if-present",
    "            if node -e 'const p=require(\"./package.json\"); process.exit(p.scripts && p.scripts.typecheck ? 0 : 1)'; then",
    "              npm run typecheck",
    "            elif [ -f tsconfig.json ]; then",
    "              npx tsc --noEmit",
    "            fi",
    "          fi",
    "      - name: Unit & Integration Tests",
    "        run: |",
    "          if [ -f package.json ] && node -e 'const p=require(\"./package.json\"); process.exit(p.scripts && p.scripts.test ? 0 : 1)'; then",
    "            npx vitest run 2>/dev/null || npm test",
    "          fi",
    "      - name: Production Build",
    "        run: |",
    "          if [ -f package.json ]; then npm run build --if-present; fi",
    "      - name: End-to-End Tests (if configured)",
    "        run: |",
    "          if [ -f package.json ] && node -e 'const p=require(\"./package.json\"); process.exit(p.scripts && (p.scripts[\"test:e2e\"] || p.scripts.e2e) ? 0 : 1)'; then",
    "            npx playwright install --with-deps chromium",
    "            npm run test:e2e --if-present || npm run e2e --if-present",
    "          fi"
  ];
}

export function buildStackAwareCiWorkflowYaml(params: {
  readonly pinnedSha: string;
  readonly stack: DetectedStackProfile;
}): GeneratedRepoGovernanceFile {
  const qualitySteps = buildQualityJobStepsForStack(params.stack);

  return {
    path: ".github/workflows/ci.yml",
    content: [
      `# Managed by Giskard-AI/epure@${params.pinnedSha} # v1.1.0`,
      "# Continuous Integration: Zizmor workflow security audit + Stack-aware Format, Lint/Typecheck, Tests, Build & E2E.",
      'name: "CI"',
      "",
      "on:",
      "  push:",
      "    branches: [dev, main]",
      "  pull_request:",
      "    branches: [dev, main, 'feature/**']",
      "",
      "concurrency:",
      "  group: ${{ github.workflow }}-${{ github.ref }}",
      "  cancel-in-progress: true",
      "",
      "permissions:",
      "  contents: read",
      "",
      "jobs:",
      "  quality:",
      '    name: "Quality (Format, Lint, Typecheck, Test & Build)"',
      "    runs-on: ubuntu-26.04",
      "    timeout-minutes: 20",
      "    steps:",
      ...qualitySteps,
      "",
      "  zizmor:",
      '    name: "Zizmor"',
      "    runs-on: ubuntu-26.04",
      "    timeout-minutes: 10",
      "    permissions:",
      "      contents: read # checkout the workflows zizmor audits",
      "      actions: read # zizmor reads action metadata for online audits",
      "    steps:",
      `      - uses: ${PINNED_ACTIONS_CHECKOUT_SHA}`,
      "        with:",
      "          persist-credentials: false",
      `      - uses: ${PINNED_ZIZMOR_ACTION_SHA}`,
      "        with:",
      "          persona: pedantic",
      "          advanced-security: false",
      ""
    ].join("\n")
  };
}
