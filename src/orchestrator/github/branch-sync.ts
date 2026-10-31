import type { LLMClient } from "../../llm/client.js";
import type {
  SandboxExecutionInput,
  SandboxExecutionResult
} from "../../sandbox/llm-sandbox.js";
import { validateWorkspaceFileOperations } from "../../sandbox/polyglot-workspace-runner.js";
import { wrapUntrustedContent } from "../../security/prompt-injection-guard.js";
import { callGeminiJson } from "../gemini-client.js";
import { EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT } from "../prompts/code-discipline.js";
import {
  ADR_COHERENCE_RECONCILIATION_SCHEMA,
  CONFLICT_RESOLUTION_SCHEMA,
  type AdrCoherenceReconciliationPayload,
  type ConflictResolutionPayload
} from "../prompts/schemas.js";
import type { EscalateToNeedsHumanFn, GitHubRestHelper } from "../types.js";
import { runTestsInIsolatedWorkspace } from "../workspace/repo-tools.js";

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

export interface ReconcileAdrsWithLlmInput {
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
  readonly model?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export async function reconcileAdrsWithLlm(
  input: ReconcileAdrsWithLlmInput
): Promise<AdrCoherenceReconciliationPayload | null> {
  if (!input.llmClient && !input.llmApiKey) {
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
    if (input.llmClient) {
      return await input.llmClient.completeStructured({
        model: input.model ?? "gemini-3.8-flash",
        systemInstruction,
        userPrompt,
        responseSchema: ADR_COHERENCE_RECONCILIATION_SCHEMA,
        temperature: 0.1
      });
    }
    return await callGeminiJson<AdrCoherenceReconciliationPayload>({
      apiKey: input.llmApiKey ?? "",
      model: input.model ?? "gemini-3.8-flash",
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
  readonly model?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<void> {
  if (!params.llmClient && !params.llmApiKey) {
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
    fetchImpl: params.fetchImpl
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
 * - Additively merges `GLOSSARY.md` against `dev`.
 * - Automatically renumbers colliding `docs/adr/NNNN-*.md` files against `dev`.
 */
export async function integratePlanBranchIntoFeature(params: {
  readonly gh: GitHubRestHelper;
  readonly planBranch: string;
  readonly featureBranch: string;
  readonly baseBranch?: string | undefined;
  readonly llmClient?: LLMClient | undefined;
  readonly llmApiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<IntegratePlanBranchIntoFeatureResult> {
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

  const [devPaths, planPaths] = await Promise.all([
    params.gh.listBranchPaths(baseBranch),
    params.gh.listBranchPaths(params.planBranch)
  ]);

  const candidatePlanArtifactPaths = planPaths
    .map((p) => p.trim().replace(/^\/+/, ""))
    .filter((p) => p === "GLOSSARY.md" || p.startsWith("docs/"));

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

    if (artifactPath === "GLOSSARY.md") {
      const mergedGlossary = mergeGlossaryMarkdownAdditively(
        devContent ?? "",
        planContent
      );
      filesToCommit.push({ path: "GLOSSARY.md", content: mergedGlossary });
    } else if (ADR_PATH_REGEX.test(artifactPath)) {
      planAdrsToProcess.push({ path: artifactPath, content: planContent });
    } else if (artifactPath.startsWith("docs/specs/")) {
      specFilesToProcess.push({ path: artifactPath, content: planContent });
    } else {
      filesToCommit.push({ path: artifactPath, content: planContent });
    }
  }

  const renumberedResult = renumberCollidingAdrs({
    devPaths,
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

  for (const adr of renumberedResult.adrs) {
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
    renumberedResult.adrs.length > 0 &&
    (renumberedResult.adrs.some((a) => a.renumbered) ||
      renumberedResult.deletedAdrPaths.length > 0 ||
      devAdrPaths.length > 0)
  ) {
    await applyAdrLlmReconciliation({
      gh: params.gh,
      baseBranch,
      devAdrPaths,
      featureAdrs: renumberedResult.adrs,
      specFiles: renumberedResult.specFiles,
      glossaryContent: filesToCommit.find((f) => f.path === "GLOSSARY.md")
        ?.content,
      filesToMutate: filesToCommit,
      deletedAdrPaths,
      llmClient: params.llmClient,
      llmApiKey: params.llmApiKey,
      model: params.model,
      fetchImpl: params.fetchImpl
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
    renumberedAdrs: renumberedResult.adrs
      .filter((a) => a.renumbered)
      .map((a) => ({ oldPath: a.oldPath, newPath: a.path })),
    ...(closedLegacyPlanPrNumber !== undefined
      ? { closedLegacyPlanPrNumber }
      : {})
  };
}

export interface SyncBranchWithBaseInput {
  readonly gh: Pick<
    GitHubRestHelper,
    | "mergeBranches"
    | "getDefaultBranchSha"
    | "listBranchPaths"
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
  readonly model?: string | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly escalateToNeedsHuman?: EscalateToNeedsHumanFn | undefined;
  readonly maxConflictingFiles?: number | undefined;
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
      typeof input.gh.listBranchPaths === "function" &&
      typeof input.gh.readSingleBranchFile === "function" &&
      (input.targetBranch.startsWith("feature/") ||
        input.targetBranch.startsWith("plan/"))
    ) {
      const [basePathsAfterMerge, targetPathsAfterMerge] = await Promise.all([
        input.gh.listBranchPaths(input.baseBranch),
        input.gh.listBranchPaths(input.targetBranch)
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
          fetchImpl: input.fetchImpl
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

  // 409 Conflict: identify conflicting files between baseBranch (theirs) and targetBranch (ours)
  const maxConflicts = input.maxConflictingFiles ?? 8;
  let mergeBaseSha = input.baseBranch;
  let candidateFiles: string[] = [];
  let baseOnlyChangedFiles: string[] = [];

  if (input.gh.compareCommits) {
    const [baseToTarget, targetToBase] = await Promise.all([
      input.gh.compareCommits(input.baseBranch, input.targetBranch),
      input.gh.compareCommits(input.targetBranch, input.baseBranch)
    ]);
    mergeBaseSha = baseToTarget.mergeBaseSha || input.baseBranch;
    const targetChanged = new Set(baseToTarget.changedFiles);
    const bothChanged = targetToBase.changedFiles.filter((f) =>
      targetChanged.has(f)
    );
    if (bothChanged.length > 0) {
      candidateFiles = bothChanged;
      baseOnlyChangedFiles = targetToBase.changedFiles.filter(
        (f) => !targetChanged.has(f)
      );
    } else {
      candidateFiles = [
        ...new Set([
          ...baseToTarget.changedFiles,
          ...targetToBase.changedFiles
        ])
      ];
    }
  }

  if (candidateFiles.length === 0) {
    const [basePaths, targetPaths] = await Promise.all([
      input.gh.listBranchPaths(input.baseBranch),
      input.gh.listBranchPaths(input.targetBranch)
    ]);
    const commonPaths = targetPaths.filter((p) => basePaths.includes(p));
    for (const p of commonPaths) {
      const [oursContent, theirsContent] = await Promise.all([
        input.gh.readSingleBranchFile(input.targetBranch, p),
        input.gh.readSingleBranchFile(input.baseBranch, p)
      ]);
      if (oursContent !== theirsContent) {
        candidateFiles.push(p);
      }
    }
  }

  const pathGuard = validateWorkspaceFileOperations({
    workDir: process.cwd(),
    files: [...candidateFiles, ...baseOnlyChangedFiles].map((path) => ({
      path
    })),
    targets: [],
    isTaskBranch: true
  });
  if (!pathGuard.allowed) {
    const diag = `3-way conflict touched forbidden sensitive or traversal paths: ${[...pathGuard.sensitivePaths, ...pathGuard.traversalPaths].join(", ")}`;
    if (input.escalateToNeedsHuman) {
      await input.escalateToNeedsHuman({
        reason: "merge_conflict_unresolved",
        ticketNumber: input.issueNumber,
        branch: input.targetBranch,
        sensitivePaths: pathGuard.sensitivePaths,
        traversalPaths: pathGuard.traversalPaths,
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
  }

  const codeConflictPaths = candidateFiles.filter((p) => p !== "GLOSSARY.md");
  const hasLlmResolver = Boolean(input.llmClient || input.llmApiKey);
  if (
    codeConflictPaths.length > maxConflicts ||
    (codeConflictPaths.length > 0 && !hasLlmResolver)
  ) {
    const diag =
      codeConflictPaths.length > maxConflicts
        ? `3-way merge conflict involves ${codeConflictPaths.length} files (exceeds automated limit of ${maxConflicts}).`
        : `3-way merge conflict on ${codeConflictPaths.join(", ")} requires LLM client for resolution.`;
    if (input.escalateToNeedsHuman) {
      await input.escalateToNeedsHuman({
        reason: "merge_conflict_unresolved",
        ticketNumber: input.issueNumber,
        branch: input.targetBranch,
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
  }

  const resolvedFiles: Array<{ path: string; content: string }> = [];
  const baseNonConflictingFiles: Array<{ path: string; content: string }> = [];
  const baseDeletedFiles: string[] = [];

  for (const basePath of baseOnlyChangedFiles) {
    const baseFileContent = await input.gh.readSingleBranchFile(
      input.baseBranch,
      basePath
    );
    if (baseFileContent !== null) {
      baseNonConflictingFiles.push({ path: basePath, content: baseFileContent });
    } else {
      baseDeletedFiles.push(basePath);
    }
  }

  if (candidateFiles.includes("GLOSSARY.md")) {
    const [theirsGlossary, oursGlossary] = await Promise.all([
      input.gh.readSingleBranchFile(input.baseBranch, "GLOSSARY.md"),
      input.gh.readSingleBranchFile(input.targetBranch, "GLOSSARY.md")
    ]);
    resolvedFiles.push({
      path: "GLOSSARY.md",
      content: mergeGlossaryMarkdownAdditively(
        theirsGlossary ?? "",
        oursGlossary ?? ""
      )
    });
  }

  if (codeConflictPaths.length > 0 && hasLlmResolver) {
    const fileTriplets: string[] = [];
    for (const filePath of codeConflictPaths) {
      const [baseContent, oursContent, theirsContent] = await Promise.all([
        input.gh.readSingleBranchFile(mergeBaseSha, filePath),
        input.gh.readSingleBranchFile(input.targetBranch, filePath),
        input.gh.readSingleBranchFile(input.baseBranch, filePath)
      ]);
      fileTriplets.push(
        [
          `### File: \`${filePath}\` (untruncated 3-way versions)`,
          "#### `<base_version>` (common ancestor):",
          wrapUntrustedContent(
            "untrusted_workspace_files",
            baseContent ?? ""
          ),
          `#### \`<ours_target_branch>\` (\`${input.targetBranch}\`):`,
          wrapUntrustedContent(
            "untrusted_workspace_files",
            oursContent ?? ""
          ),
          `#### \`<theirs_base_branch>\` (\`${input.baseBranch}\`):`,
          wrapUntrustedContent(
            "untrusted_workspace_files",
            theirsContent ?? ""
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
        model: input.model ?? "gemini-3.8-flash",
        systemInstruction,
        userPrompt,
        responseSchema: CONFLICT_RESOLUTION_SCHEMA,
        temperature: 0.1
      });
    } else {
      resolutionData = await callGeminiJson<ConflictResolutionPayload>({
        apiKey: input.llmApiKey ?? "",
        model: input.model ?? "gemini-3.8-flash",
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
    const returnedNormalizedPaths = resolutionData.resolved_files.map((rf) =>
      rf.path.trim().replace(/^\/+/, "")
    );
    const returnedPathsSet = new Set(returnedNormalizedPaths);
    const hasExact1To1Coverage =
      returnedNormalizedPaths.length === expectedPathsSet.size &&
      returnedPathsSet.size === expectedPathsSet.size &&
      Array.from(expectedPathsSet).every((p) => returnedPathsSet.has(p));

    if (!hasExact1To1Coverage) {
      const diag = `LLM conflict resolution path mismatch: expected [${Array.from(expectedPathsSet).join(", ")}], received [${returnedNormalizedPaths.join(", ")}].`;
      if (input.escalateToNeedsHuman) {
        await input.escalateToNeedsHuman({
          reason: "merge_conflict_unresolved",
          ticketNumber: input.issueNumber,
          branch: input.targetBranch,
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
    }

    const resolvedPathGuard = validateWorkspaceFileOperations({
      workDir: process.cwd(),
      files: returnedNormalizedPaths.map((path) => ({ path })),
      targets: [],
      isTaskBranch: true
    });
    if (!resolvedPathGuard.allowed) {
      const diag = `LLM conflict resolution returned forbidden paths: ${[...resolvedPathGuard.sensitivePaths, ...resolvedPathGuard.traversalPaths].join(", ")}`;
      if (input.escalateToNeedsHuman) {
        await input.escalateToNeedsHuman({
          reason: "merge_conflict_unresolved",
          ticketNumber: input.issueNumber,
          branch: input.targetBranch,
          sensitivePaths: resolvedPathGuard.sensitivePaths,
          traversalPaths: resolvedPathGuard.traversalPaths,
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
    }

    for (const rf of resolutionData.resolved_files) {
      if (
        rf.content.includes("<<<<<<<") ||
        rf.content.includes("=======") ||
        rf.content.includes(">>>>>>>")
      ) {
        const diag = `LLM conflict resolution for '${rf.path}' still contained Git conflict markers.`;
        if (input.escalateToNeedsHuman) {
          await input.escalateToNeedsHuman({
            reason: "merge_conflict_unresolved",
            ticketNumber: input.issueNumber,
            branch: input.targetBranch,
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
      }
      resolvedFiles.push({
        path: rf.path.trim().replace(/^\/+/, ""),
        content: rf.content
      });
    }
  }

  const allFilesToCommit = [...baseNonConflictingFiles, ...resolvedFiles];

  // Stage 1 Sandbox verification before committing resolved conflicts
  if (input.sandboxRunner && allFilesToCommit.length > 0) {
    const workspaceFiles = await input.gh.readBranchWorkspaceFiles(
      input.targetBranch,
      allFilesToCommit.map((f) => f.path).join(" ")
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
    commitMessage: `chore(sync): resolve merge conflicts from ${input.baseBranch} into ${input.targetBranch}`,
    files: allFilesToCommit,
    ...(baseDeletedFiles.length > 0 ? { deletedFiles: baseDeletedFiles } : {})
  });

  return {
    status: "resolved",
    headSha,
    conflictsResolved: resolvedFiles.map((f) => f.path)
  };
}
