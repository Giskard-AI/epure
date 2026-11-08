# AGENTS.md — EPURE (`Giskard-AI/epure`)

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues (`Giskard-AI/epure`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context domain layout (`GLOSSARY.md` at repo root and ADRs in `docs/adr/`). See `docs/agents/domain.md`.

### Live LLM & Orchestrator Verification (`npm run test:live`)

When modifying `src/llm/**` or `src/orchestrator/**`, mocked unit tests (`npm test`) are necessary but not sufficient. Validate against real LLM endpoints using the agnostic live harness:

1. Copy `epure.live-test.example.json` to `epure.live-test.json` (git-ignored) or set `EPURE_LIVE_TEST_CONFIG` / `EPURE_LIVE_TEST_TARGETS_JSON` with the list of LLM target configurations to verify.
2. Run `npm run test:live` (never log or print API keys in stdout/stderr).

### Live GitHub Verification (`npm run test:live:github`)

When modifying `src/orchestrator/github/**`, `src/state/**` or `src/auth/**`, mocked unit tests (`npm test`) are necessary but not sufficient. Validate against a real sandbox repository (name must contain `sandbox`; the App installation must reach only that repo):

1. Run `scripts/wizards/setup-live-github-sandbox-wizard.sh` once, or copy `epure.live-github.example.json` to `epure.live-github.json` (git-ignored), or point `EPURE_LIVE_GITHUB_CONFIG` at a config file, or set `EPURE_LIVE_GITHUB_REPOSITORY`, `EPURE_LIVE_GITHUB_APP_ID`, `EPURE_LIVE_GITHUB_APP_PRIVATE_KEY_PATH` (or `EPURE_LIVE_GITHUB_APP_PRIVATE_KEY`) and optionally `EPURE_LIVE_GITHUB_INSTALLATION_ID`.
2. Run `npm run test:live:github` (it sets the required opt-in flag `EPURE_LIVE_GITHUB=1`; without it the suite skips). The `setup-repo` ruleset cases also need `EPURE_LIVE_GITHUB_ADMIN_TOKEN`: a fine-grained personal access token whose repository access is only the sandbox repository, with `Administration: write` (not a broad `gh auth token`); they only create and delete rulesets scoped to the run namespace, and skip without it. It namespaces everything under `live/<run-id>/`, then deletes refs/branches and closes PRs (best effort, plus namespaces older than 24 h). Never log or print App private keys or tokens.
3. The PR-checks case (#105e) also needs `Workflows: write` and `Actions: read` on the sandbox App and skips without them. Once granted, the App holds `workflows: write` permanently: anyone with its private key can commit a workflow to the sandbox repository and run it there. Keep the sandbox repository free of real secrets (no Actions secrets, environments, deploy keys or variables worth stealing).

### End-to-End Sandbox Run (`npm run test:e2e`)

Before each major or minor release, run real EPURE end to end on `Giskard-AI/epure-e2e-sandbox`, a private repository reserved for this suite (never `Giskard-AI/epure-live-sandbox`; the harness refuses it and any repository whose name lacks `sandbox`). The run resets the sandbox to the seed project in `tests/e2e/seed/` (a test suite and a `CI` workflow), installs EPURE with `setup-repo` pinned to the commit under test, then drives the scripted epic of `tests/e2e/epic.ts`: `/epure plan`, scripted grilling answers, `/epure to-spec`, `/epure to-tickets` and `/epure approve`, until the `feature/*` -> `dev` pull request opens.

Human prerequisites, once:

1. `gh auth refresh -h github.com -s workflow`: the reset writes `.github/workflows`. Your `gh` user needs admin on the sandbox (rulesets, issue deletion) and posts every `/epure` command.
2. `bash scripts/wizards/setup-github-apps-wizard.sh --repo Giskard-AI/epure-e2e-sandbox --llm-env epure-agent --app-name-prefix giskard-ai-epure-e2e --llm-api-key-file ~/.config/epure/gemini.apikey --e2e-config epure.e2e.json`: it creates the two dedicated Apps, installs them on the sandbox only, stores their keys and the LLM key in the sandbox's GitHub Environments, and writes the App IDs to `epure.e2e.json` (git-ignored, no secrets).

Each run:

1. Push the EPURE commit under test with its built `dist/`, set `epureRef` (branch, tag or SHA) in `epure.e2e.json`, and run from a checkout of that commit: the local `dist/cli/setup-repo.mjs` writes the sandbox's caller workflows. `model` is one `<provider>/<model>` for every phase; `pricing` gives its USD per million tokens.
2. Run `npm run test:e2e` (it takes hours; `npm run test:e2e:reset` only resets). The run writes `result.json`, `report.md`, `usage.jsonl` and `comments.json` to `.scratch/e2e/<run-id>/`.

A run passes when the feature PR to `dev` is open, no escalation is an internal error, and no ticket escalates twice; the harness resumes a first escalation per ticket with `/epure continue`. Cost comes from the `epure-llm-usage` line that `LLMClient` prints for every LLM response, read back from the orchestrator job logs.

### Semantic Versioning (`vMAJOR.MINOR.PATCH`)

Determine the next release tag strictly from the semantic content of the commits since the last tag (`fix:`/`refactor:`/`chore:` -> increment `PATCH`, e.g. `v1.5.9 -> v1.5.10`; `feat:` -> increment `MINOR`, e.g. `v1.5.9 -> v1.6.0`; `BREAKING CHANGE` / `!:` -> increment `MAJOR`). Never roll `.9` over to the next minor unless the release contains a `feat:`.


