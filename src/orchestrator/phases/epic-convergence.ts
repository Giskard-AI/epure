import {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  wrapUntrustedContent
} from "../../security/prompt-injection-guard.js";
import { appendEpureCommandsSpoiler } from "../formatting/comments.js";
import { callLlmJson } from "../llm-helper.js";
import { EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT } from "../prompts/code-discipline.js";
import {
  EPIC_CONVERGENCE_AUDIT_SCHEMA,
  type EpicConvergenceAuditPayload,
  type EpicGoalContract,
  type GeneratedTicketSpec,
  type GitHubRestHelper,
  type IssueMetadata,
  type ResolvedPhaseModels,
  type TrackedTicketCommentMetadata
} from "../types.js";
import { buildRepoExplorationToolsAndHandlers } from "../workspace/repo-tools.js";
import {
  createLinkedPhaseTicketsOnGitHub,
  upsertParentIssueTicketsTasklist
} from "./grill-and-plan.js";

export interface RunEpicConvergenceAuditParams {
  readonly issueNumber: number;
  readonly featureBranch: string;
  readonly specPath: string;
  readonly specMarkdown: string;
  readonly glossaryMarkdown: string;
  readonly epicGoalContract: EpicGoalContract;
  readonly accumulatedFiles: Map<string, string>;
  readonly featureChangedFilesMap: ReadonlyMap<string, string>;
  readonly devBranchPaths: readonly string[];
  readonly stage1Summary?: string | undefined;
  readonly gh: Pick<
    GitHubRestHelper,
    "readSingleBranchFile" | "listBranchPaths"
  >;
  readonly llmApiKey: string;
  readonly phaseModels: ResolvedPhaseModels;
  readonly onTransientRetriesUsed?: ((used: number) => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Zero-context Goldfish Epic Convergence Auditor (ADR-0032, Q116 & Q120).
 * Inspects the consolidated `feature/*` branch WITHOUT any ticket conversation history,
 * checking that all `required_entrypoints` are wired end-to-end, no `forbidden_stubs` remain,
 * and all `end_to_end_verification_criteria` are satisfied.
 */
export async function runEpicConvergenceAudit(
  params: RunEpicConvergenceAuditParams
): Promise<EpicConvergenceAuditPayload> {
  const explorationTools = buildRepoExplorationToolsAndHandlers({
    gh: params.gh,
    branch: params.featureBranch,
    featureBranch: params.featureBranch,
    accumulatedFiles: params.accumulatedFiles,
    devBranchPaths: params.devBranchPaths,
    phase: "review",
    alwaysEnableRepoTools: true,
    fetchImpl: params.fetchImpl
  });

  const changedEntries =
    params.featureChangedFilesMap.size > 0
      ? Array.from(params.featureChangedFilesMap.entries())
      : Array.from(params.accumulatedFiles.entries());

  const entrypointSnippets: string[] = [];
  for (const ep of params.epicGoalContract.required_entrypoints) {
    const cleanEp = ep.trim().replace(/^\/+/, "");
    const content =
      params.accumulatedFiles.get(cleanEp) ??
      (await params.gh.readSingleBranchFile(params.featureBranch, cleanEp));
    if (content !== null) {
      params.accumulatedFiles.set(cleanEp, content);
      entrypointSnippets.push(
        `--- REQUIRED ENTRYPOINT: ${cleanEp} (${content.split("\n").length} lines, untruncated) ---\n${content}`
      );
    } else {
      entrypointSnippets.push(
        `--- REQUIRED ENTRYPOINT: ${cleanEp} (MISSING ON ${params.featureBranch}) ---`
      );
    }
  }

  const changedFilesDigest = changedEntries
    .map(
      ([path, content]) =>
        `--- CHANGED FILE: ${path} (${content.split("\n").length} lines, untruncated) ---\n${content}`
    )
    .join("\n\n");

  const systemInstruction = [
    "Tu es l'Auditeur de Convergence de Fonctionnalité Goldfish Zéro-Contexte (`runEpicConvergenceAudit`, ADR-0032, Q116).",
    PROMPT_INJECTION_IMMUNITY_CLAUSE,
    "Tu n'as AUCUNE mémoire des discussions ou des tickets précédents. Tu audites uniquement l'état réel de la branche de fonctionnalité (`feature/*`) par rapport à la spécification approuvée et au `EpicGoalContract`.",
    "Tu disposes du texte intégral (non tronqué) de la spécification, du glossaire, des `required_entrypoints` et des fichiers modifiés, ainsi que des outils d'exploration en lecture seule (`list_repo_files`, `read_repo_file`, `search_repo_code`, `search_in_repo_file`) pour inspecter l'intégralité de tout autre fichier du dépôt sur demande.",
    "Vérifie rigoureusement trois invariants :",
    "1. Câblage des points d'entrée (`required_entrypoints`) : chaque module créé est-il effectivement importé, instancié et branché dans les points d'entrée applicatifs déclarés (ex: routeur, serveur, CLI, store, App) ? Signale tout module isolé ('island code') dans `unwired_modules`.",
    "2. Absence de simulacres interdits (`forbidden_stubs`) : le code de production est-il exempt des mocks/stubs/adaptateurs en mémoire interdits par `forbidden_stubs` ? Signale toute violation dans `stub_violations`.",
    "3. Critères de bout en bout (`end_to_end_verification_criteria`) : tous les scénarios transversaux du contrat sont-ils implémentés et couverts par des tests ? Signale tout écart dans `unmet_criteria`.",
    "Si 100 % des invariants sont respectés, renvoie `verdict: \"CONVERGED\"` et `remediation_tickets: []`.",
    "Si au moins un écart subsiste, renvoie `verdict: \"INCOMPLETE\"` et génère dans `remediation_tickets` un mini-DAG correctif borné (1 à 4 tickets atomiques TDD maximum) pour câbler les modules manquants, remplacer les stubs et ajouter les tests d'intégration de bout en bout.",
    EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT
  ].join("\n");

  const userPrompt = [
    `### Contrat de convergence de fonctionnalité (\`EpicGoalContract\`) pour #${params.issueNumber} :`,
    wrapUntrustedContent(
      "untrusted_spec_content",
      JSON.stringify(params.epicGoalContract, null, 2)
    ),
    "",
    `### Spécification (\`${params.specPath}\`, intégrale) :`,
    wrapUntrustedContent("untrusted_spec_content", params.specMarkdown),
    "",
    "### Glossaire (`GLOSSARY.md`, intégral) :",
    wrapUntrustedContent("untrusted_spec_content", params.glossaryMarkdown),
    "",
    "### État intégral des `required_entrypoints` sur la branche `feature/*` :",
    wrapUntrustedContent(
      "untrusted_workspace_files",
      entrypointSnippets.join("\n\n") || "(aucun entrypoint déclaré)"
    ),
    "",
    "### Fichiers créés ou modifiés sur la branche `feature/*` (intégraux) :",
    wrapUntrustedContent(
      "untrusted_workspace_files",
      changedFilesDigest || "(aucun fichier modifié)"
    ),
    ...(params.stage1Summary
      ? [
          "",
          "### Résumé de vérification Stage 1 :",
          wrapUntrustedContent("untrusted_test_output", params.stage1Summary)
        ]
      : [])
  ].join("\n");

  return await callLlmJson<EpicConvergenceAuditPayload>({
    apiKey: params.llmApiKey,
    model: params.phaseModels.reviewModel,
    providers: params.phaseModels.providers,
    maxTransientRetries: params.phaseModels.maxTransientRetries,
    transientRetryBackoffSeconds:
      params.phaseModels.transientRetryBackoffSeconds,
    requestTimeoutMs: params.phaseModels.requestTimeoutMs,
    onTransientRetriesUsed: params.onTransientRetriesUsed,
    systemInstruction,
    prompt: userPrompt,
    temperature: 0.1,
    ...(explorationTools.tools ? { tools: explorationTools.tools } : {}),
    ...(explorationTools.toolHandlers
      ? { toolHandlers: explorationTools.toolHandlers }
      : {}),
    maxToolRounds: 6,
    logLabel: `epic-convergence-audit#${params.issueNumber}`,
    responseSchema: EPIC_CONVERGENCE_AUDIT_SCHEMA,
    fetchImpl: params.fetchImpl
  });
}

export interface SpawnPhase2ConvergenceTicketsParams {
  readonly gh: Pick<
    GitHubRestHelper,
    | "createIssue"
    | "postIssueComment"
    | "addSubIssue"
    | "addIssueBlockedByDependency"
    | "getIssue"
    | "updateIssue"
  >;
  readonly issueNumber: number;
  readonly issue: IssueMetadata;
  readonly planBranch: string;
  readonly specPath: string;
  readonly epicGoalContract: EpicGoalContract;
  readonly nextEpicPhase: number;
  readonly existingTickets: readonly TrackedTicketCommentMetadata[];
  readonly auditResult: EpicConvergenceAuditPayload;
  readonly stateMirrorMarkdown: string;
}

export async function spawnPhase2ConvergenceTickets(
  params: SpawnPhase2ConvergenceTicketsParams
): Promise<TrackedTicketCommentMetadata[]> {
  const sourceTickets = params.auditResult.remediation_tickets;
  const rawPhaseTickets: readonly GeneratedTicketSpec[] =
    sourceTickets.length > 0
      ? sourceTickets.slice(0, 4)
      : [
          {
            index: 1,
            slug: `phase-${params.nextEpicPhase}-convergence-wiring`,
            title: `[Phase ${params.nextEpicPhase} - Ticket 1] Câblage de convergence et élimination des stubs`,
            description:
              params.auditResult.rationale ||
              "Corriger les écarts de convergence identifiés par l'audit Goldfish.",
            summary:
              params.auditResult.rationale ||
              "Corriger les écarts de convergence identifiés par l'audit Goldfish.",
            acceptance_criteria: [
              ...params.auditResult.unwired_modules.map(
                (m) => `Câbler le module ${m} dans les points d'entrée requis`
              ),
              ...params.auditResult.stub_violations.map(
                (s) => `Remplacer le simulacre interdit : ${s}`
              ),
              ...params.auditResult.unmet_criteria
            ].filter(Boolean),
            blocked_by_indices: [],
            files_to_create_or_update: [
              ...params.epicGoalContract.required_entrypoints
            ],
            files_likely_touched: [
              ...params.epicGoalContract.required_entrypoints
            ]
          }
        ];

  const createdPhaseTickets = await createLinkedPhaseTicketsOnGitHub({
    gh: params.gh,
    parentIssueNumber: params.issueNumber,
    phase: params.nextEpicPhase,
    spoilerContext: {
      phase: "implementation",
      status: "active"
    },
    tickets: rawPhaseTickets.map((specTicket, i) => {
      const cleanTitle = /^\[phase\s*\d+/i.test(specTicket.title.trim())
        ? specTicket.title.trim()
        : `[Phase ${params.nextEpicPhase} - Ticket ${i + 1}] ${specTicket.title
            .trim()
            .replace(/^\[ticket\s*\d+\]\s*/i, "")}`;
      const criteria =
        specTicket.acceptance_criteria.length > 0
          ? specTicket.acceptance_criteria
          : ["Vérifier la convergence de bout en bout sur la branche feature"];
      return {
        index: specTicket.index,
        slug: specTicket.slug,
        title: cleanTitle,
        description: specTicket.description,
        acceptanceCriteria: criteria,
        blockedByIndices: specTicket.blocked_by_indices,
        filesToTouch: specTicket.files_to_create_or_update,
        acceptanceSectionHeading: "Acceptance Criteria (Convergence TDD)",
        extraHeaderLines: [`Convergence Phase: ${params.nextEpicPhase}`]
      };
    })
  });

  const combinedTickets: TrackedTicketCommentMetadata[] = [
    ...params.existingTickets,
    ...createdPhaseTickets
  ];

  await upsertParentIssueTicketsTasklist({
    gh: params.gh,
    parentIssueNumber: params.issueNumber,
    fallbackBody: params.issue.body,
    tickets: combinedTickets
  });

  const phaseComment = appendEpureCommandsSpoiler(
    [
      params.stateMirrorMarkdown,
      "",
      `### 🔄 Audit de Convergence Goldfish (\`INCOMPLETE\`) — Lancement automatique de la Phase ${params.nextEpicPhase}`,
      "",
      `- **Synthèse** : ${params.auditResult.rationale}`,
      ...(params.auditResult.unwired_modules.length > 0
        ? [
            `- **Modules non câblés détectés** : ${params.auditResult.unwired_modules.join(" ; ")}`
          ]
        : []),
      ...(params.auditResult.stub_violations.length > 0
        ? [
            `- **Simulacres interdits détectés** : ${params.auditResult.stub_violations.join(" ; ")}`
          ]
        : []),
      ...(params.auditResult.unmet_criteria.length > 0
        ? [
            `- **Critères non satisfaits** : ${params.auditResult.unmet_criteria.join(" ; ")}`
          ]
        : []),
      "",
      `#### Tickets correctifs de Phase ${params.nextEpicPhase} créés et lancés automatiquement :`,
      ...createdPhaseTickets.map(
        (t) => `- **#${t.ticketIssueNumber}** — ${t.title}`
      ),
      "",
      `<!-- epure-plan-manifest:${JSON.stringify({
        planBranch: params.planBranch,
        specPath: params.specPath,
        epicGoalContract: params.epicGoalContract,
        tickets: combinedTickets
      })} -->`
    ].join("\n"),
    {
      phase: "implementation",
      status: "active",
      issueNumber: params.issueNumber
    }
  );

  await params.gh.postIssueComment(params.issueNumber, phaseComment);

  return combinedTickets;
}
