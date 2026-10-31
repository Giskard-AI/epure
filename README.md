<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-full-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/logo-full-light.png">
    <img alt="EPURE — Fusion entre Géométrie et Réseau" src="docs/public/logo-full-light.png" width="220">
  </picture>
</p>

# EPURE (`Giskard-AI/epure`)

> **E.P.U.R.E.**
> - **EN:** *Engineered Planning, Unified Review & Execution*
> - **FR:** *Élaboration de Plans, Usinage, Revue et Exécution*
>
> *(In French architecture, **l'épure** is the full-scale geometrical working drawing traced before cutting stone or timber—from the `/epure plan` Grill interview to the versioned specification, dependency-ordered ticket DAG, secretless TDD sandbox, and multi-agent review.)*

Open-source framework of **GitHub Actions Reusable Workflows**, **TypeScript Custom Actions (Node.js 24 LTS)**, and **AI Agent Skills** that orchestrates the complete specification-driven software engineering lifecycle on consumer repositories with deterministic guarantees, secretless sandboxing, Impeccable UI gates, and sovereign human validation gates on GitHub.

---

## Quickstart: Bootstrap a Repository with the `/setup-repo` Skill

The preferred way to onboard a new or existing repository is to invoke the **`/setup-repo`** skill (`.agents/skills/setup-repo/SKILL.md`) inside your coding agent (Cursor, Claude Code, Pi, or Codex):

```text
/setup-repo <owner>/<repo>
```

The agent inspects your repository's stack and domain modules, guides you through creating the 2 GitHub Apps and environment-scoped secrets (`setup-github-apps-wizard.sh --repo <owner>/<repo> --llm-env <env-name>`), runs `dist/cli/setup-repo.mjs --dry-run` before `--apply --apply-github-settings` (3 Repository Rulesets + squash-only governance), and **dynamically designs your `.cursor/agents/*.md` multi-agent reviewer roster** tailored to your codebase.

---

## Official Bilingual Documentation (English & Français)

The official documentation (powered by **VitePress** and interactive **Archify** showcase diagrams) is live at **[https://giskard-ai.github.io/epure/](https://giskard-ai.github.io/epure/)** (EN) and **[https://giskard-ai.github.io/epure/fr/](https://giskard-ai.github.io/epure/fr/)** (FR):

- **AI & LLM Index (`llms.txt` standard)**:
  - Concise index: [`https://giskard-ai.github.io/epure/llms.txt`](https://giskard-ai.github.io/epure/llms.txt)
  - Full corpus (EN + FR + Glossary): [`https://giskard-ai.github.io/epure/llms-full.txt`](https://giskard-ai.github.io/epure/llms-full.txt)
  - XML Sitemap: [`https://giskard-ai.github.io/epure/sitemap.xml`](https://giskard-ai.github.io/epure/sitemap.xml)

| Section | English (`docs/`) | Français (`docs/fr/`) |
| --- | --- | --- |
| **Home & Interactive Overview** | [`docs/index.md`](docs/index.md) | [`docs/fr/index.md`](docs/fr/index.md) |
| **Introduction & Naming (`L'Épure`)** | [`docs/introduction.md`](docs/introduction.md) | [`docs/fr/introduction.md`](docs/fr/introduction.md) |
| **Installation & Bootstrap** | [`docs/installation.md`](docs/installation.md) | [`docs/fr/installation.md`](docs/fr/installation.md) |
| **Basic Usage (`craft-calculator` Case Study)** | [`docs/basic-usage.md`](docs/basic-usage.md) | [`docs/fr/basic-usage.md`](docs/fr/basic-usage.md) |
| **Commands Reference (`/epure` & CLI)** | [`docs/commands.md`](docs/commands.md) | [`docs/fr/commands.md`](docs/fr/commands.md) |
| **Configuration (`.github/agents.yml`)** | [`docs/configuration.md`](docs/configuration.md) | [`docs/fr/configuration.md`](docs/fr/configuration.md) |
| **Architecture, Security & Review Model** | [`docs/architecture.md`](docs/architecture.md) | [`docs/fr/architecture.md`](docs/fr/architecture.md) |
| **How-To: Onboard a Repository** | [`docs/guides/how-to-onboard-repo.md`](docs/guides/how-to-onboard-repo.md) | [`docs/fr/guides/how-to-onboard-repo.md`](docs/fr/guides/how-to-onboard-repo.md) |
| **How-To: Drive an Issue End-to-End** | [`docs/guides/how-to-drive-an-issue.md`](docs/guides/how-to-drive-an-issue.md) | [`docs/fr/guides/how-to-drive-an-issue.md`](docs/fr/guides/how-to-drive-an-issue.md) |
| **How-To: Customize Reviewers & Impeccable** | [`docs/guides/how-to-customize-reviewers.md`](docs/guides/how-to-customize-reviewers.md) | [`docs/fr/guides/how-to-customize-reviewers.md`](docs/fr/guides/how-to-customize-reviewers.md) |
| **How-To: Promote a Release (`dev -> main`)** | [`docs/guides/how-to-release.md`](docs/guides/how-to-release.md) | [`docs/fr/guides/how-to-release.md`](docs/fr/guides/how-to-release.md) |
| **Domain Glossary (Single Source)** | [`docs/reference/glossary.md`](docs/reference/glossary.md) | [`docs/fr/reference/glossary.md`](docs/fr/reference/glossary.md) |

### Local Documentation & Diagram Commands

```bash
# Validate and render all 10 bilingual Archify diagrams (showcase quality)
npm run docs:diagrams

# Start the local VitePress documentation server
npm run docs:dev

# Build the production static documentation site
npm run docs:build
```

---

## Domain Model, ADRs & Specifications

- [`GLOSSARY.md`](GLOSSARY.md) — Canonical Ubiquitous Language dictionary (Q1–Q111, ADR-0029–ADR-0033).
- [`DESIGN.md`](DESIGN.md) — Impeccable design system tokens, WCAG 2.1 AA contrast ratios, and `<ArchifyDiagram>` interaction states.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — Complete architectural decision log across 24 Grill rounds (Q1–Q103).
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md) — Public reusable workflow and custom action contracts.
- [`docs/adr/`](docs/adr/) — **33 Architecture Decision Records (ADRs)** tracing every structural decision.
- [`docs/specs/dev-automation-v1.md`](docs/specs/dev-automation-v1.md) — Complete V1 functional and technical specification.

---

## Upstream Attributions & Credits

Full license notices and pinned provenance hashes are tracked in [`NOTICE`](NOTICE) and [`skills-lock.json`](skills-lock.json) ([ADR-0018](docs/adr/0018-licence-apache-2-et-conformite-des-attributions-tierces.md)):

| Upstream Project | License | Role in EPURE |
| --- | --- | --- |
| **[Matt Pocock Agent Skills (`mattpocock/skills`)](https://github.com/mattpocock/skills)** | MIT | Specification-driven planning, domain modeling, TDD, and review skills (`grill-with-docs`, `to-spec`, `to-tickets`, `tdd`, `code-review`, `domain-modeling`, `prototype`, `wizard`, `pr` with credit to [Dex Horthy / HumanLayer](https://github.com/humanlayer/humanlayer)). |
| **[Impeccable (`pbakaus/impeccable`)](https://github.com/pbakaus/impeccable)** | Apache-2.0 | UX/UI design system workflow (`shape`, `DESIGN.md`, `.impeccable/surfaces/*.md`) and WCAG 2.1 AA quality gate (`actions/impeccable`, `impeccable-gate`). |
| **[Archify (`tt-a1i/archify`)](https://github.com/tt-a1i/archify)** | MIT | Interactive showcase architecture diagrams embedded in `scripts/archify/`. |
| **[iFixAi (`ifixai-ai/iFixAi`)](https://github.com/ifixai-ai/iFixAi)** | Apache-2.0 | Deterministic authorization trajectory auditing (`actions/ifixai`). |
| **[zizmor (`woodruffw/zizmor`)](https://github.com/woodruffw/zizmor)** | MIT | Static security analysis for GitHub Actions workflows (`actions/zizmor-audit`). |
| **[Renovate (`renovatebot/renovate`)](https://github.com/renovatebot/renovate)** | AGPL-3.0 (Tool) | Automated updates of SHA-pinned workflows and dependencies (`auto_migrate`). |
