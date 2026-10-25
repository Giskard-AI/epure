# Configuration Reference (`.github/agents.yml`)

EPURE centralizes all orchestration, LLM, governance, and UI gate settings in a single versioned declarative file: **`.github/agents.yml`**.

---

## Complete Canonical Example

Below is a complete `.github/agents.yml` file with all supported keys and their defaults (Q78, Q91–Q96):

```yaml
# .github/agents.yml — Declarative EPURE Configuration
schema_version: 1

epure:
  # Immutable 40-character SHA of Giskard-AI/epure
  pinned_sha: "7f9f5aafa90acb68c5374cf00833881c0467cf67"

branches:
  # Active integration branch (set as the repository's default branch)
  default_integration: "dev"
  # Immutable production release branch (fast-forward only from dev)
  release: "main"

llm:
  provider: "google-gemini"
  # Primary reasoning & coding model
  model: "gemini-3.8-flash"
  thinking_level: "HIGH"
  # Lightweight zero-temperature model for AI semantic squash commit messages
  squash_summary_model: "gemini-3.8-flash"
  squash_summary_temperature: 0.0

orchestration:
  # Out-of-branch atomic CAS state prefix
  state_ref_prefix: "refs/epure/state/"
  # Maximum automated TDD / review remediation loops per ticket before escalating to needs-human
  max_code_fix_attempts: 3
  # Maximum parallel domain/transverse reviewers selected per PR diff (excluding spec-parity-reviewer)
  max_parallel_reviewers: 4
  # Enforce secretless sandbox execution (fails closed if secrets cannot be stripped)
  secretless_sandbox: true

review_roster:
  # Always load reviewer definitions from the trusted base branch (never from untrusted PR head)
  trusted_branch: "dev"
  directory: ".cursor/agents"
  # Mandatory reviewer on every PR
  always_include:
    - "spec-parity-reviewer"
  # Available specialist & transverse agents
  available:
    - "domain-backend-reviewer"
    - "frontend-reviewer"
    - "infra-reviewer"
    - "architecture-reviewer"
    - "security-reviewer"
    - "standards-reviewer"
    - "accessibility-reviewer"
    - "design-reviewer"
    - "user-advocate"

ui_governance:
  # Automatically activates DESIGN.md, user-advocate, and impeccable-gate when UI files are present
  impeccable_enabled: true
  design_system_path: "DESIGN.md"
  # Opt-in static GitHub Pages preview for /prototype branches (disabled by default, Q70)
  enable_pages_preview: false
  preview_retention_days: 14

sensitive_paths:
  # Modifying any of these paths on a task/* branch blocks auto-merge unless labeled approved-sensitive-change
  - ".github/workflows/**"
  - ".github/agents.yml"
  - ".cursor/agents/**"
  - "CODEOWNERS"
```

---

## Section-by-Section Reference

### `branches`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `default_integration` | `string` | `"dev"` | Default branch of the repository where approved `plan/*` and human-reviewed `feature/*` PRs land. |
| `release` | `string` | `"main"` | Immutable release branch updated exclusively by `release-promote.yml` via fast-forward from `dev`. |

### `llm`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `string` | `"google-gemini"` | LLM provider managed by the runner-local proxy sidecar. |
| `model` | `string` | `"gemini-3.8-flash"` | Model used for Grill interviews, specification writing, TDD coding, and multi-agent reviews. |
| `thinking_level` | `"LOW" \| "MEDIUM" \| "HIGH"` | `"HIGH"` | Reasoning depth passed to Gemini `thinkingConfig`. |
| `squash_summary_temperature` | `number` | `0.0` | Deterministic temperature used to synthesize Conventional Commit titles and bodies before squash-merge (Q94). |

### `orchestration`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `state_ref_prefix` | `string` | `"refs/epure/state/"` | Git reference namespace used for atomic Compare-And-Swap state persistence (Q76). |
| `max_code_fix_attempts` | `integer` | `3` | Maximum number of automated remediation rounds on a `task/*` or `feature/*` PR before adding `needs-human` and stopping (Q78). |
| `max_parallel_reviewers` | `integer` | `4` | Ceiling on domain/transverse reviewers selected per PR diff so review latency and signal-to-noise remain optimal (Q92). |
| `secretless_sandbox` | `boolean` | `true` | Strips `LLM_API_KEY` and GitHub App private keys from all child build/test processes; fails closed if isolation is unavailable (Q74). |

### `ui_governance`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `impeccable_enabled` | `boolean` | `true` | Enables `DESIGN.md` generation, `user-advocate` (`design-gate` and `implementation-review`), and the blocking `impeccable-gate` CI check whenever UI files are touched (Q79, Q96). |
| `enable_pages_preview` | `boolean` | `false` | Opt-in flag to publish static `/prototype` previews to an isolated GitHub Pages environment (Q70, Q73). |
| `preview_retention_days` | `integer` | `14` | Number of days before hosted prototype previews are automatically purged (Q71). |

### `sensitive_paths`

Any modification to `.github/workflows/**`, `.github/agents.yml`, `.cursor/agents/**`, or `CODEOWNERS` on a `task/*` branch triggers a **Sensitive Path Escalation**: EPURE refuses autonomous merge into `feature/*` and applies the `needs-human` label unless a maintainer explicitly adds the `approved-sensitive-change` label (Q81, Q93).

---

## Supply-Chain & Renovate Security Policy (`renovate.json`)

Every EPURE repository (and `Giskard-AI/epure` itself) ships a hardened **`renovate.json`** generated by `/setup-repo` (Q46–Q48):

- **Quarantine Cooldown (No Day-1 Merges)**: Enforces `minimumReleaseAge: "3 days"` globally (`"7 days"` for minor updates and GitHub Actions/Docker images, `"14 days"` for major npm updates) coupled with `internalChecksFilter: "strict"` and `prCreation: "not-pending"` so newly published or compromised packages are quarantined before any PR is opened.
- **Maximum Safe Automation**: Groups minor, patch, pin, and digest updates into single weekly PRs (`npm-minor-and-patch`, `github-actions`, `docker`), pins exact versions (`rangeStrategy: "pin"`, `helpers:pinGitHubActionDigests`, `docker:pinDigests`), runs monthly `lockFileMaintenance`, and automatically rebases behind `dev` (`rebaseWhen: "behind-base-branch"`).
- **Post-Install Script Isolation**: Injects `npmrc: "ignore-scripts=true"` during Renovate lockfile resolution to prevent untrusted lifecycle scripts from executing.
- **No Unreviewed Auto-Merge into `dev`**: `automerge: false` and `platformAutomerge: false` are strictly enforced; Renovate PRs target `dev`, run the full CI + multi-agent review pipeline, and optionally trigger the assisted `auto_migrate` agent if a breaking change is detected on a verified Renovate App PR.

