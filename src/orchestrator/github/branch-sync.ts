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
  CONFLICT_RESOLUTION_SCHEMA,
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
  readonly deletedAdrPaths: readonly string[];
}

const ADR_PATH_REGEX = /^docs\/adr\/(\d{4})-(.+)\.md$/;

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
 * Automatically resolves ADR number collisions when `dev` has already allocated `docs/adr/NNNN-*.md`
 * for another concurrent issue, renumbering colliding `plan/*` ADRs above `max(dev, plan)` and updating
 * references in both the ADR content and `docs/specs/*.md` in a single atomic pass.
 */
export function renumberCollidingAdrs(
  input: RenumberCollidingAdrsInput
): RenumberCollidingAdrsResult {
  const devAdrsByNumber = new Map<number, string>();
  let maxAdrNumber = 0;

  for (const rawPath of input.devPaths) {
    const cleanPath = rawPath.trim().replace(/^\/+/, "");
    const match = ADR_PATH_REGEX.exec(cleanPath);
    if (match && match[1]) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num)) {
        devAdrsByNumber.set(num, cleanPath);
        if (num > maxAdrNumber) {
          maxAdrNumber = num;
        }
      }
    }
  }

  for (const adr of input.planAdrs) {
    const cleanPath = adr.path.trim().replace(/^\/+/, "");
    const match = ADR_PATH_REGEX.exec(cleanPath);
    if (match && match[1]) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxAdrNumber) {
        maxAdrNumber = num;
      }
    }
  }

  const renumberMap = new Map<
    string,
    { oldNumStr: string; newNumStr: string; oldFileName: string; newFileName: string }
  >();
  const resultingAdrs: Array<{
    readonly path: string;
    readonly content: string;
    readonly oldPath: string;
    readonly renumbered: boolean;
  }> = [];
  const deletedAdrPaths: string[] = [];

  for (const adr of input.planAdrs) {
    const cleanPath = adr.path.trim().replace(/^\/+/, "");
    const match = ADR_PATH_REGEX.exec(cleanPath);
    if (!match || !match[1] || !match[2]) {
      resultingAdrs.push({
        path: cleanPath,
        content: adr.content,
        oldPath: cleanPath,
        renumbered: false
      });
      continue;
    }

    const oldNum = Number.parseInt(match[1], 10);
    const slug = match[2];
    const existingDevPath = devAdrsByNumber.get(oldNum);

    if (existingDevPath && existingDevPath !== cleanPath) {
      maxAdrNumber = Math.max(maxAdrNumber, oldNum) + 1;
      const oldNumStr = match[1];
      const newNumStr = String(maxAdrNumber).padStart(4, "0");
      const oldFileName = `${oldNumStr}-${slug}.md`;
      const newFileName = `${newNumStr}-${slug}.md`;
      const newPath = `docs/adr/${newFileName}`;
      devAdrsByNumber.set(maxAdrNumber, newPath);

      const singleReplacement = {
        oldNumStr,
        newNumStr,
        oldFileName,
        newFileName
      };
      renumberMap.set(cleanPath, singleReplacement);
      deletedAdrPaths.push(cleanPath);

      const updatedContent = replaceAdrReferencesSinglePass(adr.content, [
        singleReplacement
      ]);

      resultingAdrs.push({
        path: newPath,
        content: updatedContent,
        oldPath: cleanPath,
        renumbered: true
      });
    } else {
      if (oldNum > maxAdrNumber) {
        maxAdrNumber = oldNum;
      }
      devAdrsByNumber.set(oldNum, cleanPath);
      resultingAdrs.push({
        path: cleanPath,
        content: adr.content,
        oldPath: cleanPath,
        renumbered: false
      });
    }
  }

  const allReplacements = Array.from(renumberMap.values());
  const updatedSpecFiles = (input.specFiles ?? []).map((spec) => ({
    path: spec.path.trim().replace(/^\/+/, ""),
    content: replaceAdrReferencesSinglePass(spec.content, allReplacements)
  }));

  return {
    adrs: resultingAdrs,
    specFiles: updatedSpecFiles,
    deletedAdrPaths
  };
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
    specFiles: specFilesToProcess
  });

  for (const adr of renumberedResult.adrs) {
    filesToCommit.push({ path: adr.path, content: adr.content });
  }
  for (const spec of renumberedResult.specFiles) {
    filesToCommit.push({ path: spec.path, content: spec.content });
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
    ...(renumberedResult.deletedAdrPaths.length > 0
      ? { deletedFiles: renumberedResult.deletedAdrPaths }
      : {})
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
  readonly gh: GitHubRestHelper;
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
          `### File: \`${filePath}\``,
          "#### `<base_version>` (common ancestor):",
          wrapUntrustedContent(
            "untrusted_workspace_files",
            baseContent ?? "",
            12_000
          ),
          `#### \`<ours_target_branch>\` (\`${input.targetBranch}\`):`,
          wrapUntrustedContent(
            "untrusted_workspace_files",
            oursContent ?? "",
            12_000
          ),
          `#### \`<theirs_base_branch>\` (\`${input.baseBranch}\`):`,
          wrapUntrustedContent(
            "untrusted_workspace_files",
            theirsContent ?? "",
            12_000
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
