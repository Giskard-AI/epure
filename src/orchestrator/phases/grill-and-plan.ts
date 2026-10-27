import {
  buildRenovateConfigJson,
  buildStackAwareCiWorkflowYaml,
  buildZizmorConfigYaml,
  detectRepositoryStack
} from "../../bootstrap/ci-and-renovate.js";
import { planImpeccableDesignSession } from "../../frontend/impeccable-planning.js";
import {
  validatePlanningArtifactsAndGraph,
  type PlanningArtifactsBundle
} from "../../planning/artifacts-gate.js";
import {
  adaptReviewerRosterForDomain,
  runUserAdvocateDesignGate
} from "../../review/reviewer-roster.js";
import {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  wrapUntrustedContent
} from "../../security/prompt-injection-guard.js";
import {
  updateIssueStateWithCas,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import { appendEpureCommandsSpoiler } from "../formatting/comments.js";
import { callGeminiJson, callGeminiText } from "../gemini-client.js";
import {
  GENERATED_PLANNING_BUNDLE_SCHEMA,
  GENERATED_SPEC_ARTIFACTS_SCHEMA,
  GENERATED_TICKET_DAG_SCHEMA,
  GRILL_ROUND_EVALUATION_SCHEMA,
  type GeneratedPlanningBundle,
  type GeneratedSpecArtifacts,
  type GeneratedTicketDag,
  type GitHubRestHelper,
  type GrillRoundEvaluation,
  type IssueCommentRecord,
  type IssueMetadata,
  type OrchestrateIssueResult,
  type ResolvedPhaseModels
} from "../types.js";
import { buildRepoExplorationToolsAndHandlers } from "../workspace/repo-tools.js";

interface StoredSpecManifest {
  readonly planBranch: string;
  readonly specPath: string;
  readonly adrPaths: readonly string[];
  readonly targetFilesHint: readonly string[];
}

function parseLatestSpecManifest(
  comments: readonly IssueCommentRecord[]
): StoredSpecManifest | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body ?? "";
    const match = body.match(/<!-- epure-spec-manifest:(\{[\s\S]*?\}) -->/);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1]) as Partial<StoredSpecManifest>;
        if (
          typeof parsed.planBranch === "string" &&
          typeof parsed.specPath === "string" &&
          Array.isArray(parsed.adrPaths)
        ) {
          return {
            planBranch: parsed.planBranch,
            specPath: parsed.specPath,
            adrPaths: parsed.adrPaths.filter(
              (p): p is string => typeof p === "string"
            ),
            targetFilesHint: Array.isArray(parsed.targetFilesHint)
              ? parsed.targetFilesHint.filter(
                  (f): f is string => typeof f === "string"
                )
              : []
          };
        }
      } catch {
        // Ignore malformed manifest comments
      }
    }
  }
  return null;
}

export async function runGrillAndPlanPhase(params: {
  readonly command: "plan" | "reply" | "to-spec" | "to-tickets";
  readonly currentPhase?: string | undefined;
  readonly currentStatus?: string | undefined;
  readonly repository: string;
  readonly issueNumber: number;
  readonly commentId: number | undefined;
  readonly issue: IssueMetadata;
  readonly allComments: readonly IssueCommentRecord[];
  readonly planSlug: string;
  readonly planBranch: string;
  readonly gh: GitHubRestHelper;
  readonly store: GitRefStateStore;
  readonly llmApiKey: string;
  readonly phaseModels: ResolvedPhaseModels;
  readonly onTransientRetriesUsed?: ((retriesUsed: number) => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<OrchestrateIssueResult> {
  const {
    command,
    currentPhase,
    currentStatus,
    repository,
    issueNumber,
    commentId,
    issue,
    allComments,
    planSlug,
    planBranch,
    gh,
    store,
    llmApiKey,
    phaseModels,
    onTransientRetriesUsed,
    fetchImpl
  } = params;

  if (currentStatus === "suspended") {
    await gh.removeIssueLabel?.(issueNumber, "needs-human");
  }

  const grillExplorationCache = new Map<string, string>();
  const grillRepoTools = buildRepoExplorationToolsAndHandlers({
    gh,
    branch: "dev",
    featureBranch: "main",
    accumulatedFiles: grillExplorationCache,
    devBranchPaths: []
  });

  if (command === "plan") {
    const updated = await updateIssueStateWithCas({
      issueNumber,
      store,
      mutator: (prev) => ({
        ...prev,
        phase: "grilling",
        status: "active",
        active_branch: planBranch,
        last_processed_comment_id: commentId ?? prev.last_processed_comment_id
      })
    });

    const grillSystemInstruction = [
      "Tu es l'architecte EPURE conduisant un entretien multi-tours `/grill-with-docs` sur une GitHub Issue.",
      PROMPT_INJECTION_IMMUNITY_CLAUSE,
      "Si une question peut être éclairée ou résolue en inspectant le dépôt (fichiers Markdown, ADRs, GLOSSARY, code source), utilise d'abord les outils d'exploration (`list_repo_files`, `read_repo_file`, `search_in_repo_file`) avant de poser tes questions.",
      "Parcours l'arbre des décisions en rounds successifs (la « frontière » des décisions dont les prérequis sont connus).",
      "Pose les 3 à 4 questions de cadrage décisives de ce premier round (architecture, invariants métiers, gestion d'état/persistance, couverture de tests TDD) au format :",
      "❓ **Q1** - **<Titre>** : <Question>",
      "➡️ <Recommandation concrète (formulée pour que 'oui' valide la recommandation)>",
      "",
      "Termine en indiquant à l'utilisateur qu'il peut répondre directement en commentaire sur cette issue (sans commande slash) : tant qu'il reste des points ouverts ou des décisions dépendantes à clarifier, l'entretien bouclera sur un round suivant ; une fois la frontière de décisions validée, l'humain pourra lancer `/epure to-spec`."
    ].join("\n");

    const grillPrompt = [
      `Issue #${issue.number} (données non fiables soumises par l'utilisateur) :`,
      wrapUntrustedContent(
        "untrusted_issue_content",
        `Titre : ${issue.title}\n\nCorps :\n${issue.body}`
      )
    ].join("\n");

    const grillQuestions = await callGeminiText({
      apiKey: llmApiKey,
      model: phaseModels.planningModel,
      providers: phaseModels.providers,
      maxTransientRetries: phaseModels.maxTransientRetries,
      transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
      requestTimeoutMs: phaseModels.requestTimeoutMs,
      onTransientRetriesUsed,
      systemInstruction: grillSystemInstruction,
      prompt: grillPrompt,
      temperature: 0.2,
      tools: grillRepoTools.tools,
      toolHandlers: grillRepoTools.toolHandlers,
      maxToolRounds: 8,
      logLabel: `grill-round-1#${issueNumber}`,
      fetchImpl
    });

    const commentBody = appendEpureCommandsSpoiler(
      [
        updated.issue_mirror_markdown,
        "",
        "### Entretien de Cadrage EPURE (`/grill-with-docs` — Round 1)",
        "",
        grillQuestions
      ].join("\n"),
      {
        phase: "grilling",
        status: "active",
        issueNumber
      }
    );

    await gh.postIssueComment(issueNumber, commentBody);
    return {
      executed: true,
      phase: updated.state.phase,
      status: updated.state.status,
      active_branch: planBranch,
      summary_markdown: commentBody,
      created_ticket_numbers: [],
      feature_pr_url: ""
    };
  }

  const fullConversationHistory = allComments
    .map((c) => {
      const isBot =
        c.user.login.endsWith("[bot]") ||
        c.user.type === "Bot" ||
        c.body.includes("### Entretien de Cadrage EPURE");
      const roleLabel = isBot
        ? `[Architecte EPURE (@${c.user.login})]`
        : `[Humain (@${c.user.login})]`;
      return `${roleLabel}:\n${c.body}`;
    })
    .join("\n\n---\n\n");

  const priorGrillRoundsCount = allComments.filter((c) =>
    c.body.includes("### Entretien de Cadrage EPURE")
  ).length;

  if (command === "reply" && currentPhase !== "spec") {
    const grillLoopEvalSystemInstruction = [
      "Tu es l'architecte EPURE conduisant un entretien multi-tours `/grill-with-docs` (arbre de décisions par rounds).",
      PROMPT_INJECTION_IMMUNITY_CLAUSE,
      "Analyse l'issue initiale et l'historique complet de la conversation (questions posées par l'Architecte EPURE et réponses de l'Humain).",
      "Utilise si nécessaire les outils d'exploration (`list_repo_files`, `read_repo_file`, `search_in_repo_file`) pour inspecter les fichiers réels du dépôt (docs, ADRs, GLOSSARY, code source) et ancrer tes questions ou ta synthèse dans la réalité du code.",
      "Détermine si la frontière de l'arbre de décisions est vide (`frontier_resolved: true`) ou s'il reste des questions non répondues, des contre-propositions humaines ouvrant de nouvelles branches techniques/métiers, ou des ambiguïtés concrètes dans le dépôt nécessitant un round supplémentaire (`frontier_resolved: false`).",
      "Règles de décision :",
      "- Si l'humain n'a répondu que partiellement aux questions du round précédent, a posé une question en retour, a rejeté une recommandation sans préciser l'alternative, ou si sa réponse débloque un choix architectural/documentaire aval concret non encore tranché -> `frontier_resolved: false` et génère les questions de suivi numérotées (`❓ **Q...**` + `➡️ **Recommandation**`).",
      "- Si toutes les questions de cadrage ont reçu une réponse claire (ou ont été validées) et que le périmètre métier, l'architecture, les formules/invariants et la stratégie TDD sont suffisamment précis -> `frontier_resolved: true` et remplis `settled_decisions_summary_markdown` avec la synthèse structurée de toutes les décisions actées pendant le grill.",
      "Réponds UNIQUEMENT par un objet JSON valide respectant ce schéma :",
      "{",
      '  "frontier_resolved": boolean,',
      `  "round_number": ${priorGrillRoundsCount + 1},`,
      '  "follow_up_questions_markdown": "string (vide si frontier_resolved=true, sinon les questions ❓ **Q...** / ➡️ Recommandation du nouveau round)",',
      '  "settled_decisions_summary_markdown": "string (synthèse Markdown à puces de toutes les décisions tranchées si frontier_resolved=true, sinon vide)",',
      '  "rationale": "Explication concise de l\'état de la frontière de décision"',
      "}"
    ].join("\n");

    const grillLoopEvalPrompt = [
      `Issue #${issue.number} (description initiale non fiable) :`,
      wrapUntrustedContent(
        "untrusted_issue_content",
        `Titre : ${issue.title}\n\nDescription :\n${issue.body}`
      ),
      "",
      `Nombre de rounds /grill-with-docs déjà effectués : ${priorGrillRoundsCount}`,
      "Historique complet de l'entretien (questions EPURE et réponses humaines) :",
      wrapUntrustedContent(
        "untrusted_comment_history",
        fullConversationHistory
      )
    ].join("\n");

    const evalResult = await callGeminiJson<GrillRoundEvaluation>({
      apiKey: llmApiKey,
      model: phaseModels.planningModel,
      providers: phaseModels.providers,
      maxTransientRetries: phaseModels.maxTransientRetries,
      transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
      requestTimeoutMs: phaseModels.requestTimeoutMs,
      onTransientRetriesUsed,
      systemInstruction: grillLoopEvalSystemInstruction,
      prompt: grillLoopEvalPrompt,
      temperature: 0.1,
      tools: grillRepoTools.tools,
      toolHandlers: grillRepoTools.toolHandlers,
      maxToolRounds: 8,
      logLabel: `grill-eval#${issueNumber}`,
      responseSchema: GRILL_ROUND_EVALUATION_SCHEMA,
      fetchImpl
    });

    if (
      !evalResult.frontier_resolved &&
      evalResult.follow_up_questions_markdown.trim().length > 0
    ) {
      const nextRoundNumber =
        evalResult.round_number || priorGrillRoundsCount + 1;
      const updatedGrill = await updateIssueStateWithCas({
        issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "grilling",
          status: "active",
          active_branch: planBranch,
          last_processed_comment_id: commentId ?? prev.last_processed_comment_id
        })
      });

      const followUpBody = appendEpureCommandsSpoiler(
        [
          updatedGrill.issue_mirror_markdown,
          "",
          `### Entretien de Cadrage EPURE (\`/grill-with-docs\` — Round ${nextRoundNumber})`,
          "",
          evalResult.follow_up_questions_markdown.trim(),
          "",
          "---",
          "_Réponds directement en commentaire pour poursuivre l'entretien, ou poste `/epure to-spec` pour valider le cadrage et générer la spécification._"
        ].join("\n"),
        {
          phase: "grilling",
          status: "active",
          issueNumber
        }
      );

      await gh.postIssueComment(issueNumber, followUpBody);
      return {
        executed: true,
        phase: updatedGrill.state.phase,
        status: updatedGrill.state.status,
        active_branch: planBranch,
        summary_markdown: followUpBody,
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    }

    // Frontier resolved during a human reply: pause for explicit human validation before /to-spec
    const updatedFrontierReady = await updateIssueStateWithCas({
      issueNumber,
      store,
      mutator: (prev) => ({
        ...prev,
        phase: "grilling",
        status: "awaiting_human_approval",
        active_branch: planBranch,
        last_processed_comment_id: commentId ?? prev.last_processed_comment_id
      })
    });

    const settledSummary =
      evalResult.settled_decisions_summary_markdown?.trim() ||
      evalResult.rationale.trim() ||
      "Toutes les questions de la frontière de décisions ont reçu une réponse.";

    const frontierResolvedComment = appendEpureCommandsSpoiler(
      [
        updatedFrontierReady.issue_mirror_markdown,
        "",
        "### ✅ Frontière de Cadrage Résolue (`/grill-with-docs` — En attente de validation humaine)",
        "",
        settledSummary,
        "",
        "---",
        "👉 **Validation humaine requise avant `/to-spec`** :",
        "- Si ce cadrage vous convient, postez **`/epure to-spec`** pour générer le `GLOSSARY.md`, les ADRs et la spécification complète sur `" +
          planBranch +
          "`.",
        "- Si vous souhaitez approfondir un point, ajouter une contrainte ou corriger une décision, **répondez simplement en commentaire** (sans commande slash) pour ouvrir un nouveau round de grill."
      ].join("\n"),
      {
        phase: "grilling",
        status: "awaiting_human_approval",
        issueNumber
      }
    );

    await gh.postIssueComment(issueNumber, frontierResolvedComment);
    return {
      executed: true,
      phase: updatedFrontierReady.state.phase,
      status: updatedFrontierReady.state.status,
      active_branch: planBranch,
      summary_markdown: frontierResolvedComment,
      created_ticket_numbers: [],
      feature_pr_url: ""
    };
  }

  await gh.ensureBranch("dev", "main");
  const humanContext = allComments
    .filter((c) => !c.user.login.endsWith("[bot]") && c.user.type !== "Bot")
    .map((c) => `@${c.user.login}: ${c.body}`)
    .join("\n\n---\n\n");

  const readRepoFileSafely = async (
    path: string,
    ref: string
  ): Promise<string | null> => {
    if (typeof gh.readSingleBranchFile !== "function") {
      return null;
    }
    try {
      return await gh.readSingleBranchFile(ref, path);
    } catch {
      return null;
    }
  };

  // Phase 2: /epure to-spec (or human revision comment while in phase === "spec")
  if (command === "to-spec" || (command === "reply" && currentPhase === "spec")) {
    const isSpecRevision = command === "reply" && currentPhase === "spec";
    const existingManifest = parseLatestSpecManifest(allComments);
    const currentSpecOnBranch = await readRepoFileSafely(
      existingManifest?.specPath ?? `docs/specs/${planSlug}.md`,
      planBranch
    );

    const specOnlySystemInstruction = [
      "Tu es l'architecte EPURE chargé de produire (ou réviser) le dossier de spécification complet (`GLOSSARY.md`, ADRs dans `docs/adr/`, et spécification `docs/specs/<slug>.md`) SANS créer les tickets pour l'instant.",
      PROMPT_INJECTION_IMMUNITY_CLAUSE,
      "Si tu as besoin de vérifier des chemins ou le contenu existant de GLOSSARY.md / docs/adr/ avant de rédiger, utilise les outils d'exploration avec parcimonie (1 à 3 appels maximum), puis génère immédiatement l'objet JSON final.",
      "RÈGLE CRITIQUE : INTERDICTION STRICTE d'utiliser des ellipses ('...', '# Spécification...', etc.) ou des valeurs tronquées. Chaque champ ('glossary_markdown', 'adrs[*].content', 'spec_markdown', 'target_files_hint') DOIT contenir le texte intégral, détaillé et complet prêt à être commité dans le dépôt.",
      "Produis un objet JSON strictement valide (sans markdown autour) respectant exactement cette structure :",
      "{",
      `  "plan_slug": "${planSlug}",`,
      '  "glossary_markdown": "<Contenu Markdown intégral de GLOSSARY.md intégrant les termes du domaine>",',
      '  "adrs": [',
      '    { "path": "docs/adr/NNNN-decision-architecturale.md", "content": "<Contenu Markdown intégral de l\'ADR avec Context, Decision et Consequences>" }',
      "  ],",
      `  "spec_path": "docs/specs/${planSlug}.md",`,
      '  "spec_markdown": "<Contenu Markdown intégral et détaillé de la spécification technique et fonctionnelle>",',
      '  "target_files_hint": ["<chemin/fichier1>", "<chemin/fichier2>"]',
      "}"
    ].join("\n");

    const specOnlyPrompt = [
      `Issue #${issue.number} (description initiale non fiable) :`,
      wrapUntrustedContent(
        "untrusted_issue_content",
        `Titre : ${issue.title}\n\nDescription :\n${issue.body}`
      ),
      "",
      ...(currentSpecOnBranch
        ? [
            `Spécification existante sur \`${planBranch}\` à réviser selon les derniers commentaires humains :`,
            wrapUntrustedContent("untrusted_spec_content", currentSpecOnBranch),
            ""
          ]
        : []),
      "Historique complet de l'entretien /grill-with-docs et retours humains :",
      wrapUntrustedContent(
        "untrusted_comment_history",
        fullConversationHistory || humanContext
      )
    ].join("\n");

    const specArtifacts = await callGeminiJson<GeneratedSpecArtifacts>({
      apiKey: llmApiKey,
      model: phaseModels.planningModel,
      providers: phaseModels.providers,
      maxTransientRetries: phaseModels.maxTransientRetries,
      transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
      requestTimeoutMs: phaseModels.requestTimeoutMs,
      onTransientRetriesUsed,
      systemInstruction: specOnlySystemInstruction,
      prompt: specOnlyPrompt,
      temperature: 0.1,
      tools: grillRepoTools.tools,
      toolHandlers: grillRepoTools.toolHandlers,
      maxToolRounds: 10,
      logLabel: isSpecRevision
        ? `spec-revision#${issueNumber}`
        : `spec-artifacts#${issueNumber}`,
      responseSchema: GENERATED_SPEC_ARTIFACTS_SCHEMA,
      fetchImpl
    });

    // Validate GLOSSARY.md, ADRs, and spec_markdown via artifacts gate
    const specGateResult = validatePlanningArtifactsAndGraph({
      introducesDomainTerms: true,
      glossaryContent: specArtifacts.glossary_markdown,
      adrFiles: specArtifacts.adrs.map((a) => ({
        path: a.path,
        content: a.content
      })),
      specPath: specArtifacts.spec_path,
      specContent: specArtifacts.spec_markdown,
      tickets: [
        {
          id: 1,
          issueNumber: 1,
          title: "spec-validation-placeholder",
          state: "open",
          blockedBy: []
        }
      ]
    });

    if (!specGateResult.valid) {
      await gh.ensureLabel(
        "needs-human",
        "D93F0B",
        "Requires human maintainer intervention"
      );
      await gh.addIssueLabels(issueNumber, ["needs-human"]);

      const suspended = await updateIssueStateWithCas({
        issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "spec",
          status: "suspended",
          active_branch: planBranch,
          last_processed_comment_id: commentId ?? prev.last_processed_comment_id
        })
      });

      const escalationComment = appendEpureCommandsSpoiler(
        [
          suspended.issue_mirror_markdown,
          "",
          `### ⚠️ Escalade \`needs-human\` — Échec de validation des livrables de spécification (\`${specGateResult.error_code}\`)`,
          "",
          `- **Code d'erreur** : \`${specGateResult.error_code}\``,
          `- **Raison** : ${specGateResult.error_message}`,
          "- **Action requise** : Corrigez les livrables ou relancez `/epure to-spec`."
        ].join("\n"),
        {
          phase: "suspended",
          status: "suspended",
          issueNumber
        }
      );

      await gh.postIssueComment(issueNumber, escalationComment);
      return {
        executed: true,
        phase: suspended.state.phase,
        status: suspended.state.status,
        active_branch: planBranch,
        summary_markdown: escalationComment,
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    }

    const targetFilesHint = specArtifacts.target_files_hint ?? [];
    const touchesFrontendUi = targetFilesHint.some((f) =>
      /\.(?:tsx|jsx|css|scss|html)$/i.test(f)
    );

    const impeccableSession = planImpeccableDesignSession({
      issueNumber,
      surfaceSlug: planSlug,
      touchesFrontendUi,
      alreadyAnsweredTopics: ["theme", "layout"],
      candidateDesignTopics: ["theme", "layout", "accessibility"]
    });

    const designGate = touchesFrontendUi
      ? await runUserAdvocateDesignGate({
          repository,
          planTitle: issue.title,
          glossaryMarkdown: specArtifacts.glossary_markdown,
          specMarkdown: specArtifacts.spec_markdown,
          llmApiKey,
          model: phaseModels.reviewModel,
          providers: phaseModels.providers,
          maxTransientRetries: phaseModels.maxTransientRetries,
          transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
          requestTimeoutMs: phaseModels.requestTimeoutMs,
          onTransientRetriesUsed,
          fetchImpl
        })
      : null;

    const plannedStack = detectRepositoryStack({
      targetFilesHint
    });
    const adaptedRoster = adaptReviewerRosterForDomain({
      repository,
      planTitle: issue.title,
      glossaryMarkdown: specArtifacts.glossary_markdown,
      specMarkdown: specArtifacts.spec_markdown,
      touchesFrontendUi,
      stackKind: plannedStack.kind,
      personas: designGate?.personas,
      domainInvariants: designGate?.domain_invariants
    });

    const zizmorFile = buildZizmorConfigYaml();
    const renovateFile = buildRenovateConfigJson(plannedStack);
    const ciFile = buildStackAwareCiWorkflowYaml({
      pinnedSha: "main",
      stack: plannedStack
    });

    const existingBaseRoster = await gh.readTrustedBaseRosterFiles("dev");
    const hasExistingConfiguredRoster = existingBaseRoster.size > 0;

    const corePlanningDocs: Array<{ path: string; content: string }> = [
      ...(specArtifacts.glossary_markdown.trim().length > 0
        ? [{ path: "GLOSSARY.md", content: specArtifacts.glossary_markdown }]
        : []),
      { path: specArtifacts.spec_path, content: specArtifacts.spec_markdown },
      ...specArtifacts.adrs.map((a) => ({ path: a.path, content: a.content }))
    ];

    const planningFiles: Array<{ path: string; content: string }> =
      hasExistingConfiguredRoster
        ? corePlanningDocs
        : [
            ...corePlanningDocs,
            ...adaptedRoster.files,
            zizmorFile,
            renovateFile,
            ciFile
          ];

    await gh.commitFilesToBranch({
      branch: planBranch,
      fromBranch: "dev",
      commitMessage: isSpecRevision
        ? `docs(plan): revise GLOSSARY, ADRs, and spec for #${issueNumber}`
        : `docs(plan): generate GLOSSARY, ADRs, spec, DESIGN.md, and adapted reviewer roster for #${issueNumber}`,
      files: planningFiles
    });

    const updatedSpec = await updateIssueStateWithCas({
      issueNumber,
      store,
      mutator: (prev) => ({
        ...prev,
        phase: "spec",
        status: "awaiting_human_approval",
        active_branch: planBranch,
        last_processed_comment_id: commentId ?? prev.last_processed_comment_id
      })
    });

    const specManifestPayload: StoredSpecManifest = {
      planBranch,
      specPath: specArtifacts.spec_path,
      adrPaths: specArtifacts.adrs.map((a) => a.path),
      targetFilesHint
    };

    const specReviewComment = appendEpureCommandsSpoiler(
      [
        updatedSpec.issue_mirror_markdown,
        "",
        isSpecRevision
          ? `### 📝 Spécification révisée sur \`${planBranch}\` (En attente de validation humaine)`
          : `### 📄 Spécification, Glossaire et ADRs générés sur \`${planBranch}\` (En attente de validation humaine)`,
        "",
        "- **Glossaire** : `GLOSSARY.md`",
        `- **ADRs** : ${specArtifacts.adrs.map((a) => `\`${a.path}\``).join(", ")}`,
        `- **Spécification** : \`${specArtifacts.spec_path}\``,
        `- **Roster Multi-Agents adapté** : \`.cursor/agents/*.md\` (${adaptedRoster.files.length} fichiers)`,
        ...(impeccableSession.impeccable_invoked
          ? [
              "- **Design Gate Impeccable & `user-advocate` (`design-gate`)** : `DESIGN.md` généré"
            ]
          : []),
        "",
        "👉 **Validation humaine de la spécification requise avant `/to-tickets`** :",
        `- Inspectez les fichiers sur la branche \`${planBranch}\` (\`${specArtifacts.spec_path}\`, \`GLOSSARY.md\`, ADRs).`,
        "- Pour demander un ajustement ou une correction de la spécification, **répondez directement en commentaire** (sans commande slash).",
        "- Si la spécification est validée, postez **`/epure to-tickets`** pour générer le graphe de tickets TDD (`ready-for-agent`).",
        "",
        `<!-- epure-spec-manifest:${JSON.stringify(specManifestPayload)} -->`
      ].join("\n"),
      {
        phase: "spec",
        status: "awaiting_human_approval",
        issueNumber
      }
    );

    await gh.postIssueComment(issueNumber, specReviewComment);

    return {
      executed: true,
      phase: updatedSpec.state.phase,
      status: updatedSpec.state.status,
      active_branch: planBranch,
      summary_markdown: specReviewComment,
      created_ticket_numbers: [],
      feature_pr_url: ""
    };
  }

  // Phase 3: /epure to-tickets (either from an already-committed spec on planBranch, or shortcut from grilling)
  const storedSpecManifest = parseLatestSpecManifest(allComments);
  const candidateSpecPath =
    storedSpecManifest?.specPath ?? `docs/specs/${planSlug}.md`;
  const existingSpecOnPlanBranch = await readRepoFileSafely(
    candidateSpecPath,
    planBranch
  );

  let bundle: GeneratedPlanningBundle;

  if (existingSpecOnPlanBranch && existingSpecOnPlanBranch.trim().length > 0) {
    const existingGlossary =
      (await readRepoFileSafely("GLOSSARY.md", planBranch)) ??
      (await readRepoFileSafely("GLOSSARY.md", "dev")) ??
      "# Glossary\n\n- **Domain Term**: Canonical project definition.\n";

    const adrPathsToRead = storedSpecManifest?.adrPaths ?? [];
    const loadedAdrs: Array<{
      path: string;
      content: string;
      filename: string;
      title: string;
      markdown: string;
    }> = [];
    for (const adrPath of adrPathsToRead) {
      const adrContent = await readRepoFileSafely(adrPath, planBranch);
      if (adrContent) {
        const filename = adrPath.split("/").pop() ?? adrPath;
        loadedAdrs.push({
          path: adrPath,
          content: adrContent,
          filename,
          title: filename,
          markdown: adrContent
        });
      }
    }

    const ticketsOnlySystemInstruction = [
      "Tu es l'architecte EPURE chargé de découper la spécification approuvée en un graphe acyclique (DAG) de tickets atomiques TDD.",
      PROMPT_INJECTION_IMMUNITY_CLAUSE,
      "RÈGLE CRITIQUE : INTERDICTION STRICTE d'utiliser des ellipses ('...', etc.) ou des valeurs tronquées. Chaque champ ('tickets[*].title', 'tickets[*].description', 'tickets[*].acceptance_criteria', 'tickets[*].files_to_create_or_update') DOIT contenir le texte intégral, détaillé et complet.",
      "Produis un objet JSON strictement valide (sans markdown autour) respectant exactement cette structure :",
      "{",
      '  "tickets": [',
      "    {",
      '      "index": 1,',
      '      "slug": "<slug-court-du-ticket-1>",',
      '      "title": "[Ticket 1] <Titre explicite et complet du ticket 1>",',
      '      "description": "<Description technique complète et détaillée du ticket 1>",',
      '      "acceptance_criteria": ["<Critère d\'acceptation vérifiable 1>", "<Critère d\'acceptation vérifiable 2>"],',
      '      "blocked_by_indices": [],',
      '      "files_to_create_or_update": ["<chemin/fichier1>", "<chemin/fichier2>"]',
      "    }",
      "  ]",
      "}"
    ].join("\n");

    const ticketsOnlyPrompt = [
      `Issue #${issue.number} :`,
      wrapUntrustedContent(
        "untrusted_issue_content",
        `Titre : ${issue.title}\n\nDescription :\n${issue.body}`
      ),
      "",
      `Spécification approuvée sur \`${planBranch}\` (\`${candidateSpecPath}\`) :`,
      wrapUntrustedContent("untrusted_spec_content", existingSpecOnPlanBranch),
      "",
      "Historique complet de l'entretien et des validations :",
      wrapUntrustedContent(
        "untrusted_comment_history",
        fullConversationHistory || humanContext
      )
    ].join("\n");

    const ticketDag = await callGeminiJson<GeneratedTicketDag>({
      apiKey: llmApiKey,
      model: phaseModels.planningModel,
      providers: phaseModels.providers,
      maxTransientRetries: phaseModels.maxTransientRetries,
      transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
      requestTimeoutMs: phaseModels.requestTimeoutMs,
      onTransientRetriesUsed,
      systemInstruction: ticketsOnlySystemInstruction,
      prompt: ticketsOnlyPrompt,
      temperature: 0.1,
      tools: grillRepoTools.tools,
      toolHandlers: grillRepoTools.toolHandlers,
      maxToolRounds: 8,
      logLabel: `ticket-dag#${issueNumber}`,
      responseSchema: GENERATED_TICKET_DAG_SCHEMA,
      fetchImpl
    });

    const fallbackAdrContent =
      "# ADR 0001\n\n## Context\nApproved specification on plan branch.\n\n## Decision\nExecute atomic TDD ticket DAG.\n\n## Consequences\nDeterministic execution.\n";

    bundle = {
      plan_slug: planSlug,
      glossary_markdown: existingGlossary,
      adrs:
        loadedAdrs.length > 0
          ? loadedAdrs
          : [
              {
                path: "docs/adr/0001-plan-architecture.md",
                content: fallbackAdrContent,
                filename: "0001-plan-architecture.md",
                title: "ADR 0001",
                markdown: fallbackAdrContent
              }
            ],
      spec_path: candidateSpecPath,
      spec_markdown: existingSpecOnPlanBranch,
      tickets: ticketDag.tickets
    };
  } else {
    const specSystemInstruction = [
      "Tu es l'architecte EPURE chargé de produire le dossier de spécification complet et le découpage en tickets atomiques TDD.",
      PROMPT_INJECTION_IMMUNITY_CLAUSE,
      "Si tu as besoin de vérifier des chemins ou le contenu existant de GLOSSARY.md / docs/adr/ avant de rédiger, utilise les outils d'exploration avec parcimonie (1 à 3 appels maximum), puis génère immédiatement l'objet JSON final.",
      "RÈGLE CRITIQUE : INTERDICTION STRICTE d'utiliser des ellipses ('...', '# Spécification...', etc.) ou des valeurs tronquées. Chaque champ ('glossary_markdown', 'adrs[*].content', 'spec_markdown', 'tickets[*].title', 'tickets[*].description', 'tickets[*].acceptance_criteria', 'tickets[*].files_to_create_or_update') DOIT contenir le texte intégral, détaillé et complet prêt à être commité dans le dépôt.",
      "Produis un objet JSON strictement valide (sans markdown autour) respectant exactement cette structure :",
      "{",
      `  "plan_slug": "${planSlug}",`,
      '  "glossary_markdown": "<Contenu Markdown intégral de GLOSSARY.md intégrant les termes du domaine>",',
      '  "adrs": [',
      '    { "path": "docs/adr/NNNN-decision-architecturale.md", "content": "<Contenu Markdown intégral de l\'ADR avec Context, Decision et Consequences>" }',
      "  ],",
      `  "spec_path": "docs/specs/${planSlug}.md",`,
      '  "spec_markdown": "<Contenu Markdown intégral et détaillé de la spécification technique et fonctionnelle>",',
      '  "tickets": [',
      "    {",
      '      "index": 1,',
      '      "slug": "<slug-court-du-ticket-1>",',
      '      "title": "[Ticket 1] <Titre explicite et complet du ticket 1>",',
      '      "description": "<Description technique complète et détaillée du ticket 1>",',
      '      "acceptance_criteria": ["<Critère d\'acceptation vérifiable 1>", "<Critère d\'acceptation vérifiable 2>"],',
      '      "blocked_by_indices": [],',
      '      "files_to_create_or_update": ["<chemin/fichier1>", "<chemin/fichier2>"]',
      "    }",
      "  ]",
      "}"
    ].join("\n");

    const specGenerationPrompt = [
      `Issue #${issue.number} (description initiale non fiable) :`,
      wrapUntrustedContent(
        "untrusted_issue_content",
        `Titre : ${issue.title}\n\nDescription :\n${issue.body}`
      ),
      "",
      "Historique complet de l'entretien /grill-with-docs (questions EPURE et réponses humaines) :",
      wrapUntrustedContent(
        "untrusted_comment_history",
        fullConversationHistory || humanContext
      )
    ].join("\n");

    bundle = await callGeminiJson<GeneratedPlanningBundle>({
      apiKey: llmApiKey,
      model: phaseModels.planningModel,
      providers: phaseModels.providers,
      maxTransientRetries: phaseModels.maxTransientRetries,
      transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
      requestTimeoutMs: phaseModels.requestTimeoutMs,
      onTransientRetriesUsed,
      systemInstruction: specSystemInstruction,
      prompt: specGenerationPrompt,
      temperature: 0.1,
      tools: grillRepoTools.tools,
      toolHandlers: grillRepoTools.toolHandlers,
      maxToolRounds: 10,
      logLabel: `spec-bundle#${issueNumber}`,
      responseSchema: GENERATED_PLANNING_BUNDLE_SCHEMA,
      fetchImpl
    });
  }

  // Bucket A Guard: Validate planning artifacts and DAG acyclicity before creating sub-issues
  const gateBundle: PlanningArtifactsBundle = {
    introducesDomainTerms: true,
    glossaryContent: bundle.glossary_markdown,
    adrFiles: bundle.adrs.map((a) => ({
      path: a.path,
      content: a.content
    })),
    specPath: bundle.spec_path,
    specContent: bundle.spec_markdown,
    tickets: bundle.tickets.map((t) => ({
      id: t.index,
      issueNumber: t.index,
      title: t.title,
      state: "open" as const,
      blockedBy: t.blocked_by_indices
    }))
  };

  const gateResult = validatePlanningArtifactsAndGraph(gateBundle);
  if (!gateResult.valid) {
    await gh.ensureLabel(
      "needs-human",
      "D93F0B",
      "Requires human maintainer intervention"
    );
    await gh.addIssueLabels(issueNumber, ["needs-human"]);

    const suspended = await updateIssueStateWithCas({
      issueNumber,
      store,
      mutator: (prev) => ({
        ...prev,
        phase: "tickets",
        status: "suspended",
        active_branch: planBranch,
        last_processed_comment_id: commentId ?? prev.last_processed_comment_id
      })
    });

    const escalationComment = appendEpureCommandsSpoiler(
      [
        suspended.issue_mirror_markdown,
        "",
        `### ⚠️ Escalade \`needs-human\` — Échec de validation du graphe de planification (\`${gateResult.error_code}\`)`,
        "",
        `- **Code d'erreur** : \`${gateResult.error_code}\``,
        `- **Raison** : ${gateResult.error_message}`,
        "- **Action requise** : Corrigez le découpage ou les dépendances circulaires puis relancez `/epure to-spec`."
      ].join("\n"),
      {
        phase: "suspended",
        status: "suspended",
        issueNumber
      }
    );

    await gh.postIssueComment(issueNumber, escalationComment);

    return {
      executed: true,
      phase: suspended.state.phase,
      status: suspended.state.status,
      active_branch: planBranch,
      summary_markdown: escalationComment,
      created_ticket_numbers: [],
      feature_pr_url: ""
    };
  }

  const allTargetFiles = bundle.tickets.flatMap(
    (t) => t.files_to_create_or_update
  );
  const touchesFrontendUi = allTargetFiles.some((f) =>
    /\.(?:tsx|jsx|css|scss|html)$/i.test(f)
  );

  const impeccableSession = planImpeccableDesignSession({
    issueNumber,
    surfaceSlug: planSlug,
    touchesFrontendUi,
    alreadyAnsweredTopics: ["theme", "layout"],
    candidateDesignTopics: ["theme", "layout", "accessibility"]
  });

  const designGate = touchesFrontendUi
    ? await runUserAdvocateDesignGate({
        repository,
        planTitle: issue.title,
        glossaryMarkdown: bundle.glossary_markdown,
        specMarkdown: bundle.spec_markdown,
        llmApiKey,
        model: phaseModels.reviewModel,
        providers: phaseModels.providers,
        maxTransientRetries: phaseModels.maxTransientRetries,
        transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
        requestTimeoutMs: phaseModels.requestTimeoutMs,
        onTransientRetriesUsed,
        fetchImpl
      })
    : null;

  const plannedStack = detectRepositoryStack({
    targetFilesHint: allTargetFiles
  });
  const adaptedRoster = adaptReviewerRosterForDomain({
    repository,
    planTitle: issue.title,
    glossaryMarkdown: bundle.glossary_markdown,
    specMarkdown: bundle.spec_markdown,
    touchesFrontendUi,
    stackKind: plannedStack.kind,
    personas: designGate?.personas,
    domainInvariants: designGate?.domain_invariants
  });

  const zizmorFile = buildZizmorConfigYaml();
  const renovateFile = buildRenovateConfigJson(plannedStack);
  const ciFile = buildStackAwareCiWorkflowYaml({
    pinnedSha: "main",
    stack: plannedStack
  });

  const existingBaseRoster = await gh.readTrustedBaseRosterFiles("dev");
  const hasExistingConfiguredRoster = existingBaseRoster.size > 0;

  const corePlanningDocs: Array<{ path: string; content: string }> = [
    ...(bundle.glossary_markdown.trim().length > 0
      ? [{ path: "GLOSSARY.md", content: bundle.glossary_markdown }]
      : []),
    { path: bundle.spec_path, content: bundle.spec_markdown },
    ...bundle.adrs.map((a) => ({ path: a.path, content: a.content }))
  ];

  const planningFiles: Array<{ path: string; content: string }> =
    hasExistingConfiguredRoster
      ? corePlanningDocs
      : [
          ...corePlanningDocs,
          ...adaptedRoster.files,
          zizmorFile,
          renovateFile,
          ciFile
        ];

  if (!existingSpecOnPlanBranch || existingSpecOnPlanBranch.trim().length === 0) {
    await gh.commitFilesToBranch({
      branch: planBranch,
      fromBranch: "dev",
      commitMessage: `docs(plan): generate GLOSSARY, ADRs, spec, DESIGN.md, and adapted reviewer roster for #${issueNumber}`,
      files: planningFiles
    });
  }

  await gh.ensureLabel(
    "ready-for-agent",
    "0E8A16",
    "Ticket ready for autonomous EPURE agent execution"
  );

  const indexToIssueNumber = new Map<number, number>();
  const createdTicketsManifest: Array<{
    ticketIssueNumber: number;
    slug: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    blockedByIssueNumbers: number[];
    filesToTouch: string[];
  }> = [];

  for (const ticket of bundle.tickets) {
    const blockerNumbers = ticket.blocked_by_indices
      .map((idx) => indexToIssueNumber.get(idx))
      .filter((n): n is number => typeof n === "number");

    const depLines =
      blockerNumbers.length > 0
        ? blockerNumbers.map((n) => `blocked_by: #${n}`).join("\n")
        : "blocked_by: none";

    const ticketTouchesUi = ticket.files_to_create_or_update.some((f) =>
      /\.(?:tsx|jsx|css|scss|html)$/i.test(f)
    );
    const enrichedAcceptanceCriteria = [
      ...ticket.acceptance_criteria,
      ...(ticketTouchesUi && designGate
        ? designGate.ux_acceptance_criteria
        : [])
    ];

    const ticketBody = appendEpureCommandsSpoiler(
      [
        `Parent Plan: #${issueNumber}`,
        depLines,
        "",
        "## Description",
        ticket.description,
        "",
        "## Acceptance Criteria (TDD & UX)",
        ...enrichedAcceptanceCriteria.map((c) => `- [ ] ${c}`),
        "",
        "## Target Files",
        ...ticket.files_to_create_or_update.map((f) => `- \`${f}\``)
      ].join("\n"),
      {
        phase: "tickets",
        status: "awaiting-human",
        issueNumber
      }
    );

    const createdIssue = await gh.createIssue({
      title: ticket.title,
      body: ticketBody,
      labels: ["ready-for-agent"]
    });

    indexToIssueNumber.set(ticket.index, createdIssue.number);
    createdTicketsManifest.push({
      ticketIssueNumber: createdIssue.number,
      slug: ticket.slug,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: enrichedAcceptanceCriteria,
      blockedByIssueNumbers: blockerNumbers,
      filesToTouch: [...ticket.files_to_create_or_update]
    });
  }

  const updated = await updateIssueStateWithCas({
    issueNumber,
    store,
    mutator: (prev) => ({
      ...prev,
      phase: "tickets",
      status: "awaiting_human_approval",
      active_branch: planBranch,
      last_processed_comment_id: commentId ?? prev.last_processed_comment_id
    })
  });

  const ticketLines = createdTicketsManifest.map((t) => {
    const blockedText =
      t.blockedByIssueNumbers.length > 0
        ? ` (blocked_by: ${t.blockedByIssueNumbers.map((n) => `#${n}`).join(", ")})`
        : " (ready — root)";
    return `- **#${t.ticketIssueNumber}** — ${t.title}${blockedText}`;
  });

  const manifestComment = appendEpureCommandsSpoiler(
    [
      updated.issue_mirror_markdown,
      "",
      `### Spécification, Roster Adapté et Graphe de Tickets générés sur \`${planBranch}\``,
      "",
      "- **Glossaire** : `GLOSSARY.md`",
      `- **ADRs** : ${bundle.adrs.map((a) => `\`${a.path}\``).join(", ")}`,
      `- **Spécification** : \`${bundle.spec_path}\``,
      `- **Roster Multi-Agents adapté** : \`.cursor/agents/*.md\` (${adaptedRoster.files.length} fichiers)`,
      ...(impeccableSession.impeccable_invoked
        ? [
            "- **Design Gate Impeccable & `user-advocate` (`design-gate`)** : `DESIGN.md` généré et critères UX injectés dans les tickets UI"
          ]
        : []),
      "",
      "#### Graphe de Tickets (`ready-for-agent`) :",
      ...ticketLines,
      "",
      "👉 **Action requise** : Vérifiez les livrables sur la branche de plan et les tickets ci-dessus, puis postez `/epure approve` sur cette issue pour verrouiller le périmètre et lancer l'implémentation TDD autonome.",
      "",
      `<!-- epure-plan-manifest:${JSON.stringify({
        planBranch,
        specPath: bundle.spec_path,
        tickets: createdTicketsManifest
      })} -->`
    ].join("\n"),
    {
      phase: "tickets",
      status: "awaiting-human",
      issueNumber
    }
  );

  await gh.postIssueComment(issueNumber, manifestComment);

  return {
    executed: true,
    phase: updated.state.phase,
    status: updated.state.status,
    active_branch: planBranch,
    summary_markdown: manifestComment,
    created_ticket_numbers: createdTicketsManifest.map(
      (t) => t.ticketIssueNumber
    ),
    feature_pr_url: ""
  };
}
