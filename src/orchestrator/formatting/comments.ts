/**
 * Context used to tailor the collapsible `/epure` command cheat-sheet spoiler
 * appended at the bottom of EPURE issue comments, sub-issues, and pull requests.
 */
export interface EpureCommandSpoilerContext {
  readonly phase?:
    | "grilling"
    | "spec"
    | "tickets"
    | "implementation"
    | "suspended"
    | "cancelled"
    | "completed"
    | string
    | undefined;
  readonly status?:
    | "active"
    | "awaiting-human"
    | "suspended"
    | "cancelled"
    | "completed"
    | string
    | undefined;
  readonly issueNumber?: number | undefined;
}

const EPURE_COMMANDS_SPOILER_SUMMARY =
  '<summary>⌨️ <b>Commandes <code>/epure</code> disponibles</b> (cliquer pour dérouler)</summary>';

function buildContextualActionHint(
  context?: EpureCommandSpoilerContext
): string {
  const phase = (context?.phase ?? "").trim().toLowerCase();
  const status = (context?.status ?? "").trim().toLowerCase();
  const issueRef =
    typeof context?.issueNumber === "number" && context.issueNumber > 0
      ? ` sur l'issue #${context.issueNumber}`
      : "";

  if (status === "suspended" || phase === "suspended") {
    return `Inspectez le diagnostic ci-dessus, poussez un correctif si nécessaire, puis postez \`/epure continue\` (ou \`/epure approve\`, ou \`/epure sync\` / \`/epure rebase\` en cas de conflit Git)${issueRef} pour reprendre l'exécution (ou \`/epure cancel\` pour l'arrêter).`;
  }

  if (status === "cancelled" || phase === "cancelled") {
    return `L'orchestration est suspendue suite à une annulation. Postez \`/epure plan\`${issueRef} pour relancer un cadrage ou \`/epure continue\` (ou \`/epure approve\`) pour reprendre.`;
  }

  if (phase === "grilling") {
    if (
      status === "awaiting-human" ||
      status === "awaiting_human_approval"
    ) {
      return `La frontière de décisions du cadrage est complète. Postez \`/epure to-spec\`${issueRef} pour valider le cadrage et générer la spécification sur \`plan/*\` (ou répondez en commentaire pour ajuster un point).`;
    }
    return `Répondez directement en commentaire${issueRef} aux questions ci-dessus (sans préfixe \`/epure\`), ou postez \`/epure to-spec\` pour générer immédiatement la spécification sur \`plan/*\`.`;
  }

  if (phase === "spec") {
    return `Vérifiez la spécification, le \`GLOSSARY.md\` et les ADRs générés sur \`plan/*\`. Postez \`/epure to-tickets\`${issueRef} pour valider la spécification et générer le graphe de tickets (ou répondez en commentaire pour demander une modification de la spec).`;
  }

  if (
    phase === "tickets" ||
    status === "awaiting-human" ||
    status === "awaiting_human_approval"
  ) {
    return `Vérifiez la spécification et le graphe de tickets générés, puis postez \`/epure approve\`${issueRef} pour lancer l'implémentation TDD autonome (intégration directe \`plan/* -> feature/*\`).`;
  }

  if (phase === "implementation") {
    return `L'implémentation autonome est en cours. Postez \`/epure status\`${issueRef} pour suivre l'avancement, \`/epure continue\` pour reprendre après la CI externe, \`/epure sync\` (\`/epure rebase\`) pour rattraper \`dev\`, ou \`/epure cancel\` pour interrompre l'orchestration.`;
  }

  if (
    phase === "completed" ||
    status === "completed" ||
    status === "done"
  ) {
    return `Vérifiez et fusionnez (Squash & Merge) la Pull Request finale \`feature/* → dev\` dans l'interface GitHub.`;
  }

  return `Postez \`/epure plan\`${issueRef} pour démarrer le cadrage ou \`/epure status\` pour consulter l'état courant.`;
}

/**
 * Formats the collapsible `<details>` `/epure` command cheat-sheet block
 * with a phase-aware next-action recommendation.
 */
export function formatEpureCommandsSpoiler(
  context?: EpureCommandSpoilerContext
): string {
  const hint = buildContextualActionHint(context);
  return [
    "<details>",
    EPURE_COMMANDS_SPOILER_SUMMARY,
    "",
    "| Commande | Action |",
    "| :--- | :--- |",
    "| `/epure plan` | Démarrer ou relancer le cadrage (`/grill-with-docs`) sur l'issue |",
    "| *Réponse libre en commentaire* | Répondre aux questions du Grill ou demander un ajustement de la spécification (sans préfixe `/epure`) |",
    "| `/epure to-spec` | Valider la frontière du Grill et générer `GLOSSARY.md`, les ADRs et la spécification sur `plan/*` |",
    "| `/epure to-tickets` | Valider la spécification sur `plan/*` et générer le graphe de tickets GitHub (`blocked_by`) |",
    "| `/epure approve` | Approuver le plan (`plan/* -> feature/*`), verrouiller `spec_sha` et lancer l'implémentation |",
    "| `/epure continue` | Reprendre l'orchestration après une suspension `needs-human` ou une attente de CI externe |",
    "| `/epure sync` (ou `/epure rebase`) | Synchroniser `dev -> feature/*` (et `feature/* -> task/*`) avec résolution 3-way assistée + Stage 1 |",
    "| `/epure status` | Afficher l'état d'avancement de l'issue et des tickets |",
    "| `/epure cancel` (ou `/epure stop`) | Suspendre immédiatement l'orchestration et empêcher tout auto-merge |",
    "",
    `> 💡 **Action recommandée** : ${hint}`,
    "",
    "</details>"
  ].join("\n");
}

/**
 * Appends the collapsible `/epure` command cheat-sheet spoiler to `markdown`
 * idempotently (no-op if the spoiler is already present).
 */
export function appendEpureCommandsSpoiler(
  markdown: string,
  context?: EpureCommandSpoilerContext
): string {
  const trimmed = markdown.trimEnd();
  if (trimmed.includes(EPURE_COMMANDS_SPOILER_SUMMARY)) {
    return trimmed;
  }
  const spoiler = formatEpureCommandsSpoiler(context);
  return trimmed.length > 0 ? `${trimmed}\n\n${spoiler}` : spoiler;
}
