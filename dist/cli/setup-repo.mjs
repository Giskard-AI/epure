#!/usr/bin/env node

// src/bootstrap/cli.ts
import { execFileSync } from "node:child_process";

// src/bootstrap/setup-repo.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// src/auth/github-apps.ts
function buildConsumerAppManifests(params) {
  const cleanOwner = params.ownerSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const agentApp = {
    role: "agent",
    name: `${cleanOwner}-epure-agent`,
    description: "EPURE Consumer Agent App \u2014 scoped to issue comments, plan/task/feature branches, PRs, and checks. Forbidden from release promotion.",
    public: false,
    default_permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      checks: "write",
      metadata: "read"
    },
    default_events: ["issue_comment", "issues", "pull_request", "check_run"],
    secretNames: {
      appId: "EPURE_AGENT_APP_ID",
      privateKey: "EPURE_AGENT_APP_PRIVATE_KEY"
    },
    allowedOperations: [
      "issue_comment",
      "push_branch",
      "create_pull_request",
      "create_check_run"
    ],
    forbiddenOperations: [
      "promote_dev_to_main",
      "create_release_tag",
      "publish_github_release"
    ],
    allowedRefPatterns: [
      "refs/heads/plan/*",
      "refs/heads/task/*",
      "refs/heads/feature/*"
    ]
  };
  const releaseApp = {
    role: "release",
    name: `${cleanOwner}-epure-release`,
    description: "EPURE Consumer Release App \u2014 strictly isolated to the protected release workflow and 'release' environment for dev->main promotion, vX.Y.Z tags, and GitHub Releases.",
    public: false,
    default_permissions: {
      contents: "write",
      metadata: "read"
    },
    default_events: [],
    secretNames: {
      appId: "EPURE_RELEASE_APP_ID",
      privateKey: "EPURE_RELEASE_APP_PRIVATE_KEY"
    },
    allowedOperations: [
      "promote_dev_to_main",
      "create_release_tag",
      "publish_github_release"
    ],
    forbiddenOperations: [
      "issue_comment",
      "create_pull_request",
      "create_check_run"
    ],
    allowedRefPatterns: ["refs/heads/main", "refs/tags/v*"],
    requiredWorkflow: ".github/workflows/release.yml",
    requiredEnvironment: "release"
  };
  return { agentApp, releaseApp };
}

// src/review/reviewer-roster.ts
var JSON_OUTPUT_CONTRACT_BLOCK = [
  "## Output Contract (Strict JSON)",
  "You operate in read-only audit mode. Return a single JSON object matching this schema:",
  "```json",
  "{",
  '  "reviewer": "<agent-name>",',
  '  "summary": "Concise 1-2 sentence synthesis of the review pass",',
  '  "findings": [',
  "    {",
  '      "category": "must_fix | informational | no_action",',
  '      "severity": "critical | high | medium | low | info",',
  '      "path": "src/path/to/file.ts",',
  '      "line": 1,',
  '      "title": "Short actionable finding title",',
  '      "rationale": "Why this violates an invariant, spec requirement, or quality bar",',
  '      "suggested_action": "Concrete minimal fix required"',
  "    }",
  "  ]",
  "}",
  "```",
  "- Use `must_fix` ONLY for objective correctness bugs, broken domain invariants, security flaws, missing spec requirements, or blocking accessibility/UX failures.",
  "- Use `informational` for non-blocking suggestions."
].join("\n");
function buildDefaultReviewerRosterFiles(params) {
  const repo = params.repository.trim() || "consumer/repo";
  return [
    {
      name: "domain-backend-reviewer",
      path: ".cursor/agents/domain-backend-reviewer.md",
      category: "specialist",
      content: [
        "---",
        "name: domain-backend-reviewer",
        `description: Domain logic, mathematical formulas, state transitions, and backend API specialist reviewer for ${repo}.`,
        "---",
        "",
        `# Domain & Backend Specialist Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        "- Verify domain calculations, mathematical formulas, boundary conditions, and state machine transitions.",
        "- Check error handling, input validation, determinism, and absence of silent data corruption.",
        "- Enforce every domain invariant documented in `GLOSSARY.md` and `docs/adr/*.md`.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "frontend-reviewer",
      path: ".cursor/agents/frontend-reviewer.md",
      category: "specialist",
      content: [
        "---",
        "name: frontend-reviewer",
        `description: Frontend component architecture, state hooks, rendering performance, and client persistence reviewer for ${repo}.`,
        "---",
        "",
        `# Frontend Specialist Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        "- Inspect UI component boundaries, state synchronization, controlled/uncontrolled inputs, and event handlers.",
        "- Verify explicit handling of loading, empty, error, and guard states.",
        "- Prevent state desynchronization, stale closures, unguarded `localStorage` parsing, and broken rendering.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "infra-reviewer",
      path: ".cursor/agents/infra-reviewer.md",
      category: "specialist",
      content: [
        "---",
        "name: infra-reviewer",
        `description: CI/CD workflows, build scripts, package dependencies, and runtime configuration reviewer for ${repo}.`,
        "---",
        "",
        `# Infrastructure & Build Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        "- Audit `package.json`, `tsconfig.json`, `vite.config.*`, and `.github/workflows/*` changes.",
        "- Ensure deterministic builds, pinned dependencies, and zero secret exposure in scripts or workflows.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "architecture-reviewer",
      path: ".cursor/agents/architecture-reviewer.md",
      category: "cross-cutting",
      content: [
        "---",
        "name: architecture-reviewer",
        `description: Module boundaries, deep modules, ADR compliance, and ubiquity of GLOSSARY.md terms for ${repo}.`,
        "---",
        "",
        `# Cross-Cutting Architecture Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        "- Verify strict separation between pure domain models (`src/domain/*`) and UI/IO layers.",
        "- Check compliance with accepted ADRs (`docs/adr/*.md`) and canonical terminology in `GLOSSARY.md`.",
        "- Flag circular dependencies, leaky abstractions, or unnecessary complexity.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "security-reviewer",
      path: ".cursor/agents/security-reviewer.md",
      category: "cross-cutting",
      content: [
        "---",
        "name: security-reviewer",
        `description: Application security, injection prevention, secret hygiene, and privilege boundary reviewer for ${repo}.`,
        "---",
        "",
        `# Cross-Cutting Security Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        "- Detect XSS (`dangerouslySetInnerHTML`), command injection, prototype pollution, and unsafe deserialization.",
        "- Ensure no credentials, tokens, or private keys appear in code, tests, or logs.",
        "- Flag any unauthorized modification of `.github/workflows/**`, `.github/agents.yml`, or `.cursor/agents/**`.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "spec-parity-reviewer",
      path: ".cursor/agents/spec-parity-reviewer.md",
      category: "cross-cutting",
      content: [
        "---",
        "name: spec-parity-reviewer",
        `description: Strict verification of 1-to-1 parity between the approved spec/ticket acceptance criteria and the PR diff for ${repo}.`,
        "---",
        "",
        `# Specification & Acceptance Parity Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        "- Compare every acceptance criterion of the ticket and `docs/specs/*.md` against the implemented code and tests.",
        "- Flag any omitted requirement, partial implementation, or unrequested scope creep.",
        "- Verify that parameterized unit/integration tests actually assert the specified domain rules.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "standards-reviewer",
      path: ".cursor/agents/standards-reviewer.md",
      category: "cross-cutting",
      content: [
        "---",
        "name: standards-reviewer",
        `description: Coding standards, strict TypeScript typing, and parameterized test quality (it.each) reviewer for ${repo}.`,
        "---",
        "",
        `# Coding Standards & Test Quality Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        "- Enforce strict TypeScript types (no `any` or unsafe casts without guard).",
        "- Verify that tests use parameterized `it.each` tables with descriptive test IDs covering nominal and edge cases.",
        "- Ensure surgical, minimal code free of dead imports or speculative abstractions.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "accessibility-reviewer",
      path: ".cursor/agents/accessibility-reviewer.md",
      category: "cross-cutting",
      content: [
        "---",
        "name: accessibility-reviewer",
        `description: WCAG 2.1 AA accessibility, semantic HTML, ARIA attributes, keyboard navigation, and focus management reviewer for ${repo}.`,
        "---",
        "",
        `# Accessibility (WCAG 2.1 AA) Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        '- Verify semantic landmarks (`main`, `nav`, `section`, `form`), explicit `<label>` associations on all form controls, and `aria-live` / `role="alert"` on dynamic validation errors.',
        "- Check keyboard operability (`Tab`, `Enter`, `Space`, `Escape`) and visible focus states.",
        "- Ensure sufficient color contrast and non-color-only status indicators.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "design-reviewer",
      path: ".cursor/agents/design-reviewer.md",
      category: "cross-cutting",
      content: [
        "---",
        "name: design-reviewer",
        `description: Impeccable UI/UX quality gate checking DESIGN.md tokens, responsive layout integrity, and interaction states for ${repo}.`,
        "---",
        "",
        `# Impeccable Design & Layout Reviewer (\`${repo}\`)`,
        "",
        "## Scope & Responsibilities",
        "- Verify compliance with `DESIGN.md` visual tokens, typography hierarchy, and spacing scale.",
        "- Detect responsive layout overflows, broken grid/flex alignments, and missing interaction states (loading, empty, error, disabled).",
        "- Distinguish objective design/layout violations (`must_fix`) from purely subjective aesthetic preferences (`informational`).",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    },
    {
      name: "user-advocate",
      path: ".cursor/agents/user-advocate.md",
      category: "persona",
      content: [
        "---",
        "name: user-advocate",
        `description: Persona-driven UX advocate for ${repo} operating in design-gate (pre-implementation) and implementation-review (PR) modes.`,
        "---",
        "",
        `# User Advocate \u2014 Persona Journey Reviewer (\`${repo}\`)`,
        "",
        "## Operating Modes",
        "1. **`design-gate` (Pre-implementation on `plan/*`)**:",
        "   - Walk the proposed specification and ticket graph through the eyes of each target user persona.",
        "   - Identify missing workflow steps, confusing terminology, unguarded destructive actions, or friction points.",
        "   - Enrich UI tickets with concrete persona acceptance criteria before `/epure approve`.",
        "2. **`implementation-review` (Post-implementation on PRs)**:",
        "   - Walk the implemented UI/API diff as each persona attempting their core task end-to-end.",
        "   - Flag dead-ends, missing feedback when a rule blocks an action, or unreadable outputs as `must_fix`.",
        "",
        "## Default Domain Personas (Adapted during `/epure plan`)",
        "- **Primary Operator / Power User**: Needs fast, accurate feedback, clear constraint explanations, and reliable state persistence.",
        "- **First-Time / Casual User**: Needs self-explanatory labels, safe defaults, and immediate visual guidance when an input is invalid.",
        "",
        JSON_OUTPUT_CONTRACT_BLOCK,
        ""
      ].join("\n")
    }
  ];
}

// src/bootstrap/setup-repo.ts
var DEFAULT_EPURE_PINNED_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
var CONVENTIONAL_COMMIT_PATTERN_REGEX = "^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\\([a-z0-9/-]+\\))?(!)?: .+";
var DEFAULT_AGENTS_CONFIG = {
  harness: "pi",
  models: {
    planning: "claude-sonnet-4-20250514",
    implementation: "claude-sonnet-4-20250514",
    review: "gpt-4.1"
  },
  merge_policy: "strict",
  max_code_fix_attempts: 3,
  max_transient_api_retries: 4,
  transient_retry_backoff_seconds: [5, 15, 45, 120],
  job_timeout_minutes: 60,
  review_timeout_minutes: 30,
  max_concurrent_tasks_per_feature: 3,
  trace_retention_days: 30,
  preview_retention_days: 14,
  github_pages_previews: false
};
var DEFAULT_REPOSITORY_MERGE_SETTINGS = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  delete_branch_on_merge: true,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "PR_BODY"
};
var REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function resolveAgentsConfig(overrides = {}) {
  const sec = overrides.security_overrides;
  if (sec) {
    if (sec.require_write_permission === false) {
      return {
        valid: false,
        error_code: "SECURITY_INVARIANT_VIOLATION",
        error_message: "Local .github/agents.yml cannot disable effective write permission verification (ADR-0004, ADR-0010).",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
    if (sec.sandbox_isolation === false) {
      return {
        valid: false,
        error_code: "SECURITY_INVARIANT_VIOLATION",
        error_message: "Local .github/agents.yml cannot disable untrusted code sandbox isolation (ADR-0011, ADR-0023).",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
    if (sec.allow_agent_release === true) {
      return {
        valid: false,
        error_code: "SECURITY_INVARIANT_VIOLATION",
        error_message: "Local .github/agents.yml cannot grant release authority to the Agent App (ADR-0009, ADR-0010).",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
    if (sec.auto_merge_dev === true || sec.auto_merge_main === true) {
      return {
        valid: false,
        error_code: "SECURITY_INVARIANT_VIOLATION",
        error_message: "Local .github/agents.yml cannot enable automatic merging into 'dev' or 'main' (ADR-0011).",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
  }
  const pagesPreviews = overrides.github_pages_previews ?? DEFAULT_AGENTS_CONFIG.github_pages_previews;
  if (pagesPreviews) {
    if (overrides.github_pages_human_consent !== true || overrides.preview_separate_origin !== true) {
      return {
        valid: false,
        error_code: "PAGES_PREVIEW_CONSENT_OR_ORIGIN_REQUIRED",
        error_message: "GitHub Pages previews require explicit human consent (github_pages_human_consent: true) and an isolated non-production origin (preview_separate_origin: true) per Q70/Q73.",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
  }
  const config = {
    harness: overrides.harness ?? DEFAULT_AGENTS_CONFIG.harness,
    models: {
      planning: overrides.models?.planning ?? DEFAULT_AGENTS_CONFIG.models.planning,
      implementation: overrides.models?.implementation ?? DEFAULT_AGENTS_CONFIG.models.implementation,
      review: overrides.models?.review ?? DEFAULT_AGENTS_CONFIG.models.review
    },
    merge_policy: overrides.merge_policy ?? DEFAULT_AGENTS_CONFIG.merge_policy,
    max_code_fix_attempts: overrides.max_code_fix_attempts ?? DEFAULT_AGENTS_CONFIG.max_code_fix_attempts,
    max_transient_api_retries: overrides.max_transient_api_retries ?? DEFAULT_AGENTS_CONFIG.max_transient_api_retries,
    transient_retry_backoff_seconds: DEFAULT_AGENTS_CONFIG.transient_retry_backoff_seconds,
    job_timeout_minutes: overrides.job_timeout_minutes ?? DEFAULT_AGENTS_CONFIG.job_timeout_minutes,
    review_timeout_minutes: overrides.review_timeout_minutes ?? DEFAULT_AGENTS_CONFIG.review_timeout_minutes,
    max_concurrent_tasks_per_feature: overrides.max_concurrent_tasks_per_feature ?? DEFAULT_AGENTS_CONFIG.max_concurrent_tasks_per_feature,
    trace_retention_days: overrides.trace_retention_days ?? DEFAULT_AGENTS_CONFIG.trace_retention_days,
    preview_retention_days: overrides.preview_retention_days ?? DEFAULT_AGENTS_CONFIG.preview_retention_days,
    github_pages_previews: pagesPreviews
  };
  return {
    valid: true,
    error_code: "NONE",
    error_message: "",
    config
  };
}
function serializeAgentsConfigYaml(config, taskAutoMergeEnabled) {
  return [
    "# EPURE Consumer Repository Configuration (.github/agents.yml)",
    "# Generated by setup-repo \u2014 security boundaries are enforced by shared workflows (ADR-0010, ADR-0023).",
    `harness: ${config.harness}`,
    "models:",
    `  planning: ${config.models.planning}`,
    `  implementation: ${config.models.implementation}`,
    `  review: ${config.models.review}`,
    `merge_policy: ${config.merge_policy}`,
    `task_auto_merge_enabled: ${taskAutoMergeEnabled}`,
    `max_code_fix_attempts: ${config.max_code_fix_attempts}`,
    `max_transient_api_retries: ${config.max_transient_api_retries}`,
    `transient_retry_backoff_seconds: [${config.transient_retry_backoff_seconds.join(", ")}]`,
    `job_timeout_minutes: ${config.job_timeout_minutes}`,
    `review_timeout_minutes: ${config.review_timeout_minutes}`,
    `max_concurrent_tasks_per_feature: ${config.max_concurrent_tasks_per_feature}`,
    `trace_retention_days: ${config.trace_retention_days}`,
    `preview_retention_days: ${config.preview_retention_days}`,
    `github_pages_previews: ${config.github_pages_previews}`,
    "security_invariants:",
    "  require_write_permission: true",
    "  sandbox_isolation: true",
    "  allow_agent_release: false",
    "  auto_merge_dev: false",
    "  auto_merge_main: false",
    ""
  ].join("\n");
}
function buildCallerWorkflows(pinnedSha) {
  return [
    {
      path: ".github/workflows/epure-issue-command.yml",
      content: [
        'name: "EPURE Issue Command Gate"',
        "on:",
        "  issue_comment:",
        "    types: [created]",
        "permissions:",
        "  contents: write",
        "  issues: write",
        "  pull-requests: write",
        "  checks: write",
        "jobs:",
        "  authorize-command:",
        '    name: "Authorize /epure Issue Command"',
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 10",
        "    permissions:",
        "      contents: read",
        "      issues: write",
        "    outputs:",
        "      authorized: ${{ steps.gate.outputs.authorized }}",
        "      decision: ${{ steps.gate.outputs.decision }}",
        "      command: ${{ steps.gate.outputs.command }}",
        "      command_args: ${{ steps.gate.outputs.command_args }}",
        "    steps:",
        "      - name: Run pre-bundled EPURE authorization gate",
        "        id: gate",
        `        uses: Giskard-AI/epure/actions/authorize-command@${pinnedSha} # v1.1.0`,
        "        with:",
        "          repository: ${{ github.repository }}",
        "          issue_number: ${{ github.event.issue.number }}",
        "          comment_body: ${{ github.event.comment.body }}",
        "          actor: ${{ github.event.comment.user.login }}",
        "          actor_type: ${{ github.event.comment.user.type }}",
        '          allow_implicit_planning_reply: "true"',
        "          github_token: ${{ secrets.GITHUB_TOKEN }}",
        "",
        "  orchestrate-command:",
        '    name: "Orchestrate Authorized /epure Lifecycle"',
        "    needs: authorize-command",
        "    if: ${{ needs.authorize-command.outputs.authorized == 'true' }}",
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 60",
        "    environment: gemini",
        "    concurrency:",
        "      group: epure-issue-${{ github.event.issue.number }}",
        "      cancel-in-progress: false",
        "    permissions:",
        "      contents: write",
        "      issues: write",
        "      pull-requests: write",
        "      checks: write",
        "    steps:",
        "      - name: Run pre-bundled EPURE issue orchestrator",
        "        id: orchestrate",
        `        uses: Giskard-AI/epure/actions/orchestrate-issue@${pinnedSha} # v1.1.0`,
        "        with:",
        "          repository: ${{ github.repository }}",
        "          issue_number: ${{ github.event.issue.number }}",
        "          command: ${{ needs.authorize-command.outputs.command }}",
        "          command_args: ${{ needs.authorize-command.outputs.command_args }}",
        "          comment_id: ${{ github.event.comment.id }}",
        "          actor: ${{ github.event.comment.user.login }}",
        "          agent_app_id: ${{ secrets.EPURE_AGENT_APP_ID }}",
        "          agent_app_private_key: ${{ secrets.EPURE_AGENT_APP_PRIVATE_KEY }}",
        "          github_token: ${{ secrets.GITHUB_TOKEN }}",
        "          llm_api_key: ${{ secrets.LLM_API_KEY }}",
        ""
      ].join("\n")
    },
    {
      path: ".github/workflows/epure-check.yml",
      content: [
        'name: "EPURE Contract Verification"',
        "on:",
        "  pull_request:",
        "    branches: [dev, main, 'feature/**']",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  verify-contract:",
        `    uses: Giskard-AI/epure/.github/workflows/epure-check.yml@${pinnedSha} # v1.1.0`,
        "    with:",
        "      repository: ${{ github.repository }}",
        `      pinned_ref: "Giskard-AI/epure/.github/workflows/epure-check.yml@${pinnedSha} # v1.1.0"`,
        "      strict_sha_pinning: true",
        ""
      ].join("\n")
    },
    {
      path: ".github/workflows/pr-title.yml",
      content: [
        `# Managed by Giskard-AI/epure@${pinnedSha} # v1.1.0`,
        'name: "Conventional Commit PR Title"',
        "on:",
        "  pull_request:",
        "    types: [opened, edited, synchronize, reopened]",
        "    branches: [dev, main, 'feature/**']",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  pr-title:",
        '    name: "PR title"',
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 5",
        "    steps:",
        "      - name: Validate Conventional Commit PR title",
        "        env:",
        "          PR_TITLE: ${{ github.event.pull_request.title }}",
        "        run: |",
        `          PATTERN='${CONVENTIONAL_COMMIT_PATTERN_REGEX}'`,
        '          if [[ ! "$PR_TITLE" =~ $PATTERN ]]; then',
        '            echo "::error::PR title must follow Conventional Commits: $PATTERN (got: $PR_TITLE)"',
        "            exit 1",
        "          fi",
        ""
      ].join("\n")
    },
    {
      path: ".github/workflows/release.yml",
      content: [
        'name: "EPURE Controlled Release (dev -> main)"',
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      version_tag:",
        '        description: "Immutable SemVer tag (vMAJOR.MINOR.PATCH)"',
        "        required: true",
        "        type: string",
        "permissions:",
        "  contents: write",
        "jobs:",
        "  release:",
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 30",
        "    environment: release",
        "    steps:",
        "      - name: Verify Release App boundary",
        `        uses: Giskard-AI/epure/actions/verify-app-role@${pinnedSha} # v1.1.0`,
        "        with:",
        '          app_role: "release"',
        '          operation: "promote_dev_to_main"',
        '          target_ref: "refs/heads/main"',
        '          workflow_path: ".github/workflows/release.yml"',
        '          environment_name: "release"',
        ""
      ].join("\n")
    }
  ];
}
function computeFilePlanAction(repoRootDir, relPath, desiredContent) {
  if (!repoRootDir) {
    return "create";
  }
  const fullPath = join(repoRootDir, relPath);
  if (!existsSync(fullPath)) {
    return "create";
  }
  const existing = readFileSync(fullPath, "utf8");
  return existing === desiredContent ? "noop" : "update";
}
function buildGovernanceRulesets(params) {
  const requiredChecks = [
    "verify-contract / Verify EPURE Consumer Contract",
    "PR title",
    "ai-review"
  ];
  const featureGovernance = {
    name: "epure-feature-governance",
    enforcement: "active",
    targetRefs: ["refs/heads/feature/*"],
    blockDirectPushes: true,
    blockForcePushes: true,
    blockDeletions: true,
    requiredLinearHistory: true,
    allowedMergeMethods: ["squash"],
    requiredApprovingReviewCount: 0,
    requiredStatusChecks: requiredChecks,
    commitMessagePattern: CONVENTIONAL_COMMIT_PATTERN_REGEX,
    bypassActors: [
      {
        appRole: "agent",
        appName: params.agentAppName,
        mode: "pull_request"
      }
    ]
  };
  const devGovernance = {
    name: "epure-dev-governance",
    enforcement: "active",
    targetRefs: ["refs/heads/dev"],
    blockDirectPushes: true,
    blockForcePushes: true,
    blockDeletions: true,
    requiredLinearHistory: true,
    allowedMergeMethods: ["squash"],
    requiredApprovingReviewCount: params.requirePrApprovalsOnDev ?? 0,
    requiredStatusChecks: requiredChecks,
    commitMessagePattern: CONVENTIONAL_COMMIT_PATTERN_REGEX,
    bypassActors: []
  };
  const releaseImmutability = {
    name: "epure-release-immutability",
    enforcement: "active",
    targetRefs: ["refs/heads/main", "refs/tags/v*"],
    blockDirectPushes: true,
    blockForcePushes: true,
    blockDeletions: true,
    bypassActors: [
      {
        appRole: "release",
        appName: params.releaseAppName,
        mode: "always"
      }
    ]
  };
  return {
    featureGovernance,
    devGovernance,
    releaseImmutability,
    all: [featureGovernance, devGovernance, releaseImmutability]
  };
}
function planAndApplyRepoSetup(input) {
  const repository = input.repository.trim();
  const dryRun = input.dryRun ?? true;
  const pinnedSha = (input.epurePinnedSha ?? DEFAULT_EPURE_PINNED_SHA).trim();
  const resolvedConfig = resolveAgentsConfig(input.agentsOverrides);
  const ownerSlug = repository.split("/")[0] ?? "consumer";
  const manifests = buildConsumerAppManifests({ ownerSlug, repository });
  const rulesetBundle = buildGovernanceRulesets({
    agentAppName: manifests.agentApp.name,
    releaseAppName: manifests.releaseApp.name,
    requirePrApprovalsOnDev: input.requirePrApprovalsOnDev
  });
  const rulesetSpec = rulesetBundle.releaseImmutability;
  const governanceRulesets = rulesetBundle.all;
  const releaseEnvironment = {
    name: "release",
    requiredReviewers: true,
    boundSecrets: ["EPURE_RELEASE_APP_ID", "EPURE_RELEASE_APP_PRIVATE_KEY"]
  };
  const branchProtections = [
    {
      pattern: "dev",
      requirePullRequest: true,
      requireStatusChecks: true,
      requiredChecks: ["verify-contract", "PR title", "ai-review"],
      requireHumanApproval: true,
      allowedMergeMethods: ["squash"],
      allowMergeCommit: false,
      allowRebaseMerge: false
    },
    {
      pattern: "feature/*",
      requirePullRequest: true,
      requireStatusChecks: true,
      requiredChecks: ["verify-contract", "PR title", "ai-review"],
      requireHumanApproval: false,
      allowedMergeMethods: ["squash"],
      allowMergeCommit: false,
      allowRebaseMerge: false
    }
  ];
  const expectedSecrets = [
    {
      name: "EPURE_AGENT_APP_ID",
      scope: "repository_or_org",
      description: "Consumer Agent App ID for development operations"
    },
    {
      name: "EPURE_AGENT_APP_PRIVATE_KEY",
      scope: "repository_or_org",
      description: "Consumer Agent App PEM private key (never exposed to agent sandbox)"
    },
    {
      name: "EPURE_RELEASE_APP_ID",
      scope: "release_environment",
      description: "Consumer Release App ID bound to the protected 'release' environment"
    },
    {
      name: "EPURE_RELEASE_APP_PRIVATE_KEY",
      scope: "release_environment",
      description: "Consumer Release App PEM private key bound to the 'release' environment"
    },
    {
      name: "LLM_API_KEY",
      scope: "repository_or_org",
      description: "LLM provider API key held exclusively by the runner-local proxy sidecar"
    }
  ];
  if (!REPO_SLUG_PATTERN.test(repository)) {
    return {
      status: "error",
      dry_run: dryRun,
      error_code: "INVALID_REPOSITORY_SLUG",
      error_message: `Invalid repository slug '${repository}'; expected '<owner>/<repo>'.`,
      repository,
      agents_config: resolvedConfig.config,
      agents_config_action: "noop",
      planned_workflows: [],
      planned_reviewer_roster: [],
      expected_secrets: expectedSecrets,
      repository_merge_settings: DEFAULT_REPOSITORY_MERGE_SETTINGS,
      branch_protections: branchProtections,
      ruleset_spec: rulesetSpec,
      governance_rulesets: governanceRulesets,
      ruleset_action: "noop",
      apps_action: "noop",
      release_environment: releaseEnvironment,
      task_auto_merge_enabled: false,
      auto_merge_warning_code: "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS",
      human_interventions: [],
      mutated_files: [],
      summary_markdown: "### EPURE setup-repo Error (`INVALID_REPOSITORY_SLUG`)"
    };
  }
  if (!resolvedConfig.valid) {
    return {
      status: "error",
      dry_run: dryRun,
      error_code: resolvedConfig.error_code,
      error_message: resolvedConfig.error_message,
      repository,
      agents_config: resolvedConfig.config,
      agents_config_action: "noop",
      planned_workflows: [],
      planned_reviewer_roster: [],
      expected_secrets: expectedSecrets,
      repository_merge_settings: DEFAULT_REPOSITORY_MERGE_SETTINGS,
      branch_protections: branchProtections,
      ruleset_spec: rulesetSpec,
      governance_rulesets: governanceRulesets,
      ruleset_action: "noop",
      apps_action: "noop",
      release_environment: releaseEnvironment,
      task_auto_merge_enabled: false,
      auto_merge_warning_code: "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS",
      human_interventions: [],
      mutated_files: [],
      summary_markdown: `### EPURE setup-repo Blocked (\`${resolvedConfig.error_code}\`)
- ${resolvedConfig.error_message}`
    };
  }
  const hasCi = input.existingState?.hasRequiredCiChecks === true;
  const hasProtection = input.existingState?.hasBranchProtection === true;
  const taskAutoMergeEnabled = hasCi && hasProtection;
  const autoMergeWarningCode = taskAutoMergeEnabled ? "NONE" : "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS";
  const agentsYamlContent = serializeAgentsConfigYaml(
    resolvedConfig.config,
    taskAutoMergeEnabled
  );
  const agentsConfigAction = computeFilePlanAction(
    input.repoRootDir,
    ".github/agents.yml",
    agentsYamlContent
  );
  const workflowTemplates = buildCallerWorkflows(pinnedSha);
  const plannedWorkflows = workflowTemplates.map((wf) => ({
    path: wf.path,
    action: computeFilePlanAction(input.repoRootDir, wf.path, wf.content),
    content: wf.content
  }));
  const rosterTemplates = buildDefaultReviewerRosterFiles({ repository });
  const plannedReviewerRoster = rosterTemplates.map(
    (item) => ({
      name: item.name,
      path: item.path,
      action: computeFilePlanAction(input.repoRootDir, item.path, item.content),
      content: item.content
    })
  );
  const existingApps = new Set(input.existingState?.existingAppNames ?? []);
  const appsAction = existingApps.has(manifests.agentApp.name) && existingApps.has(manifests.releaseApp.name) ? "noop" : "create";
  const existingRulesets = new Set(
    input.existingState?.existingRulesetNames ?? []
  );
  const rulesetAction = existingRulesets.has(
    rulesetSpec.name
  ) ? "noop" : "create";
  const mutatedFiles = [];
  if (!dryRun && input.repoRootDir) {
    if (agentsConfigAction !== "noop") {
      const targetPath = join(input.repoRootDir, ".github/agents.yml");
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, agentsYamlContent, "utf8");
      mutatedFiles.push(".github/agents.yml");
    }
    for (const wf of plannedWorkflows) {
      if (wf.action !== "noop") {
        const targetPath = join(input.repoRootDir, wf.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, wf.content, "utf8");
        mutatedFiles.push(wf.path);
      }
    }
    for (const agentFile of plannedReviewerRoster) {
      if (agentFile.action !== "noop") {
        const targetPath = join(input.repoRootDir, agentFile.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, agentFile.content, "utf8");
        mutatedFiles.push(agentFile.path);
      }
    }
  }
  const humanInterventions = [
    {
      id: "provision_dual_github_apps",
      title: "Register & install consumer Agent App and Release App",
      details: `Create '${manifests.agentApp.name}' and '${manifests.releaseApp.name}' scoped strictly to '${repository}'.`
    },
    {
      id: "configure_repository_or_org_secrets",
      title: "Provision encrypted GitHub Secrets & LLM key locally",
      details: "Use 'gh secret set' locally for EPURE_AGENT_APP_ID, EPURE_AGENT_APP_PRIVATE_KEY, LLM_API_KEY, and environment-scoped EPURE_RELEASE_APP_ID / EPURE_RELEASE_APP_PRIVATE_KEY."
    },
    {
      id: "apply_branch_protections_and_release_ruleset",
      title: "Confirm 3 Repository Rulesets (feature/*, dev, main+v*) and squash-only merge settings",
      details: `Run 'setup-repo --apply --apply-github-settings' to enforce squash-only merges and provision 'epure-feature-governance', 'epure-dev-governance', and '${rulesetSpec.name}'.`
    }
  ];
  const summaryMarkdown = [
    `### EPURE setup-repo (${dryRun ? "Dry-Run Simulation" : "Guided Application"})`,
    `- **Repository**: \`${repository}\``,
    `- **Merge Governance**: \`squash-only\` (\`allow_merge_commit=false\`, \`allow_rebase_merge=false\`, \`delete_branch_on_merge=true\`)`,
    `- **Agents Config (\`.github/agents.yml\`)**: \`${agentsConfigAction}\` (harness=\`${resolvedConfig.config.harness}\`, merge_policy=\`${resolvedConfig.config.merge_policy}\`)`,
    `- **Reviewer Roster (\`.cursor/agents/*.md\`)**: \`${plannedReviewerRoster.length}\` agents (specialists + cross-cutting + \`user-advocate\`)`,
    `- **Task Auto-Merge Enabled**: \`${taskAutoMergeEnabled}\` (${autoMergeWarningCode})`,
    `- **Governance Rulesets**: ${governanceRulesets.map((r) => `\`${r.name}\``).join(", ")}`,
    `- **Mutated Files**: ${mutatedFiles.length > 0 ? mutatedFiles.map((f) => `\`${f}\``).join(", ") : "none"}`
  ].join("\n");
  return {
    status: dryRun ? "dry_run" : "applied",
    dry_run: dryRun,
    error_code: "NONE",
    error_message: "",
    repository,
    agents_config: resolvedConfig.config,
    agents_config_action: agentsConfigAction,
    planned_workflows: plannedWorkflows,
    planned_reviewer_roster: plannedReviewerRoster,
    expected_secrets: expectedSecrets,
    repository_merge_settings: DEFAULT_REPOSITORY_MERGE_SETTINGS,
    branch_protections: branchProtections,
    ruleset_spec: rulesetSpec,
    governance_rulesets: governanceRulesets,
    ruleset_action: rulesetAction,
    apps_action: appsAction,
    release_environment: releaseEnvironment,
    task_auto_merge_enabled: taskAutoMergeEnabled,
    auto_merge_warning_code: autoMergeWarningCode,
    human_interventions: humanInterventions,
    mutated_files: mutatedFiles,
    summary_markdown: summaryMarkdown
  };
}
function buildGitHubRulesetApiPayload(spec, appIntegrationIds) {
  const bypassActors = [];
  for (const actor of spec.bypassActors) {
    const actorId = actor.appRole === "agent" ? appIntegrationIds.agentAppIntegrationId : appIntegrationIds.releaseAppIntegrationId;
    if (typeof actorId === "number" && actorId > 0) {
      bypassActors.push({
        actor_id: actorId,
        actor_type: "Integration",
        bypass_mode: actor.mode
      });
    }
  }
  const rules = [];
  if (spec.blockDeletions) {
    rules.push({ type: "deletion" });
  }
  if (spec.blockForcePushes) {
    rules.push({ type: "non_fast_forward" });
  }
  if (spec.requiredLinearHistory) {
    rules.push({ type: "required_linear_history" });
  }
  if (spec.blockDirectPushes) {
    rules.push({
      type: "pull_request",
      parameters: {
        allowed_merge_methods: spec.allowedMergeMethods ?? ["squash"],
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: spec.requiredApprovingReviewCount ?? 0,
        required_review_thread_resolution: true
      }
    });
  }
  if (spec.commitMessagePattern) {
    rules.push({
      type: "commit_message_pattern",
      parameters: {
        name: "Conventional Commit format",
        negate: false,
        operator: "regex",
        pattern: spec.commitMessagePattern
      }
    });
  }
  return {
    name: spec.name,
    target: "branch",
    enforcement: spec.enforcement,
    bypass_actors: bypassActors,
    conditions: {
      ref_name: {
        include: [...spec.targetRefs],
        exclude: []
      }
    },
    rules
  };
}
async function applyGitHubRepositoryGovernance(input) {
  const [owner, repo] = input.repository.trim().split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository slug '${input.repository}'.`);
  }
  const fetchFn = input.fetchImpl ?? fetch;
  const baseUrl = "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${input.githubToken.trim()}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const patchRepoResp = await fetchFn(`${baseUrl}/repos/${owner}/${repo}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(DEFAULT_REPOSITORY_MERGE_SETTINGS)
  });
  if (!patchRepoResp.ok) {
    const errText = await patchRepoResp.text();
    throw new Error(
      `Failed to configure squash-only settings on ${input.repository} (HTTP ${patchRepoResp.status}): ${errText}`
    );
  }
  const listRulesetsResp = await fetchFn(
    `${baseUrl}/repos/${owner}/${repo}/rulesets`,
    {
      method: "GET",
      headers
    }
  );
  if (!listRulesetsResp.ok) {
    const errText = await listRulesetsResp.text();
    throw new Error(
      `Failed to list rulesets on ${input.repository} (HTTP ${listRulesetsResp.status}): ${errText}`
    );
  }
  const existingRulesets = await listRulesetsResp.json();
  const existingByName = /* @__PURE__ */ new Map();
  for (const r of existingRulesets) {
    existingByName.set(r.name, r.id);
  }
  const rulesetsApplied = [];
  for (const spec of input.governanceRulesets) {
    const payload = buildGitHubRulesetApiPayload(spec, {
      agentAppIntegrationId: input.agentAppIntegrationId,
      releaseAppIntegrationId: input.releaseAppIntegrationId
    });
    const existingId = existingByName.get(spec.name);
    if (typeof existingId === "number") {
      const updateResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/rulesets/${existingId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify(payload)
        }
      );
      if (!updateResp.ok) {
        const errText = await updateResp.text();
        throw new Error(
          `Failed to update ruleset '${spec.name}' on ${input.repository} (HTTP ${updateResp.status}): ${errText}`
        );
      }
      rulesetsApplied.push({
        name: spec.name,
        action: "updated",
        id: existingId
      });
    } else {
      const createResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/rulesets`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        }
      );
      if (!createResp.ok) {
        const errText = await createResp.text();
        throw new Error(
          `Failed to create ruleset '${spec.name}' on ${input.repository} (HTTP ${createResp.status}): ${errText}`
        );
      }
      const createdData = await createResp.json();
      rulesetsApplied.push({
        name: spec.name,
        action: "created",
        id: createdData.id ?? 0
      });
    }
  }
  return {
    applied: true,
    merge_settings_updated: true,
    rulesets_applied: rulesetsApplied
  };
}

// src/bootstrap/cli.ts
function parseArgs(argv) {
  let repository = "";
  let repoRootDir;
  let epurePinnedSha;
  let requirePrApprovalsOnDev;
  let applyGithubSettings = false;
  let githubToken;
  let agentAppIntegrationId;
  let releaseAppIntegrationId;
  let dryRun = true;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo" && argv[i + 1]) {
      repository = argv[i + 1] ?? "";
      i += 1;
    } else if ((arg === "--dir" || arg === "--repo-root") && argv[i + 1]) {
      repoRootDir = argv[i + 1];
      i += 1;
    } else if (arg === "--pinned-sha" && argv[i + 1]) {
      epurePinnedSha = argv[i + 1];
      i += 1;
    } else if (arg === "--require-pr-approvals" && argv[i + 1]) {
      requirePrApprovalsOnDev = Number.parseInt(argv[i + 1] ?? "0", 10);
      i += 1;
    } else if (arg === "--github-token" && argv[i + 1]) {
      githubToken = argv[i + 1];
      i += 1;
    } else if (arg === "--agent-app-id" && argv[i + 1]) {
      agentAppIntegrationId = Number.parseInt(argv[i + 1] ?? "0", 10);
      i += 1;
    } else if (arg === "--release-app-id" && argv[i + 1]) {
      releaseAppIntegrationId = Number.parseInt(argv[i + 1] ?? "0", 10);
      i += 1;
    } else if (arg === "--apply-github-settings") {
      applyGithubSettings = true;
    } else if (arg === "--apply") {
      dryRun = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    }
  }
  return {
    repository,
    repoRootDir,
    epurePinnedSha,
    requirePrApprovalsOnDev,
    applyGithubSettings,
    githubToken,
    agentAppIntegrationId,
    releaseAppIntegrationId,
    dryRun,
    json
  };
}
function resolveGitHubToken(explicitToken) {
  if (explicitToken && explicitToken.trim()) {
    return explicitToken.trim();
  }
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken && envToken.trim()) {
    return envToken.trim();
  }
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = planAndApplyRepoSetup({
    repository: args.repository,
    repoRootDir: args.repoRootDir,
    epurePinnedSha: args.epurePinnedSha,
    requirePrApprovalsOnDev: args.requirePrApprovalsOnDev,
    dryRun: args.dryRun
  });
  if (result.status !== "error" && !args.dryRun && args.applyGithubSettings) {
    const token = resolveGitHubToken(args.githubToken);
    if (!token) {
      throw new Error(
        "Missing GitHub token for --apply-github-settings. Authenticate via 'gh auth login' or set GITHUB_TOKEN."
      );
    }
    await applyGitHubRepositoryGovernance({
      repository: args.repository,
      githubToken: token,
      governanceRulesets: result.governance_rulesets,
      agentAppIntegrationId: args.agentAppIntegrationId,
      releaseAppIntegrationId: args.releaseAppIntegrationId
    });
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
  } else {
    process.stdout.write(`${result.summary_markdown}
`);
  }
  if (result.status === "error") {
    process.exitCode = 1;
  }
}
void main();
