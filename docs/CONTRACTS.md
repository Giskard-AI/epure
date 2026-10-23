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

## 4. Consumer Example (`.github/workflows/consume-epure.yml`)

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
