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
      "Primary onboarding via the /setup-repo agent skill, Dual GitHub Apps wizard, 3 Repository Rulesets, and dynamic .cursor/agents/ reviewer roster design."
  },
  {
    title: "Basic Usage (Case Study: craft-calculator)",
    url: `${SITE_URL}/basic-usage`,
    file: "basic-usage.md",
    summary:
      "End-to-end walkthrough of an issue from /epure plan Grill interview to DAG execution, secretless TDD, multi-agent review, and human merge."
  },
  {
    title: "Commands Reference (/epure & /setup-repo)",
    url: `${SITE_URL}/commands`,
    file: "commands.md",
    summary:
      "Complete reference for /setup-repo, /epure plan, /epure approve, /epure prototype, /epure resume, /epure retry, /epure pause, and /epure cancel."
  },
  {
    title: "Configuration (.github/agents.yml & renovate.json)",
    url: `${SITE_URL}/configuration`,
    file: "configuration.md",
    summary:
      "Declarative configuration reference for .github/agents.yml and supply-chain security policy in renovate.json."
  },
  {
    title: "Architecture, Security & Multi-Agent Review",
    url: `${SITE_URL}/architecture`,
    file: "architecture.md",
    summary:
      "Dual-App privilege separation, out-of-branch CAS state in refs/epure/state/<issue>, secretless TDD sandbox, iFixAi & zizmor audits, and dynamic PR review."
  },
  {
    title: "How-To: Onboard a Repository",
    url: `${SITE_URL}/guides/how-to-onboard-repo`,
    file: "guides/how-to-onboard-repo.md",
    summary:
      "Step-by-step guide to bootstrapping a consumer repository with /setup-repo."
  },
  {
    title: "How-To: Drive an Issue End-to-End",
    url: `${SITE_URL}/guides/how-to-drive-an-issue`,
    file: "guides/how-to-drive-an-issue.md",
    summary:
      "Practical guide to running the Grill, approving the spec_sha mandate, monitoring the DAG, and merging feature/* -> dev."
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
      "Canonical Ubiquitous Language dictionary for EPURE."
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
      "Onboarding recommandé via le skill /setup-repo, wizard des 2 GitHub Apps, 3 Rulesets et composition dynamique du roster .cursor/agents/."
  },
  {
    title: "Usage de Base (Étude de Cas : craft-calculator)",
    url: `${SITE_URL}/fr/basic-usage`,
    file: "fr/basic-usage.md",
    summary:
      "Parcours complet d'une issue depuis l'entretien Grill /epure plan jusqu'à la revue multi-agents et au merge humain."
  },
  {
    title: "Référence des Commandes (/epure & /setup-repo)",
    url: `${SITE_URL}/fr/commands`,
    file: "fr/commands.md",
    summary:
      "Référence complète du skill /setup-repo et des commandes /epure sur GitHub Issues."
  },
  {
    title: "Configuration (.github/agents.yml & renovate.json)",
    url: `${SITE_URL}/fr/configuration`,
    file: "fr/configuration.md",
    summary:
      "Référence déclarative de .github/agents.yml et politique de sécurité supply-chain Renovate."
  },
  {
    title: "Architecture, Sécurité & Revue Multi-Agents",
    url: `${SITE_URL}/fr/architecture`,
    file: "fr/architecture.md",
    summary:
      "Séparation des privilèges à 2 GitHub Apps, état CAS hors-branches, sandbox TDD sans secret et panel de revue dynamique."
  },
  {
    title: "Guide : Onboarder un Dépôt",
    url: `${SITE_URL}/fr/guides/how-to-onboard-repo`,
    file: "fr/guides/how-to-onboard-repo.md",
    summary:
      "Guide pas à pas pour équiper un dépôt consommateur avec /setup-repo."
  },
  {
    title: "Guide : Piloter une Issue de Bout en Bout",
    url: `${SITE_URL}/fr/guides/how-to-drive-an-issue`,
    file: "fr/guides/how-to-drive-an-issue.md",
    summary:
      "Conduire le Grill, approuver le mandat spec_sha et fusionner feature/* -> dev."
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
    "- **Preferred Onboarding (`/setup-repo`)**: Invoke `/setup-repo <owner>/<repo>` in Cursor, Claude Code, Pi, or Codex (`.agents/skills/setup-repo/SKILL.md`). The agent inspects the repository stack and domains, runs `scripts/wizards/setup-github-apps-wizard.sh`, executes `node dist/cli/setup-repo.mjs --dry-run` then `--apply --apply-github-settings`, configures 3 Repository Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`), generates a hardened `renovate.json` (with 3-to-14-day quarantine cooldowns), and dynamically composes `.cursor/agents/*.md` specialist reviewers.",
    "- **Four Mandatory Human Gates**:",
    "  1. Initiating `/epure plan` and answering the architectural Grill on the GitHub Issue.",
    "  2. Approving the locked specification mandate via `/epure approve` (pinned to `spec_sha`).",
    "  3. Reviewing and squash-merging the final `feature/<issue>-<slug> -> dev` Pull Request.",
    "  4. Triggering production SemVer releases (`dev -> main` fast-forward) via `release-promote.yml`.",
    "- **Security Invariants**: Out-of-branch atomic CAS state (`refs/epure/state/<issue>`), secretless TDD sandbox execution, Reviewer Roster always loaded from trusted `dev` (never from untrusted PR head), Dual GitHub Apps (`Agent App` vs `Release App`), `zizmor` workflow static analysis, and `iFixAi` trajectory auditing.",
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
