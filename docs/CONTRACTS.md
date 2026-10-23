# EPURE Public Interfaces Contract (`V1`)

This document specifies the public V1 contract for consuming **EPURE (`Giskard-AI/epure`)** Reusable Workflows and pre-bundled TypeScript Custom Actions (Node.js 22+) from a consumer repository without any central orchestration server or shared maintainer credentials ([ADR-0008](adr/0008-reusable-workflows-et-custom-actions-publics.md), [ADR-0018](adr/0018-licence-open-source-et-attributions.md), [ADR-0023](adr/0023-sandbox-proxy-llm-et-stack-typescript.md), [ADR-0025](adr/0025-depot-public-epure-rulesets-et-tags-immuables.md)).

---

## 1. Security, Execution & Versioning Rules

- **Zero Central Infrastructure**: Every workflow and action executes on the consumer repository's own GitHub Actions runners using the consumer's own permissions and isolated credentials. No `repository_dispatch` relay to `Giskard-AI/epure` is used.
- **Zero Shared Credentials**: Consumer jobs must never define maintainer-shared secrets (`EPURE_MAINTAINER_SHARED_TOKEN`, `EPURE_CENTRAL_RELAY_SECRET`, `EPURE_SHARED_APP_PRIVATE_KEY`).
- **Full 40-Character Git SHA Pinning**: Consumer repositories pin EPURE workflows and actions to an immutable 40-character Git commit SHA with a SemVer comment for Renovate updates:
  ```yaml
  uses: Giskard-AI/epure/.github/workflows/epure-check.yml@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0
  ```
- **Immutable SemVer Tags Only**: Releases publish strictly immutable `vMAJOR.MINOR.PATCH` tags (`# v1.0.0`). Floating major/minor tags (`@v1`, `@v1.0`) are forbidden and rejected at runtime (`MUTABLE_FLOATING_TAG_FORBIDDEN`).
- **Pre-bundled Node.js 22+ Custom Actions**: All Custom Actions are compiled into `dist/` so consumer jobs never run `npm install` or `npm ci` to execute an EPURE action.
- **Minimal Permissions**: Public contract verification requires only `contents: read`.

---

## 2. Public Reusable Workflow: `.github/workflows/epure-check.yml`

### Trigger (`workflow_call`)

### Inputs

| Name | Type | Required | Default | Description |
| :--- | :--- | :---: | :---: | :--- |
| `repository` | `string` | Yes | — | Consumer GitHub repository slug (`<owner>/<repo>`). |
| `pinned_ref` | `string` | Yes | — | Full `Giskard-AI/epure/.../@<40-char-sha> # vX.Y.Z` reference invoked by the caller. |
| `strict_sha_pinning` | `boolean` | No | `true` | Enforce full 40-character Git SHA pinning (`true` by default). |

### Outputs

| Name | Description |
| :--- | :--- |
| `status` | Contract verification status (`ok` or `error`). |
| `version` | EPURE public contract SemVer version (`1.0.0`). |
| `contract_valid` | `'true'` when the invocation satisfies the V1 contract, `'false'` otherwise. |
| `error_code` | Structured error code (`NONE` when valid). |

### Permissions

```yaml
permissions:
  contents: read
```

---

## 3. Public Custom Action: `actions/epure-contract`

Entrypoint: `actions/epure-contract/action.yml` (`runs.using: "node22"`, pre-bundled at `dist/actions/epure-contract/index.mjs`).

### Inputs

| Name | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `repository` | Yes | — | Consumer GitHub repository slug (`<owner>/<repo>`). |
| `pinned_ref` | Yes | — | Full `Giskard-AI/epure/.../@<40-char-sha> # vX.Y.Z` reference. |
| `strict_sha_pinning` | No | `"true"` | Require 40-character Git SHA pinning (`"true"` or `"false"`). |

### Outputs

| Name | Description |
| :--- | :--- |
| `status` | `'ok'` or `'error'`. |
| `version` | `'1.0.0'`. |
| `contract_valid` | `'true'` or `'false'`. |
| `error_code` | Structured error code (`NONE` or one of the error codes below). |
| `error_message` | Diagnostic message when `status` is `'error'`. |

### Structured Error Codes

| `error_code` | Cause | Exit Code |
| :--- | :--- | :---: |
| `NONE` | All contract checks passed. | `0` |
| `INVALID_REPOSITORY_SLUG` | `repository` does not match `<owner>/<repo>`. | `1` |
| `MUTABLE_FLOATING_TAG_FORBIDDEN` | Reference uses a mutable floating tag such as `@v1` or `@v1.0`. | `1` |
| `INVALID_SHA_PINNING` | Reference is not pinned to `Giskard-AI/epure/.../@<40-char-sha>` (or immutable `@vMAJOR.MINOR.PATCH` when `strict_sha_pinning: false`). | `1` |
| `SHARED_MAINTAINER_CREDENTIAL_FORBIDDEN` | Environment contains a forbidden shared maintainer token/secret. | `1` |

---

## 4. Public Reusable Workflow: `.github/workflows/issue-command.yml` & Action `actions/authorize-command`

Entrypoint: `actions/authorize-command/action.yml` (`runs.using: "node22"`, pre-bundled at `dist/actions/authorize-command/index.mjs`).

Verifies that an issue comment command (`/epure status`, `/epure plan`, `/epure approve`, `/epure cancel`) is authored by a human actor holding effective `write` or `admin` permission on the target repository via `GET /repos/{owner}/{repo}/collaborators/{username}/permission` ([ADR-0004](adr/0004-separation-execution-et-publication.md), [ADR-0017](adr/0017-prevention-des-boucles-review-independante-et-reprises.md)).

- Ignores bot actors (`user.type === 'Bot'`, `*[bot]`, known automation apps) with `BOT_ACTOR_IGNORED` and `should_post_response: "false"` to prevent loops.
- Rejects `read`, `triage`, or `none` effective permissions with `INSUFFICIENT_EFFECTIVE_PERMISSION`, regardless of `author_association` (`COLLABORATOR`, `CONTRIBUTOR`) or issue labels (`ready-for-agent`, `approved`).
- Scrubs any token or secret from diagnostic outputs (`redactSecrets`).

---

## 5. Public Custom Action: `actions/verify-app-role`

Entrypoint: `actions/verify-app-role/action.yml` (`runs.using: "node22"`, pre-bundled at `dist/actions/verify-app-role/index.mjs`).

Enforces strict privilege separation between the consumer repository's two distinct GitHub Apps ([ADR-0009](adr/0009-identite-github-app-des-consommateurs-et-skill-installation.md), [ADR-0010](adr/0010-bootstrap-et-configuration-des-depots-consommateurs.md)):

- **Agent App (`app_role: "agent"`)**: Allowed to perform `issue_comment`, `push_branch` (restricted to `plan/*`, `task/*`, `feature/*`), `create_pull_request`, and `create_check_run`. Forbidden from `promote_dev_to_main`, `create_release_tag`, and `publish_github_release` (`AGENT_APP_RELEASE_OPERATION_FORBIDDEN`).
- **Release App (`app_role: "release"`)**: Restricted exclusively to `.github/workflows/release.yml` running inside the `release` environment (`RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN`).
- **Human Confirmation & Key Hygiene**: Requires `human_confirmed: "true"` for `grant_elevated_permission` (`HUMAN_CONFIRMATION_REQUIRED`) and rejects/scrubs any PEM private key in public payloads (`PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD`).

---

## 6. Consumer Bootstrap CLI & `.github/agents.yml` Contract (`setup-repo`)

Entrypoint: `dist/cli/setup-repo.mjs` (`bin: epure-setup-repo`) and local skill `.agents/skills/setup-repo/SKILL.md` ([ADR-0010](adr/0010-bootstrap-et-configuration-des-depots-consommateurs.md), [ADR-0023](adr/0023-sandbox-proxy-llm-et-stack-typescript.md), [ADR-0025](adr/0025-depot-public-epure-rulesets-et-tags-immuables.md)).

- **Dry-Run (`--dry-run`) & Guided Apply (`--apply`)**: Previews or applies caller workflows pinned by 40-char SHA, `.github/agents.yml`, dual GitHub Apps, branch protections (`dev`, `feature/*`), and the `epure-release-immutability` Repository Ruleset on `main` & `refs/tags/v*` with `Release App` as sole Bypass Actor.
- **Q78 Defaults**: `max_code_fix_attempts: 3`, `max_transient_api_retries: 4` (backoff `[5, 15, 45, 120]`), `job_timeout_minutes: 60` (review `30`), `max_concurrent_tasks_per_feature: 3`, `trace_retention_days: 30`, `preview_retention_days: 14`, `github_pages_previews: false`.
- **Non-Weakenable Security Invariants**: Rejects any local override attempting to disable write permission checks, sandbox isolation, or release boundaries (`SECURITY_INVARIANT_VIOLATION`), forces `task_auto_merge_enabled: false` when required CI or branch protections are absent (`AUTO_MERGE_DISABLED_MISSING_PROTECTIONS`), and restricts org-shared secret tokens to the single target repository (`CROSS_REPO_TOKEN_SCOPE_FORBIDDEN`).

---

## 7. Consumer Example (`.github/workflows/consume-epure.yml`)

```yaml
name: "Consumer Demo — EPURE Public Workflow & Custom Action"

on:
  pull_request:
    branches: [dev, main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  consume-reusable-workflow:
    permissions:
      contents: read
    uses: Giskard-AI/epure/.github/workflows/epure-check.yml@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0
    with:
      repository: ${{ github.repository }}
      pinned_ref: "Giskard-AI/epure/.github/workflows/epure-check.yml@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0"
      strict_sha_pinning: true

  consume-custom-action:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - name: Execute EPURE Custom Action without dependency installation
        id: epure_action
        uses: Giskard-AI/epure/actions/epure-contract@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0
        with:
          repository: ${{ github.repository }}
          pinned_ref: "Giskard-AI/epure/actions/epure-contract@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0"
          strict_sha_pinning: "true"
```
