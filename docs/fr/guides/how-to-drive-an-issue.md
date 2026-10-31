# Guide : Piloter une Issue de Bout en Bout

Ce guide fournit la marche à suivre opérationnelle pour piloter une fonctionnalité ou une correction complexe depuis l'ouverture de l'Issue GitHub jusqu'à la PR finale `feature/* -> dev`, y compris l'utilisation des commandes facultatives et la reprise sur incident.

---

## 1. Lancer le Plan (`/epure plan`)

<ArchifyDiagram
  slug="epure-user-journey"
  locale="fr"
  title="Parcours Utilisateur EPURE : Piloter une Issue de l'Idée au Merge Final"
  caption="Parcours complet sur 4 pistes : 1. Ce que je fais -> 2. Ce qui se passe derrière -> 3. Quand je dois réagir -> 4. Boucles Autofix, Conflits & Pilotage."
/>

1. Ouvrez une Issue GitHub décrivant l'objectif, le besoin utilisateur ou le périmètre souhaité.
2. Postez `/epure plan` en commentaire.
3. Patientez quelques secondes pendant que le workflow `epure-issue-command` publie la **Ronde 1 du Grill**.

### Bonnes Pratiques pour Répondre au Grill

- **Répondez en Markdown ordinaire** : inutile de répéter `/epure` tant que l'issue est en phase `grilling`.
- **Plusieurs commentaires successifs sont supportés** : grâce au curseur de lot (`last_processed_comment_id`), si vous ajoutez un second commentaire de précision pendant qu'un run est en file d'attente, EPURE traitera tous vos commentaires dans l'ordre chronologique.
- **Forcer le passage à la Spec (Facultatif)** : si vous estimez le cadrage suffisant et souhaitez générer immédiatement la spécification, commentez `/epure to-spec`.

---

## 2. Générer & Valider la Spécification (`/epure to-spec` & `/epure to-tickets`)

Dès que la frontière de décisions du Grill est résolue (`frontier_resolved: true`), EPURE publie la **Synthèse des Décisions** et attend votre validation (`grilling` / `awaiting_human_approval`).

1. **Générer la Spécification (`/epure to-spec`)** : commentez `/epure to-spec` pour exécuter l'**Audit de Spécification Goldfish zéro-contexte** (`runGoldfishSpecAudit`) et commiter `GLOSSARY.md`, `docs/adr/NNNN-*.md`, `DESIGN.md` (si une UI est concernée) et `docs/specs/<slug>.md` (incluant `EpicGoalContract`) sur `plan/<issue>-<slug>`. L'issue passe en phase `spec` (`awaiting_human_approval`).
2. **Réviser ou Valider la Spécification** :
   - Inspectez `GLOSSARY.md`, `docs/adr/` et `docs/specs/<slug>.md` sur `plan/<issue>-<slug>`.
   - Pour demander un ajustement ou une précision sur la spécification avant la création des tickets, **répondez directement en commentaire** (sans commande slash).
3. **Générer le Graphe de Tickets (`/epure to-tickets`)** : une fois la spécification validée, commentez `/epure to-tickets`. EPURE découpe la spécification en un graphe acyclique (DAG) de sous-issues GitHub (`blocked_by`, `ready-for-agent`), câble nativement les relations GitHub `sub_issues` et `dependencies/blocked_by`, et passe en phase `tickets` (`awaiting_human_approval`) en attente de `/epure approve`.

---

## 3. Approuver, Continuation CI Événementielle & Synchronisation (`/epure approve`, `/epure status` & `/epure sync`)

Postez `/epure approve` sur l'issue de pilotage pour intégrer directement les artefacts de `plan/*` dans `feature/<issue>-<slug>`, sceller `spec_sha` et démarrer l'exécution du DAG de tickets.

- **Attente Événementielle de la CI Externe (`waiting_ticket_ci` / `waiting_feature_ci`)** :
  - À chaque ouverture d'une PR `task/* -> feature/*` (`waiting_ticket_ci`) ou de la PR finale `feature/* -> dev` (`waiting_feature_ci`), l'orchestrateur enregistre la PR et le `head_sha` actifs dans `refs/epure/state/<issue>` et termine immédiatement le job (`exit 0`) pour libérer le runner GitHub Actions (`async_ci_continuation: true`).
  - Dès que les workflows CI externes se terminent (`check_suite.completed` ou `workflow_run.completed`), EPURE se réveille automatiquement pour exécuter la revue multi-agents Stage 3, le squash sémantique IA ou un round d'auto-remédiation. Vous pouvez également relancer manuellement la continuation à tout moment en commentant **`/epure continue`**.
- **Synchroniser avec `dev` (`/epure sync` / `/epure rebase`)** :
  - Si d'autres PRs sont fusionnées sur `dev` pendant le développement de votre fonctionnalité, commentez **`/epure sync`** (ou `/epure rebase`). EPURE synchronise `dev -> feature/<issue>-<slug>` (et propage `feature/* -> active_task_branch`) avec fusion additive de `GLOSSARY.md`, renumérotation monotone des ADRs, résolution de conflits 3-way assistée par LLM et validation obligatoire dans le **Sandbox Noyau Stage 1** avant commit.
- **Suivre l'Avancement (`/epure status`)** :
  - Commentez `/epure status` ou consultez le **Tableau de Bord EPURE** épinglé en haut du corps de l'issue.
  - Dans les journaux GitHub Actions du job, dépliez les groupes structurés `::group::` pour inspecter la sortie des tests/builds du Sandbox Stage 1, les appels d'outils en lecture seule (`read_file`, `search_code`) et le verdict de chaque reviewer (`approved` vs `changes_requested`).

---

## 4. Gérer une Escalade `needs-human`, `/epure continue` & les Tickets de Convergence Phase 2

EPURE interrompt l'automatisation et pose le label `needs-human` (`status: "suspended"`) lorsqu'une décision humaine est requise :

1. **Modification d'un Chemin Sensible** : une branche `task/*` a modifié `.github/workflows/**`, `.github/agents.yml`, `.cursor/agents/**` ou `CODEOWNERS`.
   - *Résolution* : inspectez le diff. Si la modification est légitime, ajoutez le label `approved-sensitive-change` sur la PR puis commentez **`/epure continue`** (ou `/epure approve`) sur l'issue de pilotage.
2. **Plafond d'Auto-Remédiation Atteint (`max_code_fix_attempts = 3`)** : un ticket a échoué aux tests Stage 1, à la CI externe ou aux constats `must_fix` 3 fois consécutives.
   - *Résolution* : poussez un commit de correction sur la branche `task/*` ou `feature/*` (ou publiez une précision en commentaire), puis commentez **`/epure continue`** sur l'issue de pilotage. EPURE retire le label `needs-human`, restaure `status: "active"`, ignore les tickets déjà fermés et reprend exactement au dernier jalon validé.
3. **Audit de Convergence Zéro-Contexte (`EpicConvergenceAudit`) & Tickets Automatiques de Phase 2 (`max_epic_phases`)** :
   - Une fois tous les tickets de Phase 1 fusionnés dans `feature/*`, EPURE exécute un **`EpicConvergenceAudit` zéro-contexte** (`runEpicConvergenceAudit`) face à l'`EpicGoalContract` de la spécification.
   - Si l'audit détecte des `required_entrypoints` non câblés ou des `forbidden_stubs` résiduels (`verdict: "INCOMPLETE"`) et que `epic_phase < max_epic_phases` (`2` par défaut), EPURE génère, chaîne et exécute automatiquement des tickets correctifs **`[Phase 2 - Ticket N]`** avant d'ouvrir la PR finale `feature/* -> dev`. Si un écart subsiste après `max_epic_phases`, EPURE escalade en `needs-human` (`epic_convergence_exhausted`), d'où vous pouvez pousser un correctif et commenter **`/epure continue`**.
