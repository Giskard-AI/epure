import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertNoSecretMaterial,
  type AgentEngine
} from "../../agent/engine.js";
import { snapshotWorktree } from "../../agent/worktree-snapshot.js";
import type { LLMClient } from "../../llm/client.js";
import type { LLMCallOptions } from "../../llm/types.js";
import { DEFAULT_REVIEWERS_DIR } from "../../review/reviewer-roster.js";
import {
  collectRunnerSecretValues,
  type SandboxExecutionInput,
  type SandboxExecutionResult
} from "../../sandbox/llm-sandbox.js";
import {
  isSensitiveTaskBranchPath,
  validateWorkspaceFileOperations
} from "../../sandbox/polyglot-workspace-runner.js";
import {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  wrapUntrustedContent
} from "../../security/prompt-injection-guard.js";
import {
  buildIssueStateRefName,
  updateIssueStateWithCas,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import { callLlmJson } from "../llm-helper.js";
import { EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT } from "../prompts/code-discipline.js";
import {
  ADR_COHERENCE_RECONCILIATION_SCHEMA,
  CONFLICT_RESOLUTION_SCHEMA,
  type AdrCoherenceReconciliationPayload,
  type ConflictResolutionPayload
} from "../prompts/schemas.js";
import type {
  EscalateToNeedsHumanFn,
  GitBlobRef,
  GitHubRestHelper
} from "../types.js";
import { runTestsInIsolatedWorkspace } from "../workspace/repo-tools.js";
import { TruncatedGitTreeError } from "./rest-client.js";

type Escalation = Parameters<EscalateToNeedsHumanFn>[0];

interface ParsedGlossaryTerm {
  readonly key: string;
  readonly rawName: string;
  readonly sectionHeader: string;
  readonly blockText: string;
}

const TERM_START_REGEX = /^(?:-\s+)?\*\*([^*]+)\*\*/;
const SECTION_HEADER_REGEX = /^##\s+(.+)$/;

function normalizeGlossaryKey(rawTerm: string): string {
  return rawTerm.trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseGlossaryTerms(markdown: string): ParsedGlossaryTerm[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const terms: ParsedGlossaryTerm[] = [];
  let currentSection = "";
  let currentSectionLines: string[] = [];
  let sectionHasBulletTerms = false;
  let currentKey: string | null = null;
  let currentRawName = "";
  let currentTermSection = "";
  let currentLines: string[] = [];

  const trimTrailingBlankLines = (arr: string[]): void => {
    while (arr.length > 0 && arr[arr.length - 1]!.trim() === "") {
      arr.pop();
    }
  };

  const flushTerm = (): void => {
    if (currentKey !== null && currentLines.length > 0) {
      trimTrailingBlankLines(currentLines);
      terms.push({
        key: currentKey,
        rawName: currentRawName,
        sectionHeader: currentTermSection,
        blockText: currentLines.join("\n")
      });
    }
    currentKey = null;
    currentRawName = "";
    currentLines = [];
  };

  const flushHeadingSectionAsTermIfNoBullets = (): void => {
    flushTerm();
    if (!sectionHasBulletTerms && currentSection && currentSectionLines.length > 1) {
      trimTrailingBlankLines(currentSectionLines);
      const headingName = currentSection.replace(/^##+\s+/, "").trim();
      terms.push({
        key: normalizeGlossaryKey(headingName),
        rawName: headingName,
        sectionHeader: "",
        blockText: currentSectionLines.join("\n")
      });
    }
    currentSectionLines = [];
    sectionHasBulletTerms = false;
  };

  let inCodeFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
    }
    if (!inCodeFence) {
      if (/^#\s+/.test(trimmed)) {
        flushHeadingSectionAsTermIfNoBullets();
        currentSection = "";
        continue;
      }
      const secMatch = SECTION_HEADER_REGEX.exec(trimmed);
      if (secMatch) {
        flushHeadingSectionAsTermIfNoBullets();
        currentSection = trimmed;
        currentSectionLines = [line];
        continue;
      }
      const termMatch = TERM_START_REGEX.exec(trimmed);
      if (termMatch && termMatch[1]) {
        flushTerm();
        sectionHasBulletTerms = true;
        currentRawName = termMatch[1].trim();
        currentKey = normalizeGlossaryKey(currentRawName);
        currentTermSection = currentSection;
        currentLines = [line];
        continue;
      }
    }
    if (currentKey !== null) {
      currentLines.push(line);
    } else if (currentSection) {
      currentSectionLines.push(line);
    }
  }
  flushHeadingSectionAsTermIfNoBullets();
  return terms;
}

// Only the plan terms added or reworded since `previousPlanGlossary`, so terms the plan left alone keep their feature/* wording.
function glossaryTermsChangedSince(
  planGlossary: string,
  previousPlanGlossary: string
): string {
  const previous = new Map(
    parseGlossaryTerms(previousPlanGlossary).map((t) => [t.key, t.blockText])
  );
  const blocksBySection = new Map<string, string[]>();
  for (const term of parseGlossaryTerms(planGlossary)) {
    if (previous.get(term.key) !== term.blockText) {
      blocksBySection.set(term.sectionHeader, [
        ...(blocksBySection.get(term.sectionHeader) ?? []),
        term.blockText
      ]);
    }
  }
  return [...blocksBySection.entries()]
    .map(([header, blocks]) => [header, ...blocks].filter(Boolean).join("\n\n"))
    .join("\n\n");
}

/**
 * Deterministically merges `planGlossary` into `baseGlossary` (`dev`) additively:
 * - Preserves 100% of terms present in `baseGlossary` (`dev`), including terms added concurrently by other issues.
 * - Updates any existing term if `planGlossary` explicitly changed its definition, and appends all new terms/sections from `planGlossary`.
 */
export function mergeGlossaryMarkdownAdditively(
  baseGlossary: string | null | undefined,
  planGlossary: string | null | undefined
): string {
  const cleanBase = (baseGlossary ?? "").replace(/\r\n/g, "\n").trim();
  const cleanPlan = (planGlossary ?? "").replace(/\r\n/g, "\n").trim();
  if (!cleanBase) {
    return cleanPlan ? `${cleanPlan}\n` : "";
  }
  if (!cleanPlan || cleanBase === cleanPlan) {
    return `${cleanBase}\n`;
  }

  const baseTerms = parseGlossaryTerms(cleanBase);
  const planTerms = parseGlossaryTerms(cleanPlan);
  const baseTermByKey = new Map<string, ParsedGlossaryTerm>();
  for (const t of baseTerms) {
    baseTermByKey.set(t.key, t);
  }

  let merged = cleanBase;
  const newTermsBySection = new Map<string, ParsedGlossaryTerm[]>();

  for (const planTerm of planTerms) {
    const existing = baseTermByKey.get(planTerm.key);
    if (existing) {
      if (
        existing.blockText !== planTerm.blockText &&
        merged.includes(existing.blockText)
      ) {
        merged = merged.replace(existing.blockText, () => planTerm.blockText);
      }
    } else {
      const sec = planTerm.sectionHeader || "";
      const list = newTermsBySection.get(sec) ?? [];
      list.push(planTerm);
      newTermsBySection.set(sec, list);
    }
  }

  for (const [sectionHeader, termsToAdd] of newTermsBySection.entries()) {
    const formattedBlocks = termsToAdd.map((t) => t.blockText).join("\n\n");
    const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headerMatch = sectionHeader
      ? new RegExp(`^${escapedHeader}$`, "m").exec(merged)
      : null;
    if (sectionHeader && headerMatch && headerMatch.index !== undefined) {
      const secIndex = headerMatch.index;
      const afterSec = secIndex + sectionHeader.length;
      const nextSecMatch = /\n##\s+/.exec(merged.slice(afterSec));
      if (nextSecMatch && nextSecMatch.index !== undefined) {
        const insertPos = afterSec + nextSecMatch.index;
        merged = `${merged.slice(0, insertPos).trimEnd()}\n\n${formattedBlocks}\n${merged.slice(insertPos)}`;
      } else {
        merged = `${merged.trimEnd()}\n\n${formattedBlocks}`;
      }
    } else if (sectionHeader) {
      merged = `${merged.trimEnd()}\n\n${sectionHeader}\n\n${formattedBlocks}`;
    } else {
      merged = `${merged.trimEnd()}\n\n${formattedBlocks}`;
    }
  }

  return `${merged.trimEnd()}\n`;
}

export interface RenumberCollidingAdrsInput {
  readonly devPaths: readonly string[];
  readonly planAdrs: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly specFiles?: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }> | undefined;
  readonly glossaryContent?: string | undefined;
}

export interface RenumberCollidingAdrsResult {
  readonly adrs: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly oldPath: string;
    readonly renumbered: boolean;
  }>;
  readonly specFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly glossaryContent?: string | undefined;
  readonly deletedAdrPaths: readonly string[];
}

const ADR_PATH_REGEX = /^docs\/adr\/(\d{4})-(.+)\.md$/;

/**
 * Paths of the planning artifacts on a branch: `GLOSSARY.md` and `extraPaths` plus the files of `docs/adr/` and `docs/specs/`.
 * `GLOSSARY.md` and `extraPaths` are always listed; a missing one reads as null like an absent path.
 */
async function listPlanArtifactPaths(
  gh: Pick<GitHubRestHelper, "listDirectoryPaths">,
  branch: string,
  extraPaths: readonly string[] = []
): Promise<string[]> {
  const [adrPaths, specPaths] = await Promise.all([
    gh.listDirectoryPaths(branch, "docs/adr"),
    gh.listDirectoryPaths(branch, "docs/specs")
  ]);
  return [
    ...new Set(
      ["GLOSSARY.md", ...extraPaths, ...adrPaths, ...specPaths].map((p) =>
        p.trim().replace(/^\/+/, "")
      )
    )
  ];
}

function normalizeAdrSlug(rawSlug: string): string {
  return rawSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function replaceAdrReferencesSinglePass(
  text: string,
  replacements: ReadonlyArray<{
    oldNumStr: string;
    newNumStr: string;
    oldFileName: string;
    newFileName: string;
  }>
): string {
  if (replacements.length === 0) {
    return text;
  }
  const numByOld = new Map<string, string>();
  const fileByOld = new Map<string, string>();
  for (const r of replacements) {
    numByOld.set(r.oldNumStr, r.newNumStr);
    fileByOld.set(r.oldFileName, r.newFileName);
  }
  const escapedFiles = Array.from(fileByOld.keys()).map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  let result = text;
  if (escapedFiles.length > 0) {
    const fileRegex = new RegExp(escapedFiles.join("|"), "g");
    result = result.replace(
      fileRegex,
      (matched) => fileByOld.get(matched) ?? matched
    );
  }
  return result.replace(
    /\bADR(-|\s+)(\d{4})\b/g,
    (full, sep: string, numStr: string) => {
      const mapped = numByOld.get(numStr);
      return mapped ? `ADR${sep}${mapped}` : full;
    }
  );
}

/**
 * Automatically resolves ADR number collisions and deduplicates ADRs by slug (`docs/adr/NNNN-<slug>.md`)
 * when `dev` has already allocated `docs/adr/NNNN-*.md` or when a branch accumulated duplicate ADR numbers
 * for the same slug (e.g., 0039/0042/0045), updating references in ADR content, `docs/specs/*.md`, and
 * `GLOSSARY.md` in a single atomic pass (ADR-0032, Q114).
 */
export function renumberCollidingAdrs(
  input: RenumberCollidingAdrsInput
): RenumberCollidingAdrsResult {
  const devAdrsByNumber = new Map<number, string>();
  const devAdrsBySlug = new Map<
    string,
    { num: number; numStr: string; slug: string; path: string }
  >();
  let maxAdrNumber = 0;

  for (const rawPath of input.devPaths) {
    const cleanPath = rawPath.trim().replace(/^\/+/, "");
    const match = ADR_PATH_REGEX.exec(cleanPath);
    if (match && match[1] && match[2]) {
      const num = Number.parseInt(match[1], 10);
      const normSlug = normalizeAdrSlug(match[2]);
      if (Number.isFinite(num)) {
        devAdrsByNumber.set(num, cleanPath);
        if (!devAdrsBySlug.has(normSlug)) {
          devAdrsBySlug.set(normSlug, {
            num,
            numStr: match[1],
            slug: match[2],
            path: cleanPath
          });
        }
        if (num > maxAdrNumber) {
          maxAdrNumber = num;
        }
      }
    }
  }

  const renumberMap = new Map<
    string,
    { oldNumStr: string; newNumStr: string; oldFileName: string; newFileName: string }
  >();
  const deletedAdrPathsSet = new Set<string>();

  // First pass: deduplicate planAdrs that share the same normalized slug (keep latest content, canonicalize number)
  const planBySlug = new Map<
    string,
    Array<{
      cleanPath: string;
      num: number;
      numStr: string;
      slug: string;
      content: string;
    }>
  >();
  const passthroughAdrs: Array<{
    readonly path: string;
    readonly content: string;
    readonly oldPath: string;
    readonly renumbered: boolean;
  }> = [];

  for (const adr of input.planAdrs) {
    const cleanPath = adr.path.trim().replace(/^\/+/, "");
    const match = ADR_PATH_REGEX.exec(cleanPath);
    if (!match || !match[1] || !match[2]) {
      passthroughAdrs.push({
        path: cleanPath,
        content: adr.content,
        oldPath: cleanPath,
        renumbered: false
      });
      continue;
    }
    const num = Number.parseInt(match[1], 10);
    const normSlug = normalizeAdrSlug(match[2]);
    const list = planBySlug.get(normSlug) ?? [];
    list.push({
      cleanPath,
      num,
      numStr: match[1],
      slug: match[2],
      content: adr.content
    });
    planBySlug.set(normSlug, list);
  }

  // Only count non-duplicate plan ADRs toward initial maxAdrNumber when their slug is not already on dev
  for (const [normSlug, entries] of planBySlug.entries()) {
    if (devAdrsBySlug.has(normSlug)) {
      continue;
    }
    const primary = entries[0]!;
    if (
      !devAdrsByNumber.has(primary.num) &&
      Number.isFinite(primary.num) &&
      primary.num > maxAdrNumber
    ) {
      maxAdrNumber = primary.num;
    }
  }

  const intermediateAdrs: Array<{
    path: string;
    content: string;
    oldPath: string;
    renumbered: boolean;
  }> = [...passthroughAdrs];

  for (const [normSlug, entries] of planBySlug.entries()) {
    entries.sort((a, b) => a.num - b.num);
    const latestEntry = entries[entries.length - 1]!;
    const earliestEntry = entries[0]!;
    const existingDevForSlug = devAdrsBySlug.get(normSlug);

    if (existingDevForSlug) {
      // Slug already exists on dev: reuse canonical dev number & path, delete any renumbered duplicates
      const canonicalPath = existingDevForSlug.path;
      const canonicalFileName = `${existingDevForSlug.numStr}-${existingDevForSlug.slug}.md`;
      let wasRenumbered = false;
      for (const entry of entries) {
        if (entry.cleanPath !== canonicalPath) {
          wasRenumbered = true;
          deletedAdrPathsSet.add(entry.cleanPath);
          renumberMap.set(entry.cleanPath, {
            oldNumStr: entry.numStr,
            newNumStr: existingDevForSlug.numStr,
            oldFileName: `${entry.numStr}-${entry.slug}.md`,
            newFileName: canonicalFileName
          });
        }
      }
      intermediateAdrs.push({
        path: canonicalPath,
        content: latestEntry.content,
        oldPath: latestEntry.cleanPath,
        renumbered: wasRenumbered
      });
      continue;
    }

    // Slug does not exist on dev yet: check if earliestEntry.num collides with a different slug on dev
    const collidingDevPath = devAdrsByNumber.get(earliestEntry.num);
    let targetNum = earliestEntry.num;
    let targetNumStr = earliestEntry.numStr;
    let targetSlug = earliestEntry.slug;
    let targetPath = earliestEntry.cleanPath;
    let renumbered = false;

    if (collidingDevPath && collidingDevPath !== earliestEntry.cleanPath) {
      maxAdrNumber = Math.max(maxAdrNumber, earliestEntry.num) + 1;
      targetNum = maxAdrNumber;
      targetNumStr = String(targetNum).padStart(4, "0");
      targetSlug = latestEntry.slug;
      targetPath = `docs/adr/${targetNumStr}-${targetSlug}.md`;
      renumbered = true;
    } else if (targetNum > maxAdrNumber) {
      maxAdrNumber = targetNum;
    }

    devAdrsByNumber.set(targetNum, targetPath);
    devAdrsBySlug.set(normSlug, {
      num: targetNum,
      numStr: targetNumStr,
      slug: targetSlug,
      path: targetPath
    });

    const targetFileName = `${targetNumStr}-${targetSlug}.md`;
    for (const entry of entries) {
      if (entry.cleanPath !== targetPath) {
        renumbered = true;
        deletedAdrPathsSet.add(entry.cleanPath);
        renumberMap.set(entry.cleanPath, {
          oldNumStr: entry.numStr,
          newNumStr: targetNumStr,
          oldFileName: `${entry.numStr}-${entry.slug}.md`,
          newFileName: targetFileName
        });
      }
    }

    intermediateAdrs.push({
      path: targetPath,
      content: latestEntry.content,
      oldPath: earliestEntry.cleanPath,
      renumbered
    });
  }

  const allReplacements = Array.from(renumberMap.values());
  const resultingAdrs = intermediateAdrs.map((adr) => ({
    ...adr,
    content: replaceAdrReferencesSinglePass(adr.content, allReplacements)
  }));
  const updatedSpecFiles = (input.specFiles ?? []).map((spec) => ({
    path: spec.path.trim().replace(/^\/+/, ""),
    content: replaceAdrReferencesSinglePass(spec.content, allReplacements)
  }));
  const updatedGlossaryContent =
    input.glossaryContent !== undefined
      ? replaceAdrReferencesSinglePass(input.glossaryContent, allReplacements)
      : undefined;

  return {
    adrs: resultingAdrs,
    specFiles: updatedSpecFiles,
    ...(updatedGlossaryContent !== undefined
      ? { glossaryContent: updatedGlossaryContent }
      : {}),
    deletedAdrPaths: Array.from(deletedAdrPathsSet)
  };
}

type LlmRequestTuning = Pick<
  LLMCallOptions,
  | "providers"
  | "maxTransientRetries"
  | "transientRetryBackoffSeconds"
  | "requestTimeoutMs"
>;

function pickLlmRequestTuning(source: LlmRequestTuning): LlmRequestTuning {
  return {
    providers: source.providers,
    maxTransientRetries: source.maxTransientRetries,
    transientRetryBackoffSeconds: source.transientRetryBackoffSeconds,
    requestTimeoutMs: source.requestTimeoutMs
  };
}

export interface ReconcileAdrsWithLlmInput extends LlmRequestTuning {
  readonly devAdrs: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly featureAdrs: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly specFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly glossaryContent?: string | undefined;
  readonly llmClient?: LLMClient | undefined;
  readonly llmApiKey?: string | undefined;
  readonly model: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly agentEngine?: AgentEngine | undefined;
  readonly worktreeDir?: string | undefined;
}

function parseAdrReconciliationFromText(
  text: string
): AdrCoherenceReconciliationPayload | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [
    ...(fenceMatch && fenceMatch[1] ? [fenceMatch[1].trim()] : []),
    trimmed
  ];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(
        candidate
      ) as Partial<AdrCoherenceReconciliationPayload>;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.updated_files) &&
        Array.isArray(parsed.deleted_adr_paths)
      ) {
        return {
          coherent: typeof parsed.coherent === "boolean" ? parsed.coherent : true,
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          updated_files: parsed.updated_files,
          deleted_adr_paths: parsed.deleted_adr_paths
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function reconcileAdrsWithLlm(
  input: ReconcileAdrsWithLlmInput
): Promise<AdrCoherenceReconciliationPayload | null> {
  if (!input.agentEngine && !input.llmClient && !input.llmApiKey) {
    return null;
  }
  if (input.devAdrs.length === 0 || input.featureAdrs.length === 0) {
    return null;
  }

  const systemInstruction = [
    "Tu es l'architecte EPURE chargé de la réconciliation sémantique et monotone des ADRs (ADR-0032, Q114 & Q118).",
    "Lorsqu'une branche `feature/*` ou `plan/*` est synchronisée avec `dev` où d'autres ADRs ont été fusionnés concurremment :",
    "1. Vérifie qu'aucune décision de `featureAdrs` n'est redondante ou contradictoire avec `devAdrs`.",
    "2. Si un ADR de `featureAdrs` porte sur la même décision architecturale qu'un ADR de `devAdrs` sous un autre slug, fusionne-le dans le chemin canonique de `devAdrs` et ajoute le chemin redondant dans `deleted_adr_paths`.",
    "3. Assure-toi que tous les liens et références `ADR-NNNN` dans les ADRs, les spécifications (`specFiles`) et `GLOSSARY.md` pointent vers les bons numéros et titres.",
    "4. Ne renvoie dans `updated_files` que les fichiers (`docs/adr/*.md`, `docs/specs/*.md`, `GLOSSARY.md`) dont le contenu doit être mis à jour.",
    EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT
  ].join("\n");

  const userPrompt = [
    "### ADRs déjà présents sur `dev` (contenu intégral) :",
    ...input.devAdrs.map(
      (a) =>
        `#### \`${a.path}\`\n${wrapUntrustedContent("untrusted_workspace_files", a.content)}`
    ),
    "",
    "### ADRs de la fonctionnalité courante (après renumérotation déterministe, contenu intégral) :",
    ...input.featureAdrs.map(
      (a) =>
        `#### \`${a.path}\`\n${wrapUntrustedContent("untrusted_workspace_files", a.content)}`
    ),
    "",
    "### Spécifications de la fonctionnalité (contenu intégral) :",
    ...input.specFiles.map(
      (s) =>
        `#### \`${s.path}\`\n${wrapUntrustedContent("untrusted_workspace_files", s.content)}`
    ),
    ...(input.glossaryContent
      ? [
          "",
          "### `GLOSSARY.md` (contenu intégral) :",
          wrapUntrustedContent(
            "untrusted_workspace_files",
            input.glossaryContent
          )
        ]
      : [])
  ].join("\n");

  try {
    if (input.agentEngine) {
      let tempWorktreeDir: string | undefined;
      let effectiveWorktreeDir = input.worktreeDir;
      const seedEntries = new Map<string, string>();
      for (const a of input.devAdrs) {
        seedEntries.set(a.path.trim().replace(/^\/+/, ""), a.content);
      }
      for (const a of input.featureAdrs) {
        seedEntries.set(a.path.trim().replace(/^\/+/, ""), a.content);
      }
      for (const s of input.specFiles) {
        seedEntries.set(s.path.trim().replace(/^\/+/, ""), s.content);
      }
      if (input.glossaryContent !== undefined) {
        seedEntries.set("GLOSSARY.md", input.glossaryContent);
      }
      if (!effectiveWorktreeDir) {
        tempWorktreeDir = mkdtempSync(join(tmpdir(), "epure-adr-reconcile-"));
        effectiveWorktreeDir = tempWorktreeDir;
        for (const [relPath, content] of seedEntries.entries()) {
          const fullPath = join(tempWorktreeDir, relPath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content, "utf8");
        }
      }
      const trackedPaths = Array.from(seedEntries.keys());
      const outerSnapshot = await snapshotWorktree(effectiveWorktreeDir, {
        trackedPaths
      });
      try {
        const session = await input.agentEngine.run({
          role: "adr_reconciler",
          toolPolicy: "write",
          instructions: systemInstruction,
          prompt: userPrompt,
          worktree: effectiveWorktreeDir,
          timeoutMs: input.requestTimeoutMs ?? 30 * 60 * 1000,
          model: input.model,
          providers: input.providers,
          trackedPaths
        });
        const outerDiff = await outerSnapshot.collect();
        const fileMap = new Map<string, string>();
        for (const f of outerDiff.files) {
          fileMap.set(f.path.trim().replace(/^\/+/, ""), f.content);
        }
        for (const f of session.diff.files) {
          fileMap.set(f.path.trim().replace(/^\/+/, ""), f.content);
        }
        const deletedSet = new Set<string>([
          ...outerDiff.deleted_files.map((p) => p.trim().replace(/^\/+/, "")),
          ...session.diff.deleted_files.map((p) => p.trim().replace(/^\/+/, ""))
        ]);
        const updated_files = Array.from(fileMap.entries())
          .filter(
            ([path]) =>
              path === "GLOSSARY.md" ||
              path.startsWith("docs/adr/") ||
              path.startsWith("docs/specs/")
          )
          .map(([path, content]) => ({ path, content }));
        const deleted_adr_paths = Array.from(deletedSet).filter((path) =>
          path.startsWith("docs/adr/")
        );
        if (updated_files.length > 0 || deleted_adr_paths.length > 0) {
          return {
            coherent: true,
            summary:
              session.finalMessage.trim() ||
              "Reconciled ADRs and GLOSSARY.md via agentEngine.",
            updated_files,
            deleted_adr_paths
          };
        }
        const parsedFromMessage = parseAdrReconciliationFromText(
          session.finalMessage
        );
        if (parsedFromMessage) {
          return parsedFromMessage;
        }
        if (!input.llmClient && !input.llmApiKey) {
          return {
            coherent: true,
            summary:
              session.finalMessage.trim() || "No ADR updates required.",
            updated_files: [],
            deleted_adr_paths: []
          };
        }
      } finally {
        outerSnapshot.dispose();
        if (tempWorktreeDir) {
          try {
            rmSync(tempWorktreeDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup error
          }
        }
      }
    }
    if (input.llmClient) {
      return await input.llmClient.completeStructured({
        model: input.model,
        ...pickLlmRequestTuning(input),
        systemInstruction,
        userPrompt,
        responseSchema: ADR_COHERENCE_RECONCILIATION_SCHEMA,
        temperature: 0.1
      });
    }
    return await callLlmJson<AdrCoherenceReconciliationPayload>({
      apiKey: input.llmApiKey ?? "",
      model: input.model,
      ...pickLlmRequestTuning(input),
      systemInstruction,
      prompt: userPrompt,
      temperature: 0.1,
      responseSchema: ADR_COHERENCE_RECONCILIATION_SCHEMA,
      fetchImpl: input.fetchImpl
    });
  } catch {
    return null;
  }
}

export interface IntegratePlanBranchIntoFeatureResult {
  readonly featureHeadSha: string;
  readonly committedPaths: readonly string[];
  readonly renumberedAdrs: ReadonlyArray<{
    readonly oldPath: string;
    readonly newPath: string;
  }>;
  readonly closedLegacyPlanPrNumber?: number | undefined;
}

async function applyAdrLlmReconciliation(params: {
  readonly gh: Pick<GitHubRestHelper, "readSingleBranchFile">;
  readonly baseBranch: string;
  readonly devAdrPaths: readonly string[];
  readonly featureAdrs: ReadonlyArray<{ path: string; content: string }>;
  readonly specFiles: ReadonlyArray<{ path: string; content: string }>;
  readonly glossaryContent?: string | undefined;
  readonly filesToMutate: Array<{ path: string; content: string }>;
  readonly deletedAdrPaths: string[];
  readonly llmClient?: LLMClient | undefined;
  readonly llmApiKey?: string | undefined;
  readonly model: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly agentEngine?: AgentEngine | undefined;
} & LlmRequestTuning): Promise<void> {
  if (!params.agentEngine && !params.llmClient && !params.llmApiKey) {
    return;
  }
  const devAdrsLoaded: Array<{ path: string; content: string }> = [];
  for (const dp of params.devAdrPaths) {
    const c = await params.gh.readSingleBranchFile(params.baseBranch, dp);
    if (c !== null) {
      devAdrsLoaded.push({ path: dp, content: c });
    }
  }
  const llmReconciled = await reconcileAdrsWithLlm({
    devAdrs: devAdrsLoaded,
    featureAdrs: params.featureAdrs,
    specFiles: params.specFiles,
    glossaryContent: params.glossaryContent,
    llmClient: params.llmClient,
    llmApiKey: params.llmApiKey,
    model: params.model,
    ...pickLlmRequestTuning(params),
    fetchImpl: params.fetchImpl,
    agentEngine: params.agentEngine
  });
  if (!llmReconciled) {
    return;
  }
  for (const updated of llmReconciled.updated_files) {
    if (
      updated.path === "GLOSSARY.md" ||
      updated.path.startsWith("docs/adr/") ||
      updated.path.startsWith("docs/specs/")
    ) {
      const existingIdx = params.filesToMutate.findIndex(
        (f) => f.path === updated.path
      );
      if (existingIdx >= 0) {
        params.filesToMutate[existingIdx] = updated;
      } else {
        params.filesToMutate.push(updated);
      }
    }
  }
  for (const delPath of llmReconciled.deleted_adr_paths) {
    if (
      delPath.startsWith("docs/adr/") &&
      !params.deletedAdrPaths.includes(delPath)
    ) {
      params.deletedAdrPaths.push(delPath);
    }
  }
}

/**
 * Integrates approved `plan/<issue>-<slug>` artifacts directly into `feature/<issue>-<slug>`
 * without opening a blocking `plan/* -> dev` PR:
 * - Closes any legacy open `plan/* -> dev` PR if present.
 * - Additively merges `GLOSSARY.md` into the `feature/*` version; other artifacts already changed on `feature/*` are kept.
 * - Automatically renumbers colliding `docs/adr/NNNN-*.md` files against `dev`.
 */
export async function integratePlanBranchIntoFeature(params: {
  readonly gh: GitHubRestHelper;
  readonly planBranch: string;
  readonly featureBranch: string;
  readonly baseBranch?: string | undefined;
  // `plan/*` head integrated last time: a feature file still equal to it was not edited by a human.
  readonly previousPlanSha?: string | undefined;
  // Paths recorded in the manifests: integrated wherever they live, the directory listing only adds to them.
  readonly manifestPaths?:
    | {
        readonly specPaths: readonly string[];
        readonly adrPaths: readonly string[];
      }
    | undefined;
  readonly llmClient?: LLMClient | undefined;
  readonly llmApiKey?: string | undefined;
  readonly model: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly agentEngine?: AgentEngine | undefined;
} & LlmRequestTuning): Promise<IntegratePlanBranchIntoFeatureResult> {
  const baseBranch = params.baseBranch ?? "dev";
  const featureInitialSha = await params.gh.ensureBranch(
    params.featureBranch,
    baseBranch
  );

  let closedLegacyPlanPrNumber: number | undefined;
  if (
    params.planBranch.startsWith("plan/") &&
    params.gh.findOpenPullRequestByHead
  ) {
    const legacyPlanPr = await params.gh.findOpenPullRequestByHead(
      params.planBranch,
      baseBranch
    );
    if (legacyPlanPr) {
      try {
        await params.gh.updatePullRequest(legacyPlanPr.number, {
          state: "closed"
        });
        closedLegacyPlanPrNumber = legacyPlanPr.number;
      } catch {
        // Non-fatal in mock tests
      }
    }
  }

  if (!params.planBranch.startsWith("plan/")) {
    return {
      featureHeadSha: featureInitialSha,
      committedPaths: [],
      renumberedAdrs: [],
      ...(closedLegacyPlanPrNumber !== undefined
        ? { closedLegacyPlanPrNumber }
        : {})
    };
  }

  const manifestSpecPaths = new Set(
    (params.manifestPaths?.specPaths ?? []).map((p) => p.trim().replace(/^\/+/, ""))
  );
  const manifestPaths = [
    ...manifestSpecPaths,
    ...(params.manifestPaths?.adrPaths ?? [])
  ];
  // dev and feature/* get only the non-ADR manifest paths: an unlisted ADR path would count as a number allocated on dev.
  const manifestNonAdrPaths = manifestPaths.filter(
    (p) => !ADR_PATH_REGEX.test(p.trim().replace(/^\/+/, ""))
  );
  const [devPaths, planPaths, featurePaths] = await Promise.all([
    listPlanArtifactPaths(params.gh, baseBranch, manifestNonAdrPaths),
    listPlanArtifactPaths(params.gh, params.planBranch, manifestPaths),
    listPlanArtifactPaths(params.gh, params.featureBranch, manifestNonAdrPaths)
  ]);

  const candidatePlanArtifactPaths = planPaths;

  if (candidatePlanArtifactPaths.length === 0) {
    return {
      featureHeadSha: featureInitialSha,
      committedPaths: [],
      renumberedAdrs: [],
      ...(closedLegacyPlanPrNumber !== undefined
        ? { closedLegacyPlanPrNumber }
        : {})
    };
  }

  const devPathSet = new Set(devPaths.map((p) => p.trim().replace(/^\/+/, "")));
  const featurePathSet = new Set(
    featurePaths.map((p) => p.trim().replace(/^\/+/, ""))
  );
  const adrSlugOf = (path: string) =>
    normalizeAdrSlug(ADR_PATH_REGEX.exec(path)?.[2] ?? "");
  // ADRs only on feature/*, incl. plan ADRs an earlier integration renumbered.
  const featureOnlyAdrPaths = [...featurePathSet].filter(
    (p) => ADR_PATH_REGEX.test(p) && !devPathSet.has(p)
  );
  const featureOnlyAdrPathBySlug = new Map(
    featureOnlyAdrPaths.map((p) => [adrSlugOf(p), p])
  );
  const keptFeatureAdrPaths = new Set<string>();
  const filesToCommit: Array<{ path: string; content: string }> = [];
  const planAdrsToProcess: Array<{ path: string; content: string }> = [];
  const specFilesToProcess: Array<{ path: string; content: string }> = [];

  for (const artifactPath of candidatePlanArtifactPaths) {
    const planContent = await params.gh.readSingleBranchFile(
      params.planBranch,
      artifactPath
    );
    if (planContent === null) {
      continue;
    }
    const devContent = devPathSet.has(artifactPath)
      ? await params.gh.readSingleBranchFile(baseBranch, artifactPath)
      : null;

    if (devContent !== null && devContent === planContent) {
      continue;
    }
    const featureContent = featurePathSet.has(artifactPath)
      ? await params.gh.readSingleBranchFile(params.featureBranch, artifactPath)
      : null;
    if (featureContent === planContent) {
      continue;
    }
    const previouslyIntegrated = params.previousPlanSha
      ? await params.gh.readSingleBranchFile(params.previousPlanSha, artifactPath)
      : null;

    if (artifactPath === "GLOSSARY.md") {
      const planTerms =
        previouslyIntegrated === null
          ? planContent
          : glossaryTermsChangedSince(planContent, previouslyIntegrated);
      const mergedGlossary = mergeGlossaryMarkdownAdditively(
        featureContent ?? devContent ?? "",
        planTerms
      );
      if (planTerms.trim() && mergedGlossary !== featureContent) {
        filesToCommit.push({ path: "GLOSSARY.md", content: mergedGlossary });
      }
    } else if (
      featureContent !== null &&
      featureContent !== devContent &&
      featureContent !== previouslyIntegrated
    ) {
      // Edited on feature/* since dev and the last integrated plan: the feature-side version wins.
      continue;
    } else if (ADR_PATH_REGEX.test(artifactPath)) {
      const renumberedOnFeature = featureOnlyAdrPathBySlug.get(
        adrSlugOf(artifactPath)
      );
      if (
        renumberedOnFeature !== undefined &&
        renumberedOnFeature !== artifactPath &&
        planContent === previouslyIntegrated
      ) {
        // Integrated earlier under its renumbered path and unchanged on plan/* since: the feature/* copy stays,
        // the ADR still goes through renumbering so spec and glossary references follow it.
        keptFeatureAdrPaths.add(renumberedOnFeature);
      }
      planAdrsToProcess.push({ path: artifactPath, content: planContent });
    } else if (
      artifactPath.startsWith("docs/specs/") ||
      manifestSpecPaths.has(artifactPath)
    ) {
      specFilesToProcess.push({ path: artifactPath, content: planContent });
    } else {
      filesToCommit.push({ path: artifactPath, content: planContent });
    }
  }

  // feature/* ADR paths count as allocated, so a changed plan ADR lands on its renumbered path again.
  const renumberedResult = renumberCollidingAdrs({
    devPaths: [...devPaths, ...featureOnlyAdrPaths],
    planAdrs: planAdrsToProcess,
    specFiles: specFilesToProcess,
    glossaryContent: filesToCommit.find((f) => f.path === "GLOSSARY.md")?.content
  });

  if (renumberedResult.glossaryContent !== undefined) {
    const idx = filesToCommit.findIndex((f) => f.path === "GLOSSARY.md");
    if (idx >= 0) {
      filesToCommit[idx] = {
        path: "GLOSSARY.md",
        content: renumberedResult.glossaryContent
      };
    }
  }

  const adrsToWrite = renumberedResult.adrs.filter(
    (a) => !keptFeatureAdrPaths.has(a.path)
  );
  for (const adr of adrsToWrite) {
    filesToCommit.push({ path: adr.path, content: adr.content });
  }
  for (const spec of renumberedResult.specFiles) {
    filesToCommit.push({ path: spec.path, content: spec.content });
  }

  const deletedAdrPaths = [...renumberedResult.deletedAdrPaths];
  const devAdrPaths = devPaths
    .map((p) => p.trim().replace(/^\/+/, ""))
    .filter((p) => ADR_PATH_REGEX.test(p));

  // Semantic cross-ADR LLM reconciliation when collisions/renumbering or concurrent dev ADRs exist (ADR-0032, Q118)
  if (
    adrsToWrite.length > 0 &&
    (adrsToWrite.some((a) => a.renumbered) ||
      renumberedResult.deletedAdrPaths.length > 0 ||
      devAdrPaths.length > 0)
  ) {
    await applyAdrLlmReconciliation({
      gh: params.gh,
      baseBranch,
      devAdrPaths,
      featureAdrs: adrsToWrite,
      specFiles: renumberedResult.specFiles,
      glossaryContent: filesToCommit.find((f) => f.path === "GLOSSARY.md")
        ?.content,
      filesToMutate: filesToCommit,
      deletedAdrPaths,
      llmClient: params.llmClient,
      llmApiKey: params.llmApiKey,
      model: params.model,
      ...pickLlmRequestTuning(params),
      fetchImpl: params.fetchImpl,
      agentEngine: params.agentEngine
    });
  }

  if (filesToCommit.length === 0) {
    return {
      featureHeadSha: featureInitialSha,
      committedPaths: [],
      renumberedAdrs: [],
      ...(closedLegacyPlanPrNumber !== undefined
        ? { closedLegacyPlanPrNumber }
        : {})
    };
  }

  const featureHeadSha = await params.gh.commitFilesToBranch({
    branch: params.featureBranch,
    fromBranch: baseBranch,
    commitMessage: `docs(plan): integrate approved planning artifacts from ${params.planBranch}`,
    files: filesToCommit,
    ...(deletedAdrPaths.length > 0 ? { deletedFiles: deletedAdrPaths } : {})
  });

  return {
    featureHeadSha,
    committedPaths: filesToCommit.map((f) => f.path),
    renumberedAdrs: adrsToWrite
      .filter((a) => a.renumbered)
      .map((a) => ({ oldPath: a.oldPath, newPath: a.path })),
    ...(closedLegacyPlanPrNumber !== undefined
      ? { closedLegacyPlanPrNumber }
      : {})
  };
}

export interface SyncBranchWithBaseInput extends LlmRequestTuning {
  readonly gh: Pick<
    GitHubRestHelper,
    | "mergeBranches"
    | "getDefaultBranchSha"
    | "listDirectoryPaths"
    | "listBranchBlobs"
    | "readSingleBranchFile"
    | "commitFilesToBranch"
    | "compareCommits"
    | "readBranchWorkspaceFiles"
  >;
  readonly targetBranch: string;
  readonly baseBranch: string;
  readonly issueNumber: number;
  readonly llmClient?: LLMClient | undefined;
  readonly llmApiKey?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly model: string;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly escalateToNeedsHuman?: EscalateToNeedsHumanFn | undefined;
  readonly maxConflictingFiles?: number | undefined;
  readonly reviewersDir?: string | undefined;
  readonly agentEngine?: AgentEngine | undefined;
  readonly worktreeDir?: string | undefined;
  readonly maxLlmRequests?: number | undefined;
}

export interface SyncBranchWithBaseResult {
  readonly status: "up_to_date" | "merged" | "resolved" | "escalated";
  readonly headSha: string;
  readonly conflictsResolved: readonly string[];
  readonly escalationReason?:
    | "merge_conflict_unresolved"
    | "merge_conflict_stage1_failed"
    | "sensitive_path_violation"
    | undefined;
  readonly diagnosticExcerpt?: string | undefined;
}

// Any `<<<<<<<`, `|||||||` (diff3 base) or `>>>>>>>` marker line, even without the rest of its block.
// A lone `=======` line is tolerated: it is also a setext heading or a comment banner.
const GIT_CONFLICT_MARKER_LINE_REGEX = /^(?:<{7}|>{7}|\|{7})(?: |$)/m;

function containsGitConflictMarkers(content: string): boolean {
  return GIT_CONFLICT_MARKER_LINE_REGEX.test(content.replace(/\r\n/g, "\n"));
}

interface ThreeWayFileVersions {
  readonly path: string;
  readonly baseContent: string | null;
  readonly oursContent: string | null;
  readonly theirsContent: string | null;
}

interface LocalGitMergeResult {
  readonly autoMergedFiles: Array<{ path: string; content: string }>;
  readonly autoDeletedPaths: string[];
  readonly conflictingFiles: ThreeWayFileVersions[];
}

const LOCAL_GIT_MERGE_TIMEOUT_MS = 60_000;

async function runIsolatedGitThreeWayMerge(params: {
  readonly worktreeDir: string;
  readonly targetBranch: string;
  readonly baseBranch: string;
  readonly files: readonly ThreeWayFileVersions[];
}): Promise<LocalGitMergeResult> {
  if (params.files.length === 0) {
    return { autoMergedFiles: [], autoDeletedPaths: [], conflictingFiles: [] };
  }
  const gitDir = mkdtempSync(join(tmpdir(), "epure-merge-git-"));
  const runGit = (
    args: readonly string[],
    options: { readonly input?: string; readonly allowExitCodes?: readonly number[] } = {}
  ): Promise<{ readonly code: number; readonly stdout: Buffer; readonly stderr: string }> =>
    new Promise((resolvePromise, reject) => {
      const allowCodes = options.allowExitCodes ?? [0];
      const child = spawn(
        "git",
        [
          "-c", "core.hooksPath=/dev/null",
          "-c", "core.fsmonitor=false",
          "-c", "protocol.file.allow=never",
          "-c", "core.autocrlf=false",
          "-c", "core.symlinks=true",
          "-c", "user.name=EPURE",
          "-c", "user.email=epure@local",
          `--git-dir=${gitDir}`,
          `--work-tree=${params.worktreeDir}`,
          ...args
        ],
        {
          cwd: params.worktreeDir,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: gitDir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_ATTR_NOSYSTEM: "1",
            GIT_LITERAL_PATHSPECS: "1"
          },
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      const out: Buffer[] = [];
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Local 3-way git ${args[0] ?? ""} timed out after ${LOCAL_GIT_MERGE_TIMEOUT_MS} ms`));
      }, LOCAL_GIT_MERGE_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      child.stdin.on("error", () => {});
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const exitCode = code ?? 1;
        if (allowCodes.includes(exitCode)) {
          resolvePromise({ code: exitCode, stdout: Buffer.concat(out), stderr });
        } else {
          reject(new Error(`Local 3-way git ${args[0] ?? ""} exited with code ${exitCode}: ${stderr.trim()}`));
        }
      });
      child.stdin.end(options.input ?? "");
    });

  const applySide = async (pick: (f: ThreeWayFileVersions) => string | null): Promise<void> => {
    const presentPaths: string[] = [];
    const absentPaths: string[] = [];
    for (const f of params.files) {
      const content = pick(f);
      const abs = join(params.worktreeDir, f.path);
      if (content !== null) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        presentPaths.push(f.path);
      } else {
        rmSync(abs, { force: true });
        absentPaths.push(f.path);
      }
    }
    if (presentPaths.length > 0) {
      await runGit(["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        input: presentPaths.join("\0")
      });
    }
    if (absentPaths.length > 0) {
      await runGit(
        ["rm", "--force", "--ignore-unmatch", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"],
        { input: absentPaths.join("\0") }
      );
    }
  };

  try {
    await runGit(["init", "--quiet"]);
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "attributes"), "* -filter -diff\n", "utf8");

    await applySide((f) => f.baseContent);
    await runGit(["commit", "--quiet", "--allow-empty", "-m", "base"]);
    const baseCommitSha = (await runGit(["rev-parse", "HEAD"])).stdout.toString("utf8").trim();

    await runGit(["checkout", "--quiet", "-b", "theirs"]);
    await applySide((f) => f.theirsContent);
    await runGit(["commit", "--quiet", "--allow-empty", "-m", "theirs"]);

    await runGit(["checkout", "--quiet", "-B", "ours", baseCommitSha]);
    await applySide((f) => f.oursContent);
    await runGit(["commit", "--quiet", "--allow-empty", "-m", "ours"]);

    await runGit(["merge", "--no-commit", "--no-ff", "theirs"], { allowExitCodes: [0, 1] });

    const unmergedRaw = (await runGit(["ls-files", "-z", "--unmerged"])).stdout.toString("utf8");
    const unmergedPaths = new Set<string>();
    for (const record of unmergedRaw.split("\0")) {
      if (!record) continue;
      const tabIdx = record.indexOf("\t");
      if (tabIdx !== -1) {
        unmergedPaths.add(record.slice(tabIdx + 1));
      }
    }

    const autoMergedFiles: Array<{ path: string; content: string }> = [];
    const autoDeletedPaths: string[] = [];
    const conflictingFiles: ThreeWayFileVersions[] = [];

    for (const f of params.files) {
      const abs = join(params.worktreeDir, f.path);
      if (unmergedPaths.has(f.path)) {
        conflictingFiles.push(f);
        const currentDisk = existsSync(abs) ? readFileSync(abs, "utf8") : "";
        if (!containsGitConflictMarkers(currentDisk)) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(
            abs,
            [
              `<<<<<<< ${params.targetBranch}`,
              (f.oursContent ?? "").replace(/\n$/, ""),
              "=======",
              (f.theirsContent ?? "").replace(/\n$/, ""),
              `>>>>>>> ${params.baseBranch}`,
              ""
            ].join("\n"),
            "utf8"
          );
        }
      } else if (existsSync(abs)) {
        autoMergedFiles.push({
          path: f.path,
          content: readFileSync(abs, "utf8")
        });
      } else {
        autoDeletedPaths.push(f.path);
      }
    }

    return { autoMergedFiles, autoDeletedPaths, conflictingFiles };
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

export interface BaseSyncGuard {
  needsSync(): Promise<boolean>;
  markSynced(): Promise<void>;
}

/**
 * Gates the `dev -> feature/* -> task/*` synchronization chain: an automatic resume skips it
 * unless `baseBranch` moved since the SHA recorded in `last_synced_base_sha`.
 */
export function createBaseSyncGuard(input: {
  readonly gh: Pick<GitHubRestHelper, "getDefaultBranchSha">;
  readonly store: GitRefStateStore;
  readonly issueNumber: number;
  readonly baseBranch: string;
  readonly automaticResume: boolean;
}): BaseSyncGuard {
  let baseSha: string | null = null;
  return {
    needsSync: async () => {
      baseSha = await input.gh.getDefaultBranchSha(input.baseBranch);
      if (!input.automaticResume || baseSha === null) {
        return true;
      }
      const { state } = await input.store.readRef(
        buildIssueStateRefName(input.issueNumber)
      );
      return state?.last_synced_base_sha !== baseSha;
    },
    markSynced: async () => {
      const syncedSha = baseSha;
      if (syncedSha === null) {
        return;
      }
      await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store: input.store,
        mutator: (prev) => ({ ...prev, last_synced_base_sha: syncedSha })
      });
    }
  };
}

/**
 * Synchronizes `targetBranch` with `baseBranch` (`dev -> feature/*` or `feature/* -> task/*`).
 * When GitHub REST `/merges` returns `409 Conflict`:
 * - Escalates immediately if any conflicting path is sensitive or if > 8 code files conflict.
 * - Resolves `GLOSSARY.md` deterministically via additive merge.
 * - Resolves code/doc conflicts in 3-way (`base`, `ours`, `theirs`) via LLM and verifies the merged workspace
 *   in the Stage 1 Sandbox before committing.
 */
export async function syncBranchWithBase(
  input: SyncBranchWithBaseInput
): Promise<SyncBranchWithBaseResult> {
  if (!input.gh.mergeBranches) {
    const sha =
      (await input.gh.getDefaultBranchSha(input.targetBranch)) ?? "";
    return { status: "up_to_date", headSha: sha, conflictsResolved: [] };
  }

  const mergeRes = await input.gh.mergeBranches({
    base: input.targetBranch,
    head: input.baseBranch,
    commitMessage: `chore(sync): merge ${input.baseBranch} into ${input.targetBranch}`
  });

  if (mergeRes.status === "up_to_date" || mergeRes.status === "merged") {
    if (
      mergeRes.status === "merged" &&
      typeof input.gh.listDirectoryPaths === "function" &&
      typeof input.gh.readSingleBranchFile === "function" &&
      (input.targetBranch.startsWith("feature/") ||
        input.targetBranch.startsWith("plan/"))
    ) {
      const [basePathsAfterMerge, targetPathsAfterMerge] = await Promise.all([
        input.gh.listDirectoryPaths(input.baseBranch, "docs/adr"),
        listPlanArtifactPaths(input.gh, input.targetBranch)
      ]);
      const baseAdrSet = new Set(
        basePathsAfterMerge
          .map((p) => p.trim().replace(/^\/+/, ""))
          .filter((p) => ADR_PATH_REGEX.test(p))
      );
      const targetOnlyAdrPaths = targetPathsAfterMerge
        .map((p) => p.trim().replace(/^\/+/, ""))
        .filter((p) => ADR_PATH_REGEX.test(p) && !baseAdrSet.has(p));

      if (baseAdrSet.size > 0 && targetOnlyAdrPaths.length > 0) {
        const planAdrsLoaded: Array<{ path: string; content: string }> = [];
        for (const p of targetOnlyAdrPaths) {
          const c = await input.gh.readSingleBranchFile(input.targetBranch, p);
          if (c !== null) {
            planAdrsLoaded.push({ path: p, content: c });
          }
        }
        const specPathsOnTarget = targetPathsAfterMerge
          .map((p) => p.trim().replace(/^\/+/, ""))
          .filter((p) => /^docs\/specs\/.+\.md$/.test(p));
        const specFilesLoaded: Array<{ path: string; content: string }> = [];
        for (const sp of specPathsOnTarget) {
          const c = await input.gh.readSingleBranchFile(input.targetBranch, sp);
          if (c !== null) {
            specFilesLoaded.push({ path: sp, content: c });
          }
        }
        const glossaryOnTarget = await input.gh.readSingleBranchFile(
          input.targetBranch,
          "GLOSSARY.md"
        );
        const renumberedOnMerge = renumberCollidingAdrs({
          devPaths: basePathsAfterMerge,
          planAdrs: planAdrsLoaded,
          specFiles: specFilesLoaded,
          ...(glossaryOnTarget !== null
            ? { glossaryContent: glossaryOnTarget }
            : {})
        });
        const adrFilesToUpdate: Array<{ path: string; content: string }> = [];
        const adrDeletedPaths = [...renumberedOnMerge.deletedAdrPaths];
        if (
          renumberedOnMerge.adrs.some((a) => a.renumbered) ||
          adrDeletedPaths.length > 0
        ) {
          for (const adr of renumberedOnMerge.adrs) {
            adrFilesToUpdate.push({ path: adr.path, content: adr.content });
          }
          for (const spec of renumberedOnMerge.specFiles) {
            adrFilesToUpdate.push({ path: spec.path, content: spec.content });
          }
          if (renumberedOnMerge.glossaryContent !== undefined) {
            adrFilesToUpdate.push({
              path: "GLOSSARY.md",
              content: renumberedOnMerge.glossaryContent
            });
          }
        }
        await applyAdrLlmReconciliation({
          gh: input.gh,
          baseBranch: input.baseBranch,
          devAdrPaths: Array.from(baseAdrSet),
          featureAdrs: renumberedOnMerge.adrs,
          specFiles: renumberedOnMerge.specFiles,
          glossaryContent:
            renumberedOnMerge.glossaryContent ??
            (glossaryOnTarget ?? undefined),
          filesToMutate: adrFilesToUpdate,
          deletedAdrPaths: adrDeletedPaths,
          llmClient: input.llmClient,
          llmApiKey: input.llmApiKey,
          model: input.model,
          ...pickLlmRequestTuning(input),
          fetchImpl: input.fetchImpl,
          agentEngine:
            input.agentEngine?.name === "pi" ? input.agentEngine : undefined
        });
        if (adrFilesToUpdate.length > 0 || adrDeletedPaths.length > 0) {
          const reconciledSha = await input.gh.commitFilesToBranch({
            branch: input.targetBranch,
            commitMessage: `docs(adr): reconcile concurrent ADRs from ${input.baseBranch} into ${input.targetBranch}`,
            files: adrFilesToUpdate,
            ...(adrDeletedPaths.length > 0
              ? { deletedFiles: adrDeletedPaths }
              : {})
          });
          return {
            status: mergeRes.status,
            headSha: reconciledSha,
            conflictsResolved: []
          };
        }
      }
    }
    return {
      status: mergeRes.status,
      headSha: mergeRes.sha,
      conflictsResolved: []
    };
  }

  // 409 Conflict: classify every path by comparing blob SHAs at the merge base, the base head and the target head.
  const maxConflicts = input.maxConflictingFiles ?? 8;
  const escalateConflict = async (
    diag: string,
    paths: Pick<Escalation, "sensitivePaths" | "traversalPaths"> = {}
  ): Promise<SyncBranchWithBaseResult> => {
    if (input.escalateToNeedsHuman) {
      await input.escalateToNeedsHuman({
        reason: "merge_conflict_unresolved",
        ticketNumber: input.issueNumber,
        branch: input.targetBranch,
        ...paths,
        diagnosticExcerpt: diag
      });
    }
    return {
      status: "escalated",
      headSha: "",
      conflictsResolved: [],
      escalationReason: "merge_conflict_unresolved",
      diagnosticExcerpt: diag
    };
  };
  const [targetHeadSha, baseHeadSha] = await Promise.all([
    input.gh.getDefaultBranchSha(input.targetBranch),
    input.gh.getDefaultBranchSha(input.baseBranch)
  ]);
  if (!targetHeadSha || !baseHeadSha) {
    throw new Error(
      `Cannot resolve the merge conflict: '${input.targetBranch}' or '${input.baseBranch}' no longer exists.`
    );
  }
  const { mergeBaseSha } = await input.gh.compareCommits(
    targetHeadSha,
    baseHeadSha
  );
  let ancestorBlobs: ReadonlyMap<string, GitBlobRef>;
  let baseBlobs: ReadonlyMap<string, GitBlobRef>;
  let targetBlobs: ReadonlyMap<string, GitBlobRef>;
  try {
    [ancestorBlobs, baseBlobs, targetBlobs] = await Promise.all([
      input.gh.listBranchBlobs(mergeBaseSha),
      input.gh.listBranchBlobs(baseHeadSha),
      input.gh.listBranchBlobs(targetHeadSha)
    ]);
  } catch (err) {
    if (err instanceof TruncatedGitTreeError) {
      return await escalateConflict(err.message);
    }
    throw err;
  }
  const candidateFiles: string[] = [];
  const baseOnlyChangedFiles: string[] = [];
  for (const path of new Set([
    ...ancestorBlobs.keys(),
    ...baseBlobs.keys(),
    ...targetBlobs.keys()
  ])) {
    const ancestor = ancestorBlobs.get(path)?.sha;
    const theirs = baseBlobs.get(path)?.sha;
    const ours = targetBlobs.get(path)?.sha;
    if (theirs === ours || ancestor === theirs) {
      continue;
    }
    if (ancestor === ours) {
      baseOnlyChangedFiles.push(path);
    } else {
      candidateFiles.push(path);
    }
  }

  const readPinnedFile = async (sha: string, path: string): Promise<string> => {
    const content = await input.gh.readSingleBranchFile(sha, path);
    if (content === null) {
      throw new Error(`'${path}' exists at ${sha} but could not be read.`);
    }
    return content;
  };
  const readVersion = async (
    blobs: ReadonlyMap<string, GitBlobRef>,
    sha: string,
    path: string
  ): Promise<string> => (blobs.has(path) ? await readPinnedFile(sha, path) : "");

  // Base-only changes are carried unchanged: the base is `dev` (human-reviewed merges) or `feature/*` (EPURE-reviewed
  // ticket merges under the feature rulesets), never content EPURE wrote in this sync. Only files EPURE resolves are guarded.
  const pathGuard = validateWorkspaceFileOperations({
    workDir: process.cwd(),
    files: candidateFiles.map((path) => ({ path })),
    targets: [],
    isTaskBranch: true,
    reviewersDir: input.reviewersDir
  });
  if (!pathGuard.allowed) {
    return await escalateConflict(
      `3-way conflict touched forbidden sensitive or traversal paths: ${[...pathGuard.sensitivePaths, ...pathGuard.traversalPaths].join(", ")}`,
      {
        sensitivePaths: pathGuard.sensitivePaths,
        traversalPaths: pathGuard.traversalPaths
      }
    );
  }

  const bothSidesCodeFiles = candidateFiles.filter((p) => p !== "GLOSSARY.md");
  const hasLlmResolver = Boolean(
    input.agentEngine || input.llmClient || input.llmApiKey
  );

  const resolvedFiles: Array<{ path: string; content: string }> = [];
  const autoMergedFiles: Array<{ path: string; content: string }> = [];
  const baseOnlyBlobs: Array<{ path: string } & GitBlobRef> = [];
  const baseDeletedFiles: string[] = [];

  for (const basePath of baseOnlyChangedFiles) {
    const blob = baseBlobs.get(basePath);
    if (blob) {
      baseOnlyBlobs.push({ path: basePath, ...blob });
    } else {
      baseDeletedFiles.push(basePath);
    }
  }

  if (candidateFiles.includes("GLOSSARY.md")) {
    const [theirsGlossary, oursGlossary] = await Promise.all([
      readVersion(baseBlobs, baseHeadSha, "GLOSSARY.md"),
      readVersion(targetBlobs, targetHeadSha, "GLOSSARY.md")
    ]);
    resolvedFiles.push({
      path: "GLOSSARY.md",
      content: mergeGlossaryMarkdownAdditively(theirsGlossary, oursGlossary)
    });
  }

  if (bothSidesCodeFiles.length > 0) {
    const readOptionalVersion = async (
      blobs: ReadonlyMap<string, GitBlobRef>,
      sha: string,
      path: string
    ): Promise<string | null> =>
      blobs.has(path) ? await readPinnedFile(sha, path) : null;

    const threeWayFiles: ThreeWayFileVersions[] = [];
    for (const filePath of bothSidesCodeFiles) {
      const [baseContent, oursContent, theirsContent] = await Promise.all([
        readOptionalVersion(ancestorBlobs, mergeBaseSha, filePath),
        readOptionalVersion(targetBlobs, targetHeadSha, filePath),
        readOptionalVersion(baseBlobs, baseHeadSha, filePath)
      ]);
      threeWayFiles.push({
        path: filePath,
        baseContent,
        oursContent,
        theirsContent
      });
    }

    const tempWorktreeDir = input.worktreeDir
      ? undefined
      : mkdtempSync(join(tmpdir(), "epure-merge-worktree-"));
    const worktreeDir = input.worktreeDir ?? tempWorktreeDir!;

    try {
      const localMerge = await runIsolatedGitThreeWayMerge({
        worktreeDir,
        targetBranch: input.targetBranch,
        baseBranch: input.baseBranch,
        files: threeWayFiles
      });

      for (const merged of localMerge.autoMergedFiles) {
        autoMergedFiles.push(merged);
      }
      for (const deleted of localMerge.autoDeletedPaths) {
        if (!baseDeletedFiles.includes(deleted)) {
          baseDeletedFiles.push(deleted);
        }
      }

      const conflictingFiles = localMerge.conflictingFiles;
      const codeConflictPaths = conflictingFiles.map((f) => f.path);

      if (
        codeConflictPaths.length > maxConflicts ||
        (codeConflictPaths.length > 0 && !hasLlmResolver)
      ) {
        return await escalateConflict(
          codeConflictPaths.length > maxConflicts
            ? `3-way merge conflict involves ${codeConflictPaths.length} files (exceeds automated limit of ${maxConflicts}).`
            : `3-way merge conflict on ${codeConflictPaths.join(", ")} requires LLM client for resolution.`
        );
      }

      if (codeConflictPaths.length > 0 && input.agentEngine) {
        const expectedPathsSet = new Set(
          codeConflictPaths.map((p) => p.trim().replace(/^\/+/, ""))
        );
        const outerSnapshot = await snapshotWorktree(worktreeDir, {
          trackedPaths: bothSidesCodeFiles,
          isProtectedPath: (path) =>
            isSensitiveTaskBranchPath(path, input.reviewersDir)
        });
        let sessionResult: Awaited<ReturnType<AgentEngine["run"]>>;
        let outerDiff: Awaited<ReturnType<typeof outerSnapshot.collect>>;
        try {
          sessionResult = await input.agentEngine.run({
            role: "conflict_resolver",
            toolPolicy: "write",
            instructions: [
              "Tu es un ingénieur expert chargé de résoudre un conflit de fusion Git à 3 voies (3-way merge) directement dans le répertoire de travail.",
              PROMPT_INJECTION_IMMUNITY_CLAUSE,
              "Les fichiers en conflit contiennent des marqueurs Git (`<<<<<<<`, `=======`, `>>>>>>>`). Édite chaque fichier en conflit sur place pour produire une version fusionnée propre, sans aucun marqueur de conflit, préservant les évolutions des deux branches.",
              `Ne modifie JAMAIS ${(input.reviewersDir ?? DEFAULT_REVIEWERS_DIR).replace(/\/+$/, "")}/**, .github/workflows/**, .github/agents.yml, .env* ni .git/.`,
              EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT
            ].join("\n\n"),
            prompt: [
              `Résous les conflits de fusion 3-way lors de la synchronisation de \`${input.baseBranch}\` vers \`${input.targetBranch}\`.`,
              `Fichiers contenant des hunks en conflit : ${codeConflictPaths.map((p) => `\`${p}\``).join(", ")}.`
            ].join("\n"),
            worktree: worktreeDir,
            timeoutMs: input.requestTimeoutMs ?? 30 * 60 * 1000,
            model: input.model,
            providers: input.providers,
            trackedPaths: bothSidesCodeFiles,
            isProtectedPath: (path) =>
              isSensitiveTaskBranchPath(path, input.reviewersDir),
            maxLlmRequests: input.maxLlmRequests,
            secrets: [
              input.llmApiKey ?? "",
              ...collectRunnerSecretValues(process.env)
            ].filter(Boolean)
          });
          outerDiff = await outerSnapshot.collect();
        } finally {
          outerSnapshot.dispose();
        }

        const protectedSkipped = [
          ...sessionResult.diff.skipped,
          ...outerDiff.skipped
        ]
          .filter((s) => s.reason === "protected")
          .map((s) => s.path.trim().replace(/^\/+/, ""));
        if (protectedSkipped.length > 0) {
          const uniqueProtected = Array.from(new Set(protectedSkipped));
          return await escalateConflict(
            `LLM conflict resolution returned forbidden paths: ${uniqueProtected.join(", ")}`,
            {
              sensitivePaths: uniqueProtected,
              traversalPaths: []
            }
          );
        }

        const effectiveDiffFileMap = new Map<string, string>();
        for (const f of outerDiff.files) {
          effectiveDiffFileMap.set(f.path.trim().replace(/^\/+/, ""), f.content);
        }
        for (const f of sessionResult.diff.files) {
          effectiveDiffFileMap.set(f.path.trim().replace(/^\/+/, ""), f.content);
        }
        const effectiveDeletedPaths = Array.from(
          new Set([
            ...outerDiff.deleted_files.map((p) => p.trim().replace(/^\/+/, "")),
            ...sessionResult.diff.deleted_files.map((p) =>
              p.trim().replace(/^\/+/, "")
            )
          ])
        );
        const allTouchedPaths = Array.from(
          new Set([...effectiveDiffFileMap.keys(), ...effectiveDeletedPaths])
        );

        if (allTouchedPaths.length > 0) {
          const resolvedPathGuard = validateWorkspaceFileOperations({
            workDir: process.cwd(),
            files: allTouchedPaths.map((path) => ({ path })),
            targets: [],
            isTaskBranch: true,
            reviewersDir: input.reviewersDir
          });
          if (!resolvedPathGuard.allowed) {
            return await escalateConflict(
              `LLM conflict resolution returned forbidden paths: ${[...resolvedPathGuard.sensitivePaths, ...resolvedPathGuard.traversalPaths].join(", ")}`,
              {
                sensitivePaths: resolvedPathGuard.sensitivePaths,
                traversalPaths: resolvedPathGuard.traversalPaths
              }
            );
          }
          const outOfScope = allTouchedPaths.filter(
            (p) => !expectedPathsSet.has(p)
          );
          if (outOfScope.length > 0) {
            return await escalateConflict(
              `LLM conflict resolution path mismatch: expected [${Array.from(expectedPathsSet).join(", ")}], received [${allTouchedPaths.join(", ")}].`
            );
          }
        }

        for (const conflictPath of codeConflictPaths) {
          const normalizedPath = conflictPath.trim().replace(/^\/+/, "");
          const diskPath = join(worktreeDir, normalizedPath);
          const resolvedContent =
            effectiveDiffFileMap.get(normalizedPath) ??
            (existsSync(diskPath) ? readFileSync(diskPath, "utf8") : null);
          if (resolvedContent === null) {
            return await escalateConflict(
              `LLM conflict resolution path mismatch: expected [${Array.from(expectedPathsSet).join(", ")}], received [${allTouchedPaths.join(", ")}].`
            );
          }
          if (containsGitConflictMarkers(resolvedContent)) {
            return await escalateConflict(
              `LLM conflict resolution for '${normalizedPath}' still contained Git conflict markers.`
            );
          }
          resolvedFiles.push({
            path: normalizedPath,
            content: resolvedContent
          });
        }

        assertNoSecretMaterial(
          resolvedFiles.map((f) => ({ label: f.path, text: f.content })),
          [
            input.llmApiKey ?? "",
            ...collectRunnerSecretValues(process.env)
          ].filter(Boolean)
        );
      } else if (codeConflictPaths.length > 0 && hasLlmResolver) {
        const fileTriplets: string[] = [];
        for (const f of conflictingFiles) {
          fileTriplets.push(
            [
              `### File: \`${f.path}\` (untruncated 3-way versions)`,
              "#### `<base_version>` (common ancestor):",
              wrapUntrustedContent(
                "untrusted_workspace_files",
                f.baseContent ?? ""
              ),
              `#### \`<ours_target_branch>\` (\`${input.targetBranch}\`):`,
              wrapUntrustedContent(
                "untrusted_workspace_files",
                f.oursContent ?? ""
              ),
              `#### \`<theirs_base_branch>\` (\`${input.baseBranch}\`):`,
              wrapUntrustedContent(
                "untrusted_workspace_files",
                f.theirsContent ?? ""
              )
            ].join("\n")
          );
        }

        const systemInstruction = [
          "Tu es un ingénieur expert chargé de résoudre un conflit de fusion Git à 3 voies (3-way merge).",
          "Produis pour chaque fichier en conflit une version fusionnée propre, sans aucun marqueur de conflit (`<<<<<<<`, `=======`, `>>>>>>>`), préservant à la fois les évolutions de `<theirs_base_branch>` et celles de `<ours_target_branch>`.",
          EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT
        ].join("\n\n");
        const userPrompt = [
          `Résous les conflits 3-way suivants lors de la synchronisation de \`${input.baseBranch}\` vers \`${input.targetBranch}\` :`,
          "",
          fileTriplets.join("\n\n")
        ].join("\n");

        let resolutionData: ConflictResolutionPayload;
        if (input.llmClient) {
          resolutionData = await input.llmClient.completeStructured({
            model: input.model,
            ...pickLlmRequestTuning(input),
            systemInstruction,
            userPrompt,
            responseSchema: CONFLICT_RESOLUTION_SCHEMA,
            temperature: 0.1
          });
        } else {
          resolutionData = await callLlmJson<ConflictResolutionPayload>({
            apiKey: input.llmApiKey ?? "",
            model: input.model,
            ...pickLlmRequestTuning(input),
            systemInstruction,
            prompt: userPrompt,
            temperature: 0.1,
            responseSchema: CONFLICT_RESOLUTION_SCHEMA,
            fetchImpl: input.fetchImpl
          });
        }

        const expectedPathsSet = new Set(
          codeConflictPaths.map((p) => p.trim().replace(/^\/+/, ""))
        );
        const returnedNormalizedPaths = resolutionData.resolved_files.map(
          (rf) => rf.path.trim().replace(/^\/+/, "")
        );
        const returnedPathsSet = new Set(returnedNormalizedPaths);
        const hasExact1To1Coverage =
          returnedNormalizedPaths.length === expectedPathsSet.size &&
          returnedPathsSet.size === expectedPathsSet.size &&
          Array.from(expectedPathsSet).every((p) => returnedPathsSet.has(p));

        if (!hasExact1To1Coverage) {
          return await escalateConflict(
            `LLM conflict resolution path mismatch: expected [${Array.from(expectedPathsSet).join(", ")}], received [${returnedNormalizedPaths.join(", ")}].`
          );
        }

        const resolvedPathGuard = validateWorkspaceFileOperations({
          workDir: process.cwd(),
          files: returnedNormalizedPaths.map((path) => ({ path })),
          targets: [],
          isTaskBranch: true,
          reviewersDir: input.reviewersDir
        });
        if (!resolvedPathGuard.allowed) {
          return await escalateConflict(
            `LLM conflict resolution returned forbidden paths: ${[...resolvedPathGuard.sensitivePaths, ...resolvedPathGuard.traversalPaths].join(", ")}`,
            {
              sensitivePaths: resolvedPathGuard.sensitivePaths,
              traversalPaths: resolvedPathGuard.traversalPaths
            }
          );
        }

        for (const rf of resolutionData.resolved_files) {
          if (containsGitConflictMarkers(rf.content)) {
            return await escalateConflict(
              `LLM conflict resolution for '${rf.path}' still contained Git conflict markers.`
            );
          }
          resolvedFiles.push({
            path: rf.path.trim().replace(/^\/+/, ""),
            content: rf.content
          });
        }
      }
    } finally {
      if (tempWorktreeDir) {
        rmSync(tempWorktreeDir, { recursive: true, force: true });
      }
    }
  }

  const filesToCommit = [...autoMergedFiles, ...resolvedFiles];

  // Stage 1 Sandbox verification before committing resolved conflicts
  if (input.sandboxRunner && filesToCommit.length + baseOnlyBlobs.length > 0) {
    const baseOnlyFiles = await Promise.all(
      baseOnlyBlobs.map(async (b) => ({
        path: b.path,
        content: await readPinnedFile(baseHeadSha, b.path)
      }))
    );
    const allFilesToCommit = [...baseOnlyFiles, ...filesToCommit];
    const workspaceFiles = await input.gh.readBranchWorkspaceFiles(
      input.targetBranch,
      allFilesToCommit.map((f) => f.path).join(" "),
      [],
      input.reviewersDir
    );
    for (const deletedPath of baseDeletedFiles) {
      workspaceFiles.delete(deletedPath);
    }
    for (const rf of allFilesToCommit) {
      workspaceFiles.set(rf.path, rf.content);
    }
    const stage1Result = await runTestsInIsolatedWorkspace({
      files: Array.from(workspaceFiles.entries()).map(([path, content]) => ({
        path,
        content
      })),
      changedPaths: allFilesToCommit.map((f) => f.path),
      isTaskBranch: true,
      reviewersDir: input.reviewersDir,
      sandboxRunner: input.sandboxRunner,
      llmApiKey: input.llmApiKey ?? "",
      label: `3-way conflict resolution (${input.baseBranch} -> ${input.targetBranch})`
    });

    if (!stage1Result.passed) {
      const diag = `Stage 1 Sandbox verification failed on 3-way conflict resolution:\n${stage1Result.output.slice(0, 4000)}`;
      if (input.escalateToNeedsHuman) {
        await input.escalateToNeedsHuman({
          reason: "merge_conflict_stage1_failed",
          ticketNumber: input.issueNumber,
          branch: input.targetBranch,
          diagnosticExcerpt: diag
        });
      }
      return {
        status: "escalated",
        headSha: "",
        conflictsResolved: [],
        escalationReason: "merge_conflict_stage1_failed",
        diagnosticExcerpt: diag
      };
    }
  }

  const headSha = await input.gh.commitFilesToBranch({
    branch: input.targetBranch,
    commitMessage:
      resolvedFiles.length > 0
        ? `chore(sync): resolve merge conflicts from ${input.baseBranch} into ${input.targetBranch}`
        : `chore(sync): merge ${input.baseBranch} into ${input.targetBranch}`,
    files: filesToCommit,
    blobs: baseOnlyBlobs,
    ...(baseDeletedFiles.length > 0 ? { deletedFiles: baseDeletedFiles } : {}),
    // Without the base as second parent the merge base never moves: the PR stays `dirty` and GitHub runs no `pull_request` CI.
    mergeParentSha: baseHeadSha
  });

  return {
    status: resolvedFiles.length > 0 ? "resolved" : "merged",
    headSha,
    conflictsResolved: resolvedFiles.map((f) => f.path)
  };
}
