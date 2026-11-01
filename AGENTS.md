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
2. Run `npm run test:live:github` (it sets the required opt-in flag `EPURE_LIVE_GITHUB=1`; without it the suite skips). It namespaces everything under `live/<run-id>/`, then deletes refs/branches and closes PRs (best effort, plus namespaces older than 24 h). Never log or print App private keys or tokens.

### Semantic Versioning (`vMAJOR.MINOR.PATCH`)

Determine the next release tag strictly from the semantic content of the commits since the last tag (`fix:`/`refactor:`/`chore:` -> increment `PATCH`, e.g. `v1.5.9 -> v1.5.10`; `feat:` -> increment `MINOR`, e.g. `v1.5.9 -> v1.6.0`; `BREAKING CHANGE` / `!:` -> increment `MAJOR`). Never roll `.9` over to the next minor unless the release contains a `feat:`.


