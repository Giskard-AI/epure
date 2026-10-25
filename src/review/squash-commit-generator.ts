import { CONVENTIONAL_COMMIT_PATTERN_REGEX } from "../bootstrap/setup-repo.js";
import {
  callGeminiGenerateContent,
  extractJsonObject
} from "../orchestrator/gemini-client.js";
import {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  wrapUntrustedContent
} from "../security/prompt-injection-guard.js";

export interface GenerateSquashCommitInput {
  readonly prNumber: number;
  readonly targetBranch: string;
  readonly defaultBranch?: string | undefined;
  readonly planIssueNumber: number;
  readonly ticketNumbers: readonly number[];
  readonly fallbackTitle: string;
  readonly changedFiles: ReadonlyArray<{
    readonly path: string;
    readonly content?: string | undefined;
    readonly patch?: string | undefined;
  }>;
  readonly llmApiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface GeneratedSquashCommit {
  readonly pr_title: string;
  readonly commit_title: string;
  readonly commit_message: string;
  readonly uses_closes_keyword: boolean;
}

const CONVENTIONAL_REGEX = new RegExp(CONVENTIONAL_COMMIT_PATTERN_REGEX);

export function normalizeConventionalCommitTitle(
  rawTitle: string,
  defaultScope = "core"
): string {
  const clean = rawTitle
    .trim()
    .replace(/\s*\(#\d+\)\s*$/, "")
    .replace(/^\[ticket\s*\d+\]\s*/i, "")
    .replace(/^\[plan\]\s*/i, "")
    .trim();

  if (CONVENTIONAL_REGEX.test(clean)) {
    return clean;
  }

  const sanitizedScope =
    defaultScope
      .toLowerCase()
      .replace(/[^a-z0-9/-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "core";

  const summary = clean.charAt(0).toLowerCase() + clean.slice(1);
  return `feat(${sanitizedScope}): ${summary || "update implementation"}`;
}

function buildIssueTrailerLines(params: {
  readonly isLandingOnDefaultBranch: boolean;
  readonly planIssueNumber: number;
  readonly ticketNumbers: readonly number[];
}): {
  readonly trailerLines: readonly string[];
  readonly usesClosesKeyword: boolean;
} {
  if (params.isLandingOnDefaultBranch) {
    const lines: string[] = [`Closes #${params.planIssueNumber}`];
    for (const t of params.ticketNumbers) {
      if (t !== params.planIssueNumber) {
        lines.push(`Closes #${t}`);
      }
    }
    return {
      trailerLines: lines,
      usesClosesKeyword: true
    };
  }

  // Q94: On task/* -> feature/* (non-default branch), use Refs #<ticket> + Part of #<plan>
  const lines: string[] = [];
  for (const t of params.ticketNumbers) {
    lines.push(`Refs #${t}`);
  }
  lines.push(`Part of #${params.planIssueNumber}`);
  return {
    trailerLines: lines,
    usesClosesKeyword: false
  };
}

export async function generateSemanticSquashCommitFromDiff(
  input: GenerateSquashCommitInput
): Promise<GeneratedSquashCommit> {
  const cleanTarget = input.targetBranch.trim().replace(/^refs\/heads\//, "");
  const defaultBranch = (input.defaultBranch ?? "dev")
    .trim()
    .replace(/^refs\/heads\//, "");
  const isLandingOnDefaultBranch =
    cleanTarget === defaultBranch || cleanTarget === "main";

  const scopeHint =
    input.ticketNumbers.length === 1
      ? `ticket-${input.ticketNumbers[0]}`
      : `plan-${input.planIssueNumber}`;

  const defaultPrTitle = normalizeConventionalCommitTitle(
    input.fallbackTitle,
    scopeHint
  );
  const defaultBullets = input.changedFiles
    .slice(0, 8)
    .map((f) => `- update \`${f.path}\``);

  const trailers = buildIssueTrailerLines({
    isLandingOnDefaultBranch,
    planIssueNumber: input.planIssueNumber,
    ticketNumbers: input.ticketNumbers
  });

  if (!input.llmApiKey || !input.llmApiKey.trim()) {
    const commitTitle = `${defaultPrTitle} (#${input.prNumber})`;
    const commitMessage = [
      ...(defaultBullets.length > 0
        ? defaultBullets
        : ["- apply verified implementation changes"]),
      "",
      ...trailers.trailerLines
    ].join("\n");
    return {
      pr_title: defaultPrTitle,
      commit_title: commitTitle,
      commit_message: commitMessage,
      uses_closes_keyword: trailers.usesClosesKeyword
    };
  }

  try {
    const diffSnippet = input.changedFiles
      .map((f) => {
        const snippet = (f.patch ?? f.content ?? "").slice(0, 1500);
        return `--- ${f.path} ---\n${snippet}`;
      })
      .join("\n\n")
      .slice(0, 10000);

    const systemInstruction = [
      "Tu es un assistant de release Git produisant un titre et un corps de commit de squash Conventional Commit concis à partir du diff réel d'une Pull Request.",
      PROMPT_INJECTION_IMMUNITY_CLAUSE,
      "Règles :",
      `1. 'pr_title' DOIT respecter strictement l'expression régulière : ${CONVENTIONAL_COMMIT_PATTERN_REGEX} (sans numéro de PR à la fin).`,
      "2. 'bullets' DOIT contenir 2 à 4 puces synthétiques décrivant les changements techniques réels du diff.",
      "Renvoie uniquement un JSON valide :",
      "{",
      '  "pr_title": "feat(scope): concise summary",',
      '  "bullets": ["- first key change", "- second key change"]',
      "}"
    ].join("\n");

    const prompt = [
      `PR #${input.prNumber} vers '${cleanTarget}'`,
      "Titre initial (non fiable) :",
      wrapUntrustedContent("untrusted_issue_content", input.fallbackTitle, 500),
      "",
      "Fichiers modifiés (diff non fiable) :",
      wrapUntrustedContent("untrusted_pr_diff", diffSnippet, 10000)
    ].join("\n");

    const raw = await callGeminiGenerateContent({
      apiKey: input.llmApiKey,
      model: input.model ?? "gemini-3.8-flash",
      systemInstruction,
      prompt,
      responseMimeType: "application/json",
      temperature: 0.0,
      fetchImpl: input.fetchImpl
    });

    const parsed = extractJsonObject<{
      pr_title?: string;
      bullets?: string[];
    }>(raw);

    const validPrTitle = normalizeConventionalCommitTitle(
      parsed.pr_title ?? defaultPrTitle,
      scopeHint
    );
    const bullets =
      Array.isArray(parsed.bullets) && parsed.bullets.length > 0
        ? parsed.bullets.map((b) =>
            b.trim().startsWith("-") ? b.trim() : `- ${b.trim()}`
          )
        : defaultBullets;

    const commitTitle = `${validPrTitle} (#${input.prNumber})`;
    const commitMessage = [...bullets, "", ...trailers.trailerLines].join("\n");

    return {
      pr_title: validPrTitle,
      commit_title: commitTitle,
      commit_message: commitMessage,
      uses_closes_keyword: trailers.usesClosesKeyword
    };
  } catch {
    const commitTitle = `${defaultPrTitle} (#${input.prNumber})`;
    const commitMessage = [
      ...(defaultBullets.length > 0
        ? defaultBullets
        : ["- apply verified implementation changes"]),
      "",
      ...trailers.trailerLines
    ].join("\n");
    return {
      pr_title: defaultPrTitle,
      commit_title: commitTitle,
      commit_message: commitMessage,
      uses_closes_keyword: trailers.usesClosesKeyword
    };
  }
}
