import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildRenovateConfigJson,
  buildStackAwareCiWorkflowYaml,
  buildZizmorConfigYaml,
  detectRepositoryStack
} from "../src/bootstrap/ci-and-renovate.js";
import {
  DEFAULT_AGENTS_CONFIG,
  DEFAULT_EPURE_PINNED_SHA,
  planAndApplyRepoSetup,
  resolveAgentsConfig,
  validateOrgSecretSharingScope
} from "../src/bootstrap/setup-repo.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SETUP_REPO_CLI_PATH = join(
  ROOT_DIR,
  "dist",
  "cli",
  "setup-repo.mjs"
);
const SETUP_REPO_SKILL_PATH = join(
  ROOT_DIR,
  ".agents",
  "skills",
  "setup-repo",
  "SKILL.md"
);

describe("1. Dry-run simulation & guided application (planAndApplyRepoSetup)", () => {
  it("previews workflows, policies, secrets, 3 governance rulesets, reviewer roster, and protections in dry-run mode without mutating disk", () => {
    const tempRepoDir = mkdtempSync(join(tmpdir(), "epure-setup-dryrun-"));
    try {
      const result = planAndApplyRepoSetup({
        repository: "acme-org/payments",
        repoRootDir: tempRepoDir,
        dryRun: true,
        epurePinnedSha: DEFAULT_EPURE_PINNED_SHA,
        existingState: {
          hasRequiredCiChecks: true,
          hasBranchProtection: true
        }
      });

      expect(result.status).toBe("dry_run");
      expect(result.dry_run).toBe(true);
      expect(result.mutated_files).toHaveLength(0);
      expect(existsSync(join(tempRepoDir, ".github", "agents.yml"))).toBe(false);

      expect(result.planned_workflows.map((w) => w.path)).toEqual([
        ".github/workflows/epure-issue-command.yml",
        ".github/workflows/epure-check.yml",
        ".github/workflows/pr-title.yml",
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml"
      ]);
      for (const wf of result.planned_workflows) {
        expect(wf.action).toBe("create");
        expect(wf.content).toContain(`@${DEFAULT_EPURE_PINNED_SHA} # v1.1.0`);
      }

      expect(result.planned_reviewer_roster).toHaveLength(10);
      expect(
        result.planned_reviewer_roster.map((r) => r.name)
      ).toEqual(
        expect.arrayContaining([
          "domain-backend-reviewer",
          "frontend-reviewer",
          "infra-reviewer",
          "architecture-reviewer",
          "security-reviewer",
          "spec-parity-reviewer",
          "standards-reviewer",
          "accessibility-reviewer",
          "design-reviewer",
          "user-advocate"
        ])
      );

      expect(result.expected_secrets.map((s) => s.name)).toEqual(
        expect.arrayContaining([
          "EPURE_AGENT_APP_ID",
          "EPURE_AGENT_APP_PRIVATE_KEY",
          "EPURE_RELEASE_APP_ID",
          "EPURE_RELEASE_APP_PRIVATE_KEY",
          "LLM_API_KEY"
        ])
      );

      // Verify Q80 & Q91 3 Repository Rulesets
      expect(result.governance_rulesets.map((r) => r.name)).toEqual([
        "epure-feature-governance",
        "epure-dev-governance",
        "epure-release-immutability"
      ]);
      expect(result.ruleset_spec.targetRefs).toEqual([
        "refs/heads/main",
        "refs/tags/v*"
      ]);
      expect(result.ruleset_spec.blockDirectPushes).toBe(true);
      expect(result.ruleset_spec.blockForcePushes).toBe(true);
      expect(result.ruleset_spec.blockDeletions).toBe(true);
      expect(result.ruleset_spec.bypassActors).toEqual([
        {
          appRole: "release",
          appName: "acme-org-epure-release",
          mode: "always"
        }
      ]);
      expect(result.release_environment.name).toBe("release");
      expect(result.release_environment.requiredReviewers).toBe(true);
      expect(result.branch_protections.map((b) => b.pattern)).toEqual([
        "dev",
        "feature/*"
      ]);
      expect(result.repository_merge_settings).toEqual({
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        delete_branch_on_merge: true,
        squash_merge_commit_title: "PR_TITLE",
        squash_merge_commit_message: "PR_BODY"
      });
    } finally {
      rmSync(tempRepoDir, { recursive: true, force: true });
    }
  });

  it("applies the minimal functional setup and .cursor/agents/ roster on disk and reports required human interventions when dryRun is false", () => {
    const tempRepoDir = mkdtempSync(join(tmpdir(), "epure-setup-apply-"));
    try {
      const result = planAndApplyRepoSetup({
        repository: "acme-org/payments",
        repoRootDir: tempRepoDir,
        dryRun: false,
        epurePinnedSha: DEFAULT_EPURE_PINNED_SHA,
        existingState: {
          hasRequiredCiChecks: true,
          hasBranchProtection: true
        }
      });

      expect(result.status).toBe("applied");
      expect(result.dry_run).toBe(false);
      expect(result.mutated_files).toEqual(
        expect.arrayContaining([
          ".github/agents.yml",
          ".github/workflows/epure-issue-command.yml",
          ".github/workflows/epure-check.yml",
          ".github/workflows/pr-title.yml",
          ".github/workflows/release.yml",
          ".cursor/agents/domain-backend-reviewer.md",
          ".cursor/agents/frontend-reviewer.md",
          ".cursor/agents/user-advocate.md"
        ])
      );

      const agentsYmlPath = join(tempRepoDir, ".github", "agents.yml");
      expect(existsSync(agentsYmlPath)).toBe(true);
      const agentsYmlContent = readFileSync(agentsYmlPath, "utf8");
      expect(agentsYmlContent).toContain("max_code_fix_attempts: 3");
      expect(agentsYmlContent).toContain("max_transient_api_retries: 4");
      expect(agentsYmlContent).toContain("job_timeout_minutes: 60");
      expect(agentsYmlContent).toContain("review_timeout_minutes: 30");
      expect(agentsYmlContent).toContain("max_concurrent_tasks_per_feature: 3");
      expect(agentsYmlContent).toContain("trace_retention_days: 30");
      expect(agentsYmlContent).toContain("preview_retention_days: 14");

      expect(result.human_interventions.length).toBeGreaterThanOrEqual(3);
      expect(result.human_interventions.map((h) => h.id)).toEqual(
        expect.arrayContaining([
          "provision_dual_github_apps",
          "configure_repository_or_org_secrets",
          "apply_branch_protections_and_release_ruleset"
        ])
      );
    } finally {
      rmSync(tempRepoDir, { recursive: true, force: true });
    }
  });
});

describe("2. .github/agents.yml defaults (Q78) and non-weakenable security invariants (resolveAgentsConfig)", () => {
  it("provides the exact Q78 operational defaults when no overrides are given", () => {
    const resolved = resolveAgentsConfig({});
    expect(resolved.valid).toBe(true);
    expect(resolved.error_code).toBe("NONE");
    expect(resolved.config).toEqual(DEFAULT_AGENTS_CONFIG);
    expect(resolved.config).toMatchObject({
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
    });
  });

  it.each([
    {
      id: "allows-valid-custom-harness-codex-and-relaxed-merge-policy",
      overrides: {
        harness: "codex" as const,
        merge_policy: "relaxed" as const,
        max_concurrent_tasks_per_feature: 2
      },
      expectedValid: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "rejects-disabling-effective-write-permission-check",
      overrides: {
        security_overrides: {
          require_write_permission: false
        }
      },
      expectedValid: false,
      expectedErrorCode: "SECURITY_INVARIANT_VIOLATION"
    },
    {
      id: "rejects-disabling-sandbox-isolation-for-untrusted-code",
      overrides: {
        security_overrides: {
          sandbox_isolation: false
        }
      },
      expectedValid: false,
      expectedErrorCode: "SECURITY_INVARIANT_VIOLATION"
    },
    {
      id: "rejects-granting-release-authority-to-agent-app",
      overrides: {
        security_overrides: {
          allow_agent_release: true
        }
      },
      expectedValid: false,
      expectedErrorCode: "SECURITY_INVARIANT_VIOLATION"
    },
    {
      id: "rejects-enabling-auto-merge-into-dev-or-main",
      overrides: {
        security_overrides: {
          auto_merge_dev: true
        }
      },
      expectedValid: false,
      expectedErrorCode: "SECURITY_INVARIANT_VIOLATION"
    },
    {
      id: "rejects-github-pages-previews-without-explicit-human-consent-and-isolated-origin",
      overrides: {
        github_pages_previews: true,
        github_pages_human_consent: false,
        preview_separate_origin: false
      },
      expectedValid: false,
      expectedErrorCode: "PAGES_PREVIEW_CONSENT_OR_ORIGIN_REQUIRED"
    },
    {
      id: "allows-github-pages-previews-when-human-consent-and-isolated-origin-are-confirmed",
      overrides: {
        github_pages_previews: true,
        github_pages_human_consent: true,
        preview_separate_origin: true
      },
      expectedValid: true,
      expectedErrorCode: "NONE"
    }
  ])("$id", ({ overrides, expectedValid, expectedErrorCode }) => {
    const res = resolveAgentsConfig(overrides);
    expect(res.valid).toBe(expectedValid);
    expect(res.error_code).toBe(expectedErrorCode);
  });
});

describe("3. Idempotent second pass & fail-safe auto-merge disabling", () => {
  it("does not duplicate or overwrite identical files on a second pass", () => {
    const tempRepoDir = mkdtempSync(join(tmpdir(), "epure-setup-idempotent-"));
    try {
      const firstPass = planAndApplyRepoSetup({
        repository: "acme-org/payments",
        repoRootDir: tempRepoDir,
        dryRun: false,
        epurePinnedSha: DEFAULT_EPURE_PINNED_SHA,
        existingState: {
          hasRequiredCiChecks: true,
          hasBranchProtection: true,
          existingAppNames: [],
          existingRulesetNames: []
        }
      });
      // 1 agents.yml + 1 zizmor.yml + 1 renovate.json + 5 workflows + 10 reviewer roster files = 18 files
      expect(firstPass.mutated_files).toHaveLength(18);
      expect(existsSync(join(tempRepoDir, "renovate.json"))).toBe(true);
      expect(existsSync(join(tempRepoDir, ".github", "zizmor.yml"))).toBe(true);
      expect(existsSync(join(tempRepoDir, ".github", "workflows", "ci.yml"))).toBe(true);

      const secondPass = planAndApplyRepoSetup({
        repository: "acme-org/payments",
        repoRootDir: tempRepoDir,
        dryRun: false,
        epurePinnedSha: DEFAULT_EPURE_PINNED_SHA,
        existingState: {
          hasRequiredCiChecks: true,
          hasBranchProtection: true,
          existingAppNames: [
            "acme-org-epure-agent",
            "acme-org-epure-release"
          ],
          existingRulesetNames: ["epure-release-immutability"]
        }
      });

      expect(secondPass.mutated_files).toHaveLength(0);
      expect(secondPass.planned_workflows.every((w) => w.action === "noop")).toBe(true);
      expect(secondPass.planned_reviewer_roster.every((r) => r.action === "noop")).toBe(true);
      expect(secondPass.agents_config_action).toBe("noop");
      expect(secondPass.ruleset_action).toBe("noop");
      expect(secondPass.apps_action).toBe("noop");
    } finally {
      rmSync(tempRepoDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      id: "disables-task-auto-merge-when-required-ci-checks-are-missing",
      existingState: {
        hasRequiredCiChecks: false,
        hasBranchProtection: true
      },
      expectedAutoMerge: false,
      expectedWarningCode: "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS"
    },
    {
      id: "disables-task-auto-merge-when-branch-protection-is-missing",
      existingState: {
        hasRequiredCiChecks: true,
        hasBranchProtection: false
      },
      expectedAutoMerge: false,
      expectedWarningCode: "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS"
    },
    {
      id: "enables-task-auto-merge-only-when-both-ci-checks-and-branch-protection-are-present",
      existingState: {
        hasRequiredCiChecks: true,
        hasBranchProtection: true
      },
      expectedAutoMerge: true,
      expectedWarningCode: "NONE"
    }
  ])("$id", ({ existingState, expectedAutoMerge, expectedWarningCode }) => {
    const result = planAndApplyRepoSetup({
      repository: "acme-org/payments",
      dryRun: true,
      existingState
    });
    expect(result.task_auto_merge_enabled).toBe(expectedAutoMerge);
    expect(result.auto_merge_warning_code).toBe(expectedWarningCode);
  });
});

describe("4. Organization-level secrets/variables sharing without cross-repo privilege escalation", () => {
  it.each([
    {
      id: "allows-org-secrets-in-second-repo-when-installation-token-is-scoped-to-single-target-repo",
      input: {
        organization: "acme-org",
        targetRepository: "acme-org/billing-service",
        sharedOrgSecrets: ["EPURE_AGENT_APP_ID", "EPURE_AGENT_APP_PRIVATE_KEY", "LLM_API_KEY"],
        sharedOrgVariables: ["EPURE_DEFAULT_HARNESS"],
        installationRepositorySelection: "selected" as const,
        tokenScopedRepositories: ["acme-org/billing-service"]
      },
      expected: {
        allowed: true,
        error_code: "NONE",
        effective_token_repositories: ["acme-org/billing-service"]
      }
    },
    {
      id: "rejects-org-secret-sharing-when-token-requests-all-repositories-access",
      input: {
        organization: "acme-org",
        targetRepository: "acme-org/billing-service",
        sharedOrgSecrets: ["EPURE_AGENT_APP_ID"],
        sharedOrgVariables: [],
        installationRepositorySelection: "all" as const,
        tokenScopedRepositories: ["acme-org/billing-service", "acme-org/payments"]
      },
      expected: {
        allowed: false,
        error_code: "CROSS_REPO_TOKEN_SCOPE_FORBIDDEN",
        effective_token_repositories: []
      }
    },
    {
      id: "rejects-org-secret-sharing-when-token-includes-another-repository-in-scope",
      input: {
        organization: "acme-org",
        targetRepository: "acme-org/billing-service",
        sharedOrgSecrets: ["EPURE_AGENT_APP_ID"],
        sharedOrgVariables: [],
        installationRepositorySelection: "selected" as const,
        tokenScopedRepositories: ["acme-org/billing-service", "acme-org/other-repo"]
      },
      expected: {
        allowed: false,
        error_code: "CROSS_REPO_TOKEN_SCOPE_FORBIDDEN",
        effective_token_repositories: []
      }
    }
  ])("$id", ({ input, expected }) => {
    const res = validateOrgSecretSharingScope(input);
    expect(res).toMatchObject(expected);
  });
});

describe("5. Pre-bundled CLI (dist/cli/setup-repo.mjs) & skill (.agents/skills/setup-repo/SKILL.md)", () => {
  it("ships the setup-repo skill documentation and pre-bundled CLI", () => {
    expect(existsSync(SETUP_REPO_SKILL_PATH)).toBe(true);
    expect(existsSync(BUNDLED_SETUP_REPO_CLI_PATH)).toBe(true);

    const output = execFileSync(
      process.execPath,
      [
        BUNDLED_SETUP_REPO_CLI_PATH,
        "--repo",
        "acme-org/payments",
        "--dry-run",
        "--json"
      ],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(output) as {
      status: string;
      dry_run: boolean;
      ruleset_spec: { targetRefs: string[] };
    };
    expect(parsed.status).toBe("dry_run");
    expect(parsed.dry_run).toBe(true);
    expect(parsed.ruleset_spec.targetRefs).toEqual([
      "refs/heads/main",
      "refs/tags/v*"
    ]);
  });

  it.each([
    {
      id: "detects-node-typescript-react-stack-and-emits-npm-renovate-cooldowns-and-ci",
      targetFilesHint: ["package.json", "tsconfig.json", "src/App.tsx", "e2e/smoke.e2e.ts"],
      expectedKind: "node",
      expectedHasE2e: true,
      expectedCiSubstring: "Quality (Format, Lint, Typecheck, Test & Build)",
      expectedRenovateSubstring: "npm-minor-and-patch"
    },
    {
      id: "detects-python-stack-and-emits-pypi-renovate-cooldowns-and-ruff-pytest-ci",
      targetFilesHint: ["pyproject.toml", "src/engine.py"],
      expectedKind: "python",
      expectedHasE2e: false,
      expectedCiSubstring: "ruff check .",
      expectedRenovateSubstring: "python-minor-and-patch"
    },
    {
      id: "detects-rust-stack-and-emits-cargo-renovate-cooldowns-and-clippy-ci",
      targetFilesHint: ["Cargo.toml", "src/lib.rs"],
      expectedKind: "rust",
      expectedHasE2e: false,
      expectedCiSubstring: "cargo clippy",
      expectedRenovateSubstring: "cargo-minor-and-patch"
    },
    {
      id: "detects-go-stack-and-emits-gomod-renovate-cooldowns-and-govet-ci",
      targetFilesHint: ["go.mod", "cmd/main.go"],
      expectedKind: "go",
      expectedHasE2e: false,
      expectedCiSubstring: "go vet ./...",
      expectedRenovateSubstring: "gomod-minor-and-patch"
    }
  ])(
    "$id",
    ({
      targetFilesHint,
      expectedKind,
      expectedHasE2e,
      expectedCiSubstring,
      expectedRenovateSubstring
    }) => {
      const stack = detectRepositoryStack({ targetFilesHint });
      expect(stack.kind).toBe(expectedKind);
      expect(stack.hasPlaywrightOrE2e).toBe(expectedHasE2e);

      const zizmor = buildZizmorConfigYaml();
      expect(zizmor.path).toBe(".github/zizmor.yml");
      expect(zizmor.content).toContain("dangerous-triggers:");

      const renovate = buildRenovateConfigJson(stack);
      expect(renovate.path).toBe("renovate.json");
      expect(renovate.content).toContain('"baseBranchPatterns": [\n    "dev"\n  ]');
      expect(renovate.content).toContain("config:best-practices");
      expect(renovate.content).toContain("helpers:pinGitHubActionDigests");
      expect(renovate.content).toContain("security:openssf-scorecard");
      expect(renovate.content).toContain('"minimumReleaseAge": "3 days"');
      expect(renovate.content).toContain('"internalChecksFilter": "strict"');
      expect(renovate.content).toContain('"prCreation": "not-pending"');
      expect(renovate.content).toContain('"automerge": false');
      expect(renovate.content).toContain('ignore-scripts=true');
      expect(renovate.content).toContain(expectedRenovateSubstring);

      const ci = buildStackAwareCiWorkflowYaml({
        pinnedSha: DEFAULT_EPURE_PINNED_SHA,
        stack
      });
      expect(ci.path).toBe(".github/workflows/ci.yml");
      expect(ci.content).toContain("zizmorcore/zizmor-action@");
      expect(ci.content).toContain("persona: pedantic");
      expect(ci.content).toContain(expectedCiSubstring);
    }
  );

  it.each([
    {
      id: "composes-headless-roster-with-always-on-core-and-custom-domain-specialists-when-ui-disabled",
      includeFrontendReviewers: false,
      customDomainSpecialists: [
        {
          name: "realtime",
          description: "WebSocket and CRDT state synchronization reviewer.",
          scopeResponsibilities: ["Audit WebSocket reconnection and sequence ordering."]
        },
        {
          name: "game-systems-reviewer",
          description: "Dice engine and combat ruleset specialist.",
          scopeResponsibilities: ["Verify deterministic RNG seeding and modifiers."]
        }
      ],
      expectedNames: [
        "domain-backend-reviewer",
        "realtime-reviewer",
        "game-systems-reviewer",
        "infra-reviewer",
        "architecture-reviewer",
        "security-reviewer",
        "spec-parity-reviewer",
        "standards-reviewer",
        "user-advocate"
      ],
      excludedNames: [
        "frontend-reviewer",
        "accessibility-reviewer",
        "design-reviewer"
      ]
    },
    {
      id: "composes-full-ui-roster-by-default-with-impeccable-and-accessibility-reviewers",
      includeFrontendReviewers: true,
      customDomainSpecialists: undefined,
      expectedNames: [
        "domain-backend-reviewer",
        "frontend-reviewer",
        "infra-reviewer",
        "architecture-reviewer",
        "security-reviewer",
        "spec-parity-reviewer",
        "standards-reviewer",
        "accessibility-reviewer",
        "design-reviewer",
        "user-advocate"
      ],
      excludedNames: []
    }
  ])(
    "$id",
    ({
      includeFrontendReviewers,
      customDomainSpecialists,
      expectedNames,
      excludedNames
    }) => {
      const result = planAndApplyRepoSetup({
        repository: "acme-org/custom-service",
        dryRun: true,
        includeFrontendReviewers,
        customDomainSpecialists
      });

      const actualNames = result.planned_reviewer_roster.map((r) => r.name);
      expect(actualNames).toEqual(expectedNames);
      for (const excluded of excludedNames) {
        expect(actualNames).not.toContain(excluded);
      }
    }
  );
});
