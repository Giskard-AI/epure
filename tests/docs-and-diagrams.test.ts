import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateImpeccableFrontendPr,
  type ImpeccablePrFinding
} from "../src/frontend/impeccable-pr-gate.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ARCHIFY_BIN = resolve(REPO_ROOT, "scripts/archify/bin/archify.mjs");

interface ArchifyDiagramCase {
  readonly id: string;
  readonly locale: "en" | "fr";
  readonly type: "workflow" | "lifecycle" | "architecture";
  readonly jsonPath: string;
  readonly htmlPath: string;
}

const ARCHIFY_DIAGRAM_CASES: readonly ArchifyDiagramCase[] = [
  {
    id: "en-epure-issue-flow-workflow",
    locale: "en",
    type: "workflow",
    jsonPath: "docs/archify/en/epure-issue-flow.workflow.json",
    htmlPath: "docs/public/diagrams/en/epure-issue-flow.html"
  },
  {
    id: "fr-epure-issue-flow-workflow",
    locale: "fr",
    type: "workflow",
    jsonPath: "docs/archify/fr/epure-issue-flow.workflow.json",
    htmlPath: "docs/public/diagrams/fr/epure-issue-flow.html"
  },
  {
    id: "en-epure-state-machine-lifecycle",
    locale: "en",
    type: "lifecycle",
    jsonPath: "docs/archify/en/epure-state-machine.lifecycle.json",
    htmlPath: "docs/public/diagrams/en/epure-state-machine.html"
  },
  {
    id: "fr-epure-state-machine-lifecycle",
    locale: "fr",
    type: "lifecycle",
    jsonPath: "docs/archify/fr/epure-state-machine.lifecycle.json",
    htmlPath: "docs/public/diagrams/fr/epure-state-machine.html"
  },
  {
    id: "en-epure-security-architecture",
    locale: "en",
    type: "architecture",
    jsonPath: "docs/archify/en/epure-security-architecture.architecture.json",
    htmlPath: "docs/public/diagrams/en/epure-security-architecture.html"
  },
  {
    id: "fr-epure-security-architecture",
    locale: "fr",
    type: "architecture",
    jsonPath: "docs/archify/fr/epure-security-architecture.architecture.json",
    htmlPath: "docs/public/diagrams/fr/epure-security-architecture.html"
  },
  {
    id: "en-epure-review-pipeline-workflow",
    locale: "en",
    type: "workflow",
    jsonPath: "docs/archify/en/epure-review-pipeline.workflow.json",
    htmlPath: "docs/public/diagrams/en/epure-review-pipeline.html"
  },
  {
    id: "fr-epure-review-pipeline-workflow",
    locale: "fr",
    type: "workflow",
    jsonPath: "docs/archify/fr/epure-review-pipeline.workflow.json",
    htmlPath: "docs/public/diagrams/fr/epure-review-pipeline.html"
  }
];

interface BilingualPagePairCase {
  readonly id: string;
  readonly enPath: string;
  readonly frPath: string;
  readonly requiredEnMarkers: readonly string[];
  readonly requiredFrMarkers: readonly string[];
}

const BILINGUAL_PAGE_PAIRS: readonly BilingualPagePairCase[] = [
  {
    id: "home-index-page-pair",
    enPath: "docs/index.md",
    frPath: "docs/fr/index.md",
    requiredEnMarkers: ["EPURE", "epure-issue-flow"],
    requiredFrMarkers: ["EPURE", "epure-issue-flow"]
  },
  {
    id: "introduction-etymology-and-tripartition-pair",
    enPath: "docs/introduction.md",
    frPath: "docs/fr/introduction.md",
    requiredEnMarkers: [
      "Engineered",
      "Mandatory Human Validation Gates",
      "Mandatory Automated Steps",
      "Optional or Conditional Steps"
    ],
    requiredFrMarkers: [
      "Épure",
      "Portes de Validation Humaine Obligatoires",
      "Étapes Automatisées Obligatoires",
      "Étapes Facultatives ou Conditionnelles"
    ]
  },
  {
    id: "installation-and-bootstrap-pair",
    enPath: "docs/installation.md",
    frPath: "docs/fr/installation.md",
    requiredEnMarkers: [
      "/setup-repo",
      "setup-repo.mjs",
      "EPURE_AGENT_APP_ID",
      "EPURE_RELEASE_APP_ID"
    ],
    requiredFrMarkers: [
      "/setup-repo",
      "setup-repo.mjs",
      "EPURE_AGENT_APP_ID",
      "EPURE_RELEASE_APP_ID"
    ]
  },
  {
    id: "basic-usage-craft-calculator-case-study-pair",
    enPath: "docs/basic-usage.md",
    frPath: "docs/fr/basic-usage.md",
    requiredEnMarkers: [
      "craft-calculator",
      "/epure plan",
      "/epure approve",
      "epure-state-machine"
    ],
    requiredFrMarkers: [
      "craft-calculator",
      "/epure plan",
      "/epure approve",
      "epure-state-machine"
    ]
  },
  {
    id: "commands-reference-pair",
    enPath: "docs/commands.md",
    frPath: "docs/fr/commands.md",
    requiredEnMarkers: [
      "/epure plan",
      "/epure approve",
      "/epure to-spec",
      "/epure to-tickets",
      "/epure status",
      "/epure cancel"
    ],
    requiredFrMarkers: [
      "/epure plan",
      "/epure approve",
      "/epure to-spec",
      "/epure to-tickets",
      "/epure status",
      "/epure cancel"
    ]
  },
  {
    id: "configuration-agents-yml-pair",
    enPath: "docs/configuration.md",
    frPath: "docs/fr/configuration.md",
    requiredEnMarkers: [
      ".github/agents.yml",
      "max_code_fix_attempts",
      "max_parallel_reviewers",
      "enable_pages_preview"
    ],
    requiredFrMarkers: [
      ".github/agents.yml",
      "max_code_fix_attempts",
      "max_parallel_reviewers",
      "enable_pages_preview"
    ]
  },
  {
    id: "architecture-and-security-pair",
    enPath: "docs/architecture.md",
    frPath: "docs/fr/architecture.md",
    requiredEnMarkers: [
      "epure-security-architecture",
      "epure-review-pipeline",
      "<untrusted_pr_diff>"
    ],
    requiredFrMarkers: [
      "epure-security-architecture",
      "epure-review-pipeline",
      "<untrusted_pr_diff>"
    ]
  },
  {
    id: "how-to-onboard-repo-pair",
    enPath: "docs/guides/how-to-onboard-repo.md",
    frPath: "docs/fr/guides/how-to-onboard-repo.md",
    requiredEnMarkers: ["--dry-run", "--apply", "--require-pr-approvals"],
    requiredFrMarkers: ["--dry-run", "--apply", "--require-pr-approvals"]
  },
  {
    id: "how-to-drive-an-issue-pair",
    enPath: "docs/guides/how-to-drive-an-issue.md",
    frPath: "docs/fr/guides/how-to-drive-an-issue.md",
    requiredEnMarkers: ["/epure plan", "needs-human", "approved-sensitive-change"],
    requiredFrMarkers: ["/epure plan", "needs-human", "approved-sensitive-change"]
  },
  {
    id: "how-to-customize-reviewers-pair",
    enPath: "docs/guides/how-to-customize-reviewers.md",
    frPath: "docs/fr/guides/how-to-customize-reviewers.md",
    requiredEnMarkers: [
      "spec-parity-reviewer",
      "user-advocate",
      "impeccable-gate"
    ],
    requiredFrMarkers: [
      "spec-parity-reviewer",
      "user-advocate",
      "impeccable-gate"
    ]
  },
  {
    id: "how-to-release-pair",
    enPath: "docs/guides/how-to-release.md",
    frPath: "docs/fr/guides/how-to-release.md",
    requiredEnMarkers: ["release-promote.yml", "v1.0.0"],
    requiredFrMarkers: ["release-promote.yml", "v1.0.0"]
  },
  {
    id: "glossary-reference-pair",
    enPath: "docs/reference/glossary.md",
    frPath: "docs/fr/reference/glossary.md",
    requiredEnMarkers: ["Mandatory Human Validation Gates", "GLOSSARY.md"],
    requiredFrMarkers: ["<!--@include: ../../../GLOSSARY.md-->"]
  }
];

function auditDocsImpeccableSurface(): ImpeccablePrFinding[] {
  const findings: ImpeccablePrFinding[] = [];
  const designMdPath = resolve(REPO_ROOT, "DESIGN.md");
  const customCssPath = resolve(REPO_ROOT, "docs/.vitepress/theme/custom.css");
  const archifyVuePath = resolve(
    REPO_ROOT,
    "docs/.vitepress/theme/components/ArchifyDiagram.vue"
  );

  if (!existsSync(designMdPath)) {
    findings.push({
      id: "missing-design-md",
      category: "design_md_or_surface_rule",
      message: "DESIGN.md must exist at repository root.",
      isPreExistingInBaseline: false,
      hasApprovedException: false
    });
    return findings;
  }

  const designMd = readFileSync(designMdPath, "utf8");
  const customCss = readFileSync(customCssPath, "utf8");
  const archifyVue = readFileSync(archifyVuePath, "utf8");

  if (!designMd.includes("--epure-brand-1") || !customCss.includes("--epure-brand-1")) {
    findings.push({
      id: "missing-design-tokens",
      category: "design_md_or_surface_rule",
      message: "CSS tokens from DESIGN.md (--epure-brand-1) must be applied in custom.css.",
      isPreExistingInBaseline: false,
      hasApprovedException: false
    });
  }

  if (
    !archifyVue.includes('role="group"') ||
    !archifyVue.includes(":title=") ||
    !archifyVue.includes(":focus-visible") ||
    !archifyVue.includes("Escape")
  ) {
    findings.push({
      id: "archify-a11y-keyboard-contract",
      category: "wcag_aria_contrast_keyboard",
      message:
        "<ArchifyDiagram> must provide ARIA group semantics, iframe title, :focus-visible outline, and Escape key handling.",
      isPreExistingInBaseline: false,
      hasApprovedException: false
    });
  }

  if (
    !archifyVue.includes("status === 'loading'") ||
    !archifyVue.includes("status === 'error'") ||
    !archifyVue.includes('role="status"') ||
    !archifyVue.includes('role="alert"')
  ) {
    findings.push({
      id: "archify-missing-loading-error-states",
      category: "missing_loading_error_empty_state",
      message:
        "<ArchifyDiagram> must expose explicit loading (role=status) and error (role=alert) states.",
      isPreExistingInBaseline: false,
      hasApprovedException: false
    });
  }

  if (!customCss.includes("overflow-x: hidden") || !archifyVue.includes("@media (max-width: 640px)")) {
    findings.push({
      id: "docs-responsive-overflow-contract",
      category: "responsive_layout_overflow",
      message:
        "Documentation theme and <ArchifyDiagram> must guard against horizontal overflow and adapt to mobile viewports.",
      isPreExistingInBaseline: false,
      hasApprovedException: false
    });
  }

  return findings;
}

describe("Bilingual VitePress Documentation, Archify Showcase Diagrams & Impeccable Gate (Q97–Q103)", () => {
  it.each(ARCHIFY_DIAGRAM_CASES)(
    "validates $id ($locale / $type) at showcase quality with 0 errors and 0 warnings",
    ({ type, jsonPath, htmlPath }) => {
      const absJson = resolve(REPO_ROOT, jsonPath);
      const absHtml = resolve(REPO_ROOT, htmlPath);

      expect(existsSync(absJson)).toBe(true);
      expect(existsSync(absHtml)).toBe(true);

      const validateStdout = execFileSync(
        process.execPath,
        [
          ARCHIFY_BIN,
          "validate",
          type,
          absJson,
          "--quality",
          "showcase",
          "--repo-root",
          REPO_ROOT,
          "--json"
        ],
        { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
      );
      const validation = JSON.parse(validateStdout) as {
        readonly ok: boolean;
        readonly composition: {
          readonly profile: string;
          readonly status: string;
          readonly summary: {
            readonly errors: number;
            readonly warnings: number;
          };
        };
      };

      expect(validation.ok).toBe(true);
      expect(validation.composition.profile).toBe("showcase");
      expect(validation.composition.status).toBe("pass");
      expect(validation.composition.summary.errors).toBe(0);
      expect(validation.composition.summary.warnings).toBe(0);

      const checkStdout = execFileSync(
        process.execPath,
        [ARCHIFY_BIN, "check", absHtml, "--json"],
        { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
      );
      const htmlCheck = JSON.parse(checkStdout) as { readonly ok: boolean };
      expect(htmlCheck.ok).toBe(true);
    }
  );

  it.each(BILINGUAL_PAGE_PAIRS)(
    "verifies 1-to-1 EN/FR parity and required markers for $id",
    ({ enPath, frPath, requiredEnMarkers, requiredFrMarkers }) => {
      const absEn = resolve(REPO_ROOT, enPath);
      const absFr = resolve(REPO_ROOT, frPath);

      expect(existsSync(absEn)).toBe(true);
      expect(existsSync(absFr)).toBe(true);

      const enContent = readFileSync(absEn, "utf8");
      const frContent = readFileSync(absFr, "utf8");

      for (const marker of requiredEnMarkers) {
        expect(enContent).toContain(marker);
      }
      for (const marker of requiredFrMarkers) {
        expect(frContent).toContain(marker);
      }

      expect(enContent.toLowerCase()).not.toContain("enclume-astrale");
      expect(frContent.toLowerCase()).not.toContain("enclume-astrale");
      expect(enContent.toLowerCase()).not.toContain("poetry");
      expect(frContent.toLowerCase()).not.toContain("poetry");
    }
  );

  it("verifies .github/workflows/docs.yml pins all GitHub Actions to 40-char SHAs and uses least-privilege permissions", () => {
    const workflowContent = readFileSync(
      resolve(REPO_ROOT, ".github/workflows/docs.yml"),
      "utf8"
    );
    const usesLines = workflowContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("uses:"));

    expect(usesLines.length).toBeGreaterThanOrEqual(4);
    for (const line of usesLines) {
      expect(line).toMatch(/^uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\b/);
    }
    expect(workflowContent).toContain("contents: read");
    expect(workflowContent).toContain("pages: write");
    expect(workflowContent).toContain("id-token: write");
  });

  it("enforces single-source GLOSSARY.md inclusion and Round 24 (Q97–Q103) domain updates", () => {
    const glossary = readFileSync(resolve(REPO_ROOT, "GLOSSARY.md"), "utf8");
    const decisions = readFileSync(resolve(REPO_ROOT, "docs/DECISIONS.md"), "utf8");
    const frGlossaryPage = readFileSync(
      resolve(REPO_ROOT, "docs/fr/reference/glossary.md"),
      "utf8"
    );

    expect(glossary).toContain("Portes de validation humaine obligatoires (4 jalons, Q101)");
    expect(glossary).toContain("Étapes automatisées obligatoires (Q101)");
    expect(glossary).toContain("Étapes facultatives ou conditionnelles (Q101)");
    expect(decisions).toContain("Ronde 24 — Q97 à Q103");
    expect(frGlossaryPage).toContain("<!--@include: ../../../GLOSSARY.md-->");
  });

  it("evaluates the documentation site and <ArchifyDiagram> against DESIGN.md via evaluateImpeccableFrontendPr with 0 blocking findings (Q103)", () => {
    const findings = auditDocsImpeccableSurface();
    const verdict = evaluateImpeccableFrontendPr({ findings });

    expect(verdict.conclusion).toBe("success");
    expect(verdict.blocking_findings).toHaveLength(0);
  });

  it("provides SEO metadata (sitemap, canonical, hreflang, JSON-LD, OpenGraph) and LLM discovery files (robots.txt, llms.txt, llms-full.txt)", () => {
    const configMts = readFileSync(
      resolve(REPO_ROOT, "docs/.vitepress/config.mts"),
      "utf8"
    );
    const robotsTxt = readFileSync(
      resolve(REPO_ROOT, "docs/public/robots.txt"),
      "utf8"
    );
    const llmsTxt = readFileSync(
      resolve(REPO_ROOT, "docs/public/llms.txt"),
      "utf8"
    );
    const llmsFullTxt = readFileSync(
      resolve(REPO_ROOT, "docs/public/llms-full.txt"),
      "utf8"
    );

    expect(configMts).toContain("sitemap:");
    expect(configMts).toContain("transformHead");
    expect(configMts).toContain("application/ld+json");
    expect(configMts).toContain("hreflang");
    expect(configMts).toContain("canonical");

    expect(robotsTxt).toContain("Sitemap: https://giskard-ai.github.io/epure/sitemap.xml");
    expect(robotsTxt).toContain("GPTBot");
    expect(robotsTxt).toContain("ClaudeBot");
    expect(robotsTxt).toContain("PerplexityBot");

    expect(llmsTxt).toContain("# EPURE (Giskard-AI/epure)");
    expect(llmsTxt).toContain("https://giskard-ai.github.io/epure/llms-full.txt");
    expect(llmsTxt).toContain("/setup-repo");
    expect(llmsFullTxt).toContain("## [EN] Introduction & Naming (L'Épure)");
    expect(llmsFullTxt).toContain("## [FR] Introduction & Nom (L'Épure)");
  });
});
