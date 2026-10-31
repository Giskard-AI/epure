#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const DOCS_DIR = join(ROOT_DIR, "docs");
const PUBLIC_DIR = join(DOCS_DIR, "public");

const SITE_URL = "https://giskard-ai.github.io/epure";
const REPO_URL = "https://github.com/Giskard-AI/epure";

const EN_PAGES = [
  {
    title: "Introduction & Naming (L'Épure)",
    url: `${SITE_URL}/introduction`,
    file: "introduction.md",
    summary:
      "Philosophy of L'Épure, 4 mandatory human validation gates, 3-category step taxonomy, and upstream open-source attributions."
  },
  {
    title: "Installation & /setup-repo Skill",
    url: `${SITE_URL}/installation`,
    file: "installation.md",
    summary:
      "Primary onboarding via the /setup-repo agent skill, Dual GitHub Apps wizard with environment-scoped secrets (--llm-env and release), 3 Repository Rulesets, and dynamic .cursor/agents/ reviewer roster design."
  },
  {
    title: "Basic Usage (Case Study: craft-calculator)",
    url: `${SITE_URL}/basic-usage`,
    file: "basic-usage.md",
    summary:
      "End-to-end walkthrough of an issue from /epure plan Grill interview and Goldfish spec audit to native GitHub sub_issues/blocked_by DAG execution, 2-phase Ubuntu 26.04 kernel sandbox, event-driven CI continuation, EpicConvergenceAudit, and human merge."
  },
  {
    title: "Commands Reference (/epure & /setup-repo)",
    url: `${SITE_URL}/commands`,
    file: "commands.md",
    summary:
      "Complete reference for /setup-repo, /epure plan, /epure to-spec, /epure to-tickets, /epure approve, /epure continue, /epure sync, /epure status, /epure cancel, and the epure-ci-actions-flow pipeline."
  },
  {
    title: "Configuration (.github/agents.yml & renovate.json)",
    url: `${SITE_URL}/configuration`,
    file: "configuration.md",
    summary:
      "Flat canonical declarative configuration reference for .github/agents.yml (models, providers, verification.targets, web_tools, security_invariants), configurable <llm-env> GitHub Environment, and supply-chain security policy in renovate.json & .github/zizmor.yml."
  },
  {
    title: "Architecture, Security & Multi-Agent Review",
    url: `${SITE_URL}/architecture`,
    file: "architecture.md",
    summary:
      "Dual-App privilege separation, out-of-branch CAS state in refs/epure/state/<issue>, 3-stage verification pipeline (Ubuntu 26.04 bwrap/landrun kernel sandbox & stateless rtk), event-driven CI continuation, incremental workspace mutation tools, and EpicConvergenceAudit."
  },
  {
    title: "How-To: Onboard a Repository",
    url: `${SITE_URL}/guides/how-to-onboard-repo`,
    file: "guides/how-to-onboard-repo.md",
    summary:
      "Step-by-step guide to bootstrapping a consumer repository with /setup-repo and environment-scoped secrets."
  },
  {
    title: "How-To: Drive an Issue End-to-End",
    url: `${SITE_URL}/guides/how-to-drive-an-issue`,
    file: "guides/how-to-drive-an-issue.md",
    summary:
      "Practical guide to running the Grill, approving the spec_sha mandate, event-driven CI waiting, /epure continue, /epure sync, Phase 2 convergence tickets, and merging feature/* -> dev."
  },
  {
    title: "How-To: Customize Reviewers & Impeccable Gate",
    url: `${SITE_URL}/guides/how-to-customize-reviewers`,
    file: "guides/how-to-customize-reviewers.md",
    summary:
      "How to add domain-specific reviewers in .cursor/agents/*.md and configure DESIGN.md + impeccable-gate."
  },
  {
    title: "How-To: Promote a Release (dev -> main)",
    url: `${SITE_URL}/guides/how-to-release`,
    file: "guides/how-to-release.md",
    summary:
      "How to promote dev to main via fast-forward under the Release App and handle hotfix back-merges."
  },
  {
    title: "Domain Glossary (EN / FR)",
    url: `${SITE_URL}/reference/glossary`,
    file: "reference/glossary.md",
    summary:
      "Canonical Ubiquitous Language dictionary for EPURE (Q1–Q111, ADR-0029–ADR-0033, v1.7.0)."
  }
];

const FR_PAGES = [
  {
    title: "Introduction & Nom (L'Épure)",
    url: `${SITE_URL}/fr/introduction`,
    file: "fr/introduction.md",
    summary:
      "Philosophie de L'Épure, 4 portes de validation humaine obligatoires, taxonomie à 3 catégories et crédits open-source."
  },
  {
    title: "Installation & Skill /setup-repo",
    url: `${SITE_URL}/fr/installation`,
    file: "fr/installation.md",
    summary:
      "Onboarding recommandé via le skill /setup-repo, wizard des 2 GitHub Apps avec secrets cloisonnés par environnement (--llm-env et release), 3 Rulesets et composition dynamique du roster .cursor/agents/."
  },
  {
    title: "Usage de Base (Étude de Cas : craft-calculator)",
    url: `${SITE_URL}/fr/basic-usage`,
    file: "fr/basic-usage.md",
    summary:
      "Parcours complet d'une issue depuis l'entretien Grill /epure plan et l'audit Goldfish jusqu'au DAG natif sub_issues/blocked_by, au sandbox noyau Ubuntu 26.04, à la CI événementielle, à l'EpicConvergenceAudit et au merge humain."
  },
  {
    title: "Référence des Commandes (/epure & /setup-repo)",
    url: `${SITE_URL}/fr/commands`,
    file: "fr/commands.md",
    summary:
      "Référence complète du skill /setup-repo, des commandes /epure (/epure plan, to-spec, to-tickets, approve, continue, sync, status, cancel) et du pipeline epure-ci-actions-flow."
  },
  {
    title: "Configuration (.github/agents.yml & renovate.json)",
    url: `${SITE_URL}/fr/configuration`,
    file: "fr/configuration.md",
    summary:
      "Référence déclarative du schéma plat .github/agents.yml, environnement GitHub <llm-env> configurable et politique supply-chain Renovate & Zizmor."
  },
  {
    title: "Architecture, Sécurité & Revue Multi-Agents",
    url: `${SITE_URL}/fr/architecture`,
    file: "fr/architecture.md",
    summary:
      "Séparation des privilèges à 2 GitHub Apps, état CAS hors-branches, pipeline en 3 étapes (sandbox noyau Ubuntu 26.04 bwrap/landrun & rtk sans état), continuation CI événementielle, outils de mutation incrémentale et EpicConvergenceAudit."
  },
  {
    title: "Guide : Onboarder un Dépôt",
    url: `${SITE_URL}/fr/guides/how-to-onboard-repo`,
    file: "fr/guides/how-to-onboard-repo.md",
    summary:
      "Guide pas à pas pour équiper un dépôt consommateur avec /setup-repo et des secrets cloisonnés par environnement."
  },
  {
    title: "Guide : Piloter une Issue de Bout en Bout",
    url: `${SITE_URL}/fr/guides/how-to-drive-an-issue`,
    file: "fr/guides/how-to-drive-an-issue.md",
    summary:
      "Conduire le Grill, approuver le mandat spec_sha, gérer la CI événementielle, /epure continue, /epure sync, les tickets de Phase 2 et fusionner feature/* -> dev."
  },
  {
    title: "Guide : Personnaliser le Roster & Impeccable",
    url: `${SITE_URL}/fr/guides/how-to-customize-reviewers`,
    file: "fr/guides/how-to-customize-reviewers.md",
    summary:
      "Créer des reviewers spécialisés dans .cursor/agents/*.md et configurer DESIGN.md."
  },
  {
    title: "Guide : Promouvoir une Release (dev -> main)",
    url: `${SITE_URL}/fr/guides/how-to-release`,
    file: "fr/guides/how-to-release.md",
    summary:
      "Promotion fast-forward de dev vers main via la Release App."
  }
];

function buildLlmsIndex() {
  const lines = [
    "# EPURE (Giskard-AI/epure)",
    "",
    "> Engineered Planning, Unified Review & Execution (FR: Élaboration de Plans, Usinage, Revue et Exécution) — Open-source GitHub-first specification-driven software engineering framework built on Reusable Workflows, TypeScript Custom Actions (Node.js 24 LTS), and AI Agent Skills.",
    "",
    `- Documentation Home (EN): ${SITE_URL}/`,
    `- Documentation Accueil (FR): ${SITE_URL}/fr/`,
    `- Full Concatenated Corpus for LLMs: ${SITE_URL}/llms-full.txt`,
    `- GitHub Repository: ${REPO_URL}`,
    `- License: Apache-2.0`,
    "",
    "## Core Summary for AI Agents",
    "",
    "- **Preferred Onboarding (`/setup-repo`)**: Invoke `/setup-repo <owner>/<repo>` in Cursor, Claude Code, Pi, or Codex (`.agents/skills/setup-repo/SKILL.md`). The agent inspects the repository stack and domains, runs `scripts/wizards/setup-github-apps-wizard.sh --repo <owner>/<repo> --llm-env <env-name>`, executes `node dist/cli/setup-repo.mjs --dry-run` then `--apply --apply-github-settings`, configures 3 Repository Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`), generates `.github/zizmor.yml` and a hardened `renovate.json` (with 3-to-14-day quarantine cooldowns), and dynamically composes `.cursor/agents/*.md` specialist reviewers.",
    "- **Four Mandatory Human Gates**:",
    "  1. Initiating `/epure plan` and answering the architectural Grill on the GitHub Issue.",
    "  2. Approving the locked specification mandate via `/epure approve` (integrating `plan/*` directly into `feature/*` and locking `spec_sha`).",
    "  3. Reviewing and squash-merging the final `feature/<issue>-<slug> -> dev` Pull Request.",
    "  4. Triggering production SemVer releases (`dev -> main` fast-forward) via `release-promote.yml` / `release.yml`.",
    "- **Security & Execution Invariants (33 ADRs & 10 Bilingual Archify Diagrams)**: Out-of-branch atomic CAS state (`refs/epure/state/<issue>`), Zizmor-compliant GitHub Environment secret scoping (`<llm-env>` and `release`), 2-phase Ubuntu 26.04 Linux kernel sandbox (`landrun` + `bubblewrap` with stateless `rtk` condensation), event-driven external CI continuation (`waiting_ticket_ci` / `waiting_feature_ci`), transactional incremental file tools (`StagedTicketImplementationBuffer`), zero-context `EpicConvergenceAudit`, Reviewer Roster always loaded from trusted `dev` (never from untrusted PR head), Dual GitHub Apps (`Agent App` vs `Release App`), and `iFixAi` trajectory auditing.",
    "",
    "## English Documentation",
    ""
  ];

  for (const page of EN_PAGES) {
    lines.push(`- [${page.title}](${page.url}): ${page.summary}`);
  }

  lines.push("", "## Documentation Française", "");

  for (const page of FR_PAGES) {
    lines.push(`- [${page.title}](${page.url}): ${page.summary}`);
  }

  lines.push("");
  return lines.join("\n");
}

function stripFrontmatter(md) {
  return md.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

function buildLlmsFull() {
  const sections = [
    "# EPURE — Complete Documentation Corpus (EN + FR + Glossary)",
    "",
    `Source: ${SITE_URL}/`,
    `Repository: ${REPO_URL}`,
    ""
  ];

  for (const page of EN_PAGES) {
    const filePath = join(DOCS_DIR, page.file);
    let content = stripFrontmatter(readFileSync(filePath, "utf8"));
    if (page.file === "reference/glossary.md") {
      const glossaryRoot = readFileSync(join(ROOT_DIR, "GLOSSARY.md"), "utf8");
      content = content.replace("<!--@include: ../../GLOSSARY.md-->", glossaryRoot);
    }
    sections.push(
      "---",
      `## [EN] ${page.title}`,
      `URL: ${page.url}`,
      "",
      content.trim(),
      ""
    );
  }

  for (const page of FR_PAGES) {
    const filePath = join(DOCS_DIR, page.file);
    const content = stripFrontmatter(readFileSync(filePath, "utf8"));
    sections.push(
      "---",
      `## [FR] ${page.title}`,
      `URL: ${page.url}`,
      "",
      content.trim(),
      ""
    );
  }

  return sections.join("\n");
}

mkdirSync(PUBLIC_DIR, { recursive: true });
const llmsTxt = buildLlmsIndex();
const llmsFullTxt = buildLlmsFull();

writeFileSync(join(PUBLIC_DIR, "llms.txt"), llmsTxt, "utf8");
writeFileSync(join(PUBLIC_DIR, "llms-full.txt"), llmsFullTxt, "utf8");

console.log(
  `Generated docs/public/llms.txt (${llmsTxt.length} bytes) and docs/public/llms-full.txt (${llmsFullTxt.length} bytes)`
);
