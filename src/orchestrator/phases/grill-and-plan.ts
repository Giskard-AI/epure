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
  GRILL_ROUND_EVALUATION_SCHEMA,
  type GeneratedPlanningBundle,
  type GitHubRestHelper,
  type GrillRoundEvaluation,
  type IssueCommentRecord,
  type IssueMetadata,
  type OrchestrateIssueResult,
  type ResolvedPhaseModels
} from "../types.js";
import { buildRepoExplorationToolsAndHandlers } from "../workspace/repo-tools.js";

export async function runGrillAndPlanPhase(params: {
  readonly command: "plan" | "reply" | "to-spec" | "to-tickets";
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
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<OrchestrateIssueResult> {
  const {
    command,
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
    fetchImpl
  } = params;

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

  if (command === "reply") {
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
          "_Réponds directement en commentaire pour poursuivre l'entretien, ou poste `/epure to-spec` pour valider le cadrage et générer la spécification et les tickets._"
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

    // Frontier resolved during a human reply: pause for explicit human validation before /to-spec & /to-tickets
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
        "- Si ce cadrage vous convient, postez **`/epure to-spec`** pour générer le `GLOSSARY.md`, les ADRs, la spécification complète et le graphe de tickets sur `" +
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

  const specSystemInstruction = [
    "Tu es l'architecte EPURE chargé de produire le dossier de spécification complet et le découpage en tickets atomiques TDD.",
    PROMPT_INJECTION_IMMUNITY_CLAUSE,
    "Produis un objet JSON strictement valide (sans markdown autour) respectant exactement ce schéma TypeScript :",
    "{",
    `  "plan_slug": "${planSlug}",`,
    '  "glossary_markdown": "# GLOSSARY\\n\\n...",',
    '  "adrs": [',
    '    { "path": "docs/adr/0001-architecture-et-domaine.md", "content": "---\\nstatus: accepted\\n---\\n# ..." },',
    '    { "path": "docs/adr/0002-formules-et-invariants.md", "content": "---\\nstatus: accepted\\n---\\n# ..." },',
    '    { "path": "docs/adr/0003-strategie-tdd-et-ui.md", "content": "---\\nstatus: accepted\\n---\\n# ..." }',
    "  ],",
    `  "spec_path": "docs/specs/${planSlug}.md",`,
    '  "spec_markdown": "# Spécification — ...",',
    '  "tickets": [',
    "    {",
    '      "index": 1,',
    '      "slug": "socle-domaine-et-formules",',
    '      "title": "[Ticket 1] Socle du domaine, types et formules mathématiques",',
    '      "description": "Implémenter en TypeScript strict les types et les formules métier avec tests unitaires Vitest paramétrés.",',
    '      "acceptance_criteria": ["Formule quadratique exacte", "Invariant S <= B", "Règle munitions /50"],',
    '      "blocked_by_indices": [],',
    '      "files_to_create_or_update": ["package.json", "tsconfig.json", "vite.config.ts", "src/domain/forge.ts", "tests/forge.test.ts"]',
    "    },",
    "    {",
    '      "index": 2,',
    '      "slug": "catalogue-et-marche-d20",',
    '      "title": "[Ticket 2] Catalogue d\'enchantements, marché d20 et complications",',
    '      "description": "Implémenter le catalogue complet des enchantements, les tables de marché d20 et les complications narratives avec tests Vitest.",',
    '      "acceptance_criteria": ["Catalogue armes, armures, boucliers, focus", "Table de disponibilité et prix d20", "Tests unitaires paramétrés"],',
    '      "blocked_by_indices": [1],',
    '      "files_to_create_or_update": ["src/domain/catalog.ts", "src/domain/market.ts", "tests/market.test.ts"]',
    "    },",
    "    {",
    '      "index": 3,',
    '      "slug": "interface-react-craft-calculator",',
    '      "title": "[Ticket 3] Interface interactive React du calculateur et persistance locale",',
    '      "description": "Construire l\'application React/Vite complète (calculateur de forge, simulateur de marché, grimoire du MJ, sauvegarde localStorage) et vérifier le build.",',
    '      "acceptance_criteria": ["Calculateur interactif avec garde-fou S <= B", "Simulateur de marché d20", "Build Vite et suite de tests Vitest 100% verts"],',
    '      "blocked_by_indices": [1, 2],',
    '      "files_to_create_or_update": ["index.html", "src/main.tsx", "src/App.tsx", "src/styles.css", "tests/app.test.ts"]',
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

  const bundle = await callGeminiJson<GeneratedPlanningBundle>({
    apiKey: llmApiKey,
    model: phaseModels.planningModel,
    providers: phaseModels.providers,
    maxTransientRetries: phaseModels.maxTransientRetries,
    transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
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

  const planningFiles: Array<{ path: string; content: string }> =
    hasExistingConfiguredRoster
      ? [{ path: bundle.spec_path, content: bundle.spec_markdown }]
      : [
          { path: "GLOSSARY.md", content: bundle.glossary_markdown },
          { path: bundle.spec_path, content: bundle.spec_markdown },
          ...bundle.adrs.map((a) => ({ path: a.path, content: a.content })),
          ...adaptedRoster.files,
          zizmorFile,
          renovateFile,
          ciFile
        ];

  await gh.commitFilesToBranch({
    branch: planBranch,
    fromBranch: "dev",
    commitMessage: `docs(plan): generate GLOSSARY, ADRs, spec, DESIGN.md, and adapted reviewer roster for #${issueNumber}`,
    files: planningFiles
  });

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
