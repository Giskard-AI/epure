import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DetectedStackKind =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "generic";

export type NodePackageManager = "npm" | "pnpm" | "yarn";

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

export function detectRepositoryStack(params: {
  readonly repoRootDir?: string | undefined;
  readonly targetFilesHint?: readonly string[] | undefined;
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

  return {
    kind,
    nodePackageManager,
    hasMakefile,
    makeTargets,
    hasDockerfile,
    hasDockerCompose,
    hasPlaywrightOrE2e,
    nodeScripts,
    subprojects
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
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 20",
      "    steps:",
      ...qualitySteps,
      "",
      "  zizmor:",
      '    name: "Zizmor"',
      "    runs-on: ubuntu-latest",
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
