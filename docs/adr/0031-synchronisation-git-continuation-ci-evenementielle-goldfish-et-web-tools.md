---
status: accepted
---
# ADR-0031 : Synchronisation Git inter-branches, continuation CI événementielle, audit Goldfish zéro-contexte, outils Web confinés et ASD-STE100 Controlled Technical Prompting

- **Statut** : Accepté
- **Date** : 2026-10-29
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0001, ADR-0004, ADR-0007, ADR-0012, ADR-0014, ADR-0024, ADR-0027, ADR-0028, ADR-0030

## Contexte

L'exploitation d'`EPURE` sur plusieurs **Issues de pilotage** exécutées en parallèle a mis en évidence quatre limites architecturales :

1. **Collisions sur `plan/* -> dev` et dérive des branches `feature/*` / `task/*`** :
   - Lors de `/epure approve`, l'ouverture et la fusion immédiate d'une Pull Request `plan/<issue>-* -> dev` se heurtent au Ruleset `epure-dev-governance` (checks CI obligatoires sur `dev`) ainsi qu'aux modifications concurrentes de `GLOSSARY.md` et à l'attribution concurrente d'un même numéro d'ADR (`docs/adr/NNNN-*.md`) par une autre issue fusionnée entre-temps.
   - En outre, `ensureBranch` retournait le SHA existant de `feature/*` ou `task/*` sans jamais synchroniser la branche avec l'avancement de `dev`, et aucune commande (`/epure sync` / `/epure rebase`) ne permettait de forcer ce rattrapage ni de résoudre automatiquement les conflits Git.
2. **Monopolisation du runner GitHub Actions pendant l'attente de la CI externe (`timeout-minutes: 60`)** :
   - L'exécution de la CI externe (`ci.yml`) est indispensable sur **tous les sous-tickets (`task/* -> feature/*`)** ainsi que sur la **PR finale (`feature/* -> dev`)**. Cependant, attendre la fin de chaque CI externe par un polling synchrone (`while (true) { sleep }`) dans un unique job monolithique `orchestrate-command` immobilise un runner pendant 10 à 15 minutes par ticket et provoque l'annulation du job à 60 minutes dès qu'une fonctionnalité dépasse 3 ou 4 tickets.
3. **Biais de confirmation de l'Éléphant lors de `/epure to-spec` et lacunes de réutilisation du code** :
   - Dans `/epure to-spec`, la spécification est rédigée par le modèle disposant de tout l'historique de conversation du grill ("l'Éléphant"). Sans relecture par un agent vierge de cet historique ("le Poisson Rouge" / *Goldfish* du modèle Google Elephant-Goldfish), des hypothèses implicites discutées en commentaire sont omises du document `docs/specs/<slug>.md`.
   - Par ailleurs, les règles anti-slop existantes (ADR-0030) devaient être complétées par l'échelle de priorité de réutilisation, la règle de portée complète (*Caller-Reach*) et le plancher de sécurité inconditionnel (*Safety Floor*) issus des benchmarks **Ponytail 5**.
4. **Absence d'outils d'exploration Web publics et gratuits** :
   - Lors du cadrage (`/epure plan`), de la rédaction de spécification (`/epure to-spec`) et de l'implémentation TDD, l'agent ne pouvait pas vérifier la documentation officielle d'une API ou les métadonnées d'un registre de paquets (`npm`, `PyPI`, `crates.io`, GitHub) en temps réel.

## Décisions

### 1. Intégration directe `plan/* -> feature/*`, synchronisation Git (`syncBranchWithBase` / `/epure sync`) et résolution 3-way assistée par LLM

- Nous supprimons la Pull Request intermédiaire `plan/<issue>-* -> dev` lors de `/epure approve` (et fermons toute ancienne PR `plan/* -> dev` restée ouverte). Les artefacts approuvés de `plan/<issue>-*` sont intégrés directement dans `feature/<issue>-*` initialisée sur le `HEAD` courant de `dev` :
  - **Fusion additive déterministe de `GLOSSARY.md` (`mergeGlossaryMarkdownAdditively`)** : préserve 100 % des termes présents sur `dev` et insère ou met à jour les termes définis sur `plan/*`.
  - **Renumérotation automatique des ADRs en collision (`renumberCollidingAdrs`)** : si un fichier `docs/adr/NNNN-<slug>.md` de `plan/*` entre en collision de numéro `NNNN` avec un ADR distinct déjà présent sur `dev`, il est automatiquement renuméroté en `max(dev) + 1` et les références correspondantes dans `docs/specs/<slug>.md` sont mises à jour.
- L'orchestrateur synchronise automatiquement `feature/*` avec `dev` (et `task/*` avec `feature/*`) via `syncBranchWithBase` avant chaque ticket et avant l'ouverture/validation de la PR finale `feature/* -> dev`.
- Les nouvelles commandes **`/epure sync`** et **`/epure rebase`** (normalisées vers `command: "sync"`) permettent à tout contributeur autorisé (`write` ou `admin`) de déclencher à tout moment ce rattrapage depuis `dev`.
- En cas de conflit Git (`409 Conflict` sur `POST /repos/{owner}/{repo}/merges`) :
  - Si un fichier en conflit touche un chemin sensible (`.github/workflows/**`, `<reviewers_dir>/**` (`.agents/reviewers/**` par défaut), `.github/agents.yml`, `.env*`) ou si plus de 8 fichiers de code sont en conflit, l'orchestrateur escalade immédiatement en `needs-human`.
  - Sinon, `GLOSSARY.md` est fusionné additivement et le modèle d'implémentation résout les fichiers en conflit à partir des trois versions (`base`, `ours`, `theirs`). L'arbre résultant est obligatoirement vérifié dans le **Sandbox Stage 1** (`runTestsInIsolatedWorkspace`) avant commit ; tout échec Stage 1 déclenche une escalade `needs-human`.

### 2. Machine à états événementielle avec relâchement du runner (`waiting_ticket_ci` / `waiting_feature_ci` + `continue`)

- La CI externe s'exécute sur **toutes** les sous-PRs `task/* -> feature/*` ainsi que sur la PR finale `feature/* -> dev`.
- Le schéma `EpureIssueState` (`refs/epure/state/<issue>`) est étendu avec :
  - `subphase?: "idle" | "implementing_ticket" | "waiting_ticket_ci" | "remediating_ticket" | "waiting_feature_ci" | "remediating_feature"`
  - `active_ticket_number?: number`, `active_task_branch?: string`, `active_pr_number?: number`, `active_head_sha?: string`.
- Lorsque le mode événementiel (`asyncCiContinuation`) est actif et que des workflows CI externes sont attendus sur une PR nouvellement ouverte ou mise à jour :
  - Dès que `ai-review` (et `impeccable-gate` si UI) est publié sur le `head_sha`, l'orchestrateur persiste `subphase: "waiting_ticket_ci"` (ou `"waiting_feature_ci"`) dans `refs/epure/state/<issue>` et **termine immédiatement le job (`exit 0`)**, libérant le runner GitHub Actions.
- Le workflow `.github/workflows/epure-issue-command.yml` écoute `check_suite: types: [completed]` et `workflow_run: { workflows: ["CI"], types: [completed] }` (et supporte la commande manuelle de secours `/epure continue`) pour invoquer l'orchestrateur avec `command: "continue"` :
  - L'orchestrateur retrouve l'issue correspondante via `listIssueStates()` (`active_head_sha` / `active_task_branch` / `active_branch`).
  - Si des workflows CI externes attendus sur `active_head_sha` sont encore en cours (`queued` / `in_progress`), le job quitte immédiatement (`exit 0`).
  - Lorsque tous les workflows CI externes du SHA sont terminés :
    - Si la CI externe et `ai-review` sont verts : il squash-merge la sous-PR `task/* -> feature/*`, clôt le ticket, synchronise `feature/*` avec `dev` et enchaîne immédiatement le ticket suivant dans le même run (ou finalise la PR `feature/* -> dev` en `phase: "review", status: "awaiting_human_approval"`).
    - Si la CI externe ou `ai-review` est en échec : sous réserve du budget `max_code_fix_attempts = 3`, il exécute un round de remédiation unifié, pousse le nouveau SHA, met à jour `active_head_sha` et relâche à nouveau le runner.

### 3. Intégration de Ponytail 5 et de l'Auditeur de Spécification Goldfish zéro-contexte (Google EGM)

- `EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT` (`src/orchestrator/prompts/code-discipline.ts`) et le prompt de `standards-reviewer` (`src/review/reviewer-roster.ts`) intègrent les trois principes **Ponytail 5** :
  1. Échelle de réutilisation prioritaire (code existant du dépôt -> stdlib/plateforme -> dépendance installée -> code minimal lisible).
  2. Portée complète (*Caller-Reach*) mettant à jour tous les appelants, tests et exports impactés dans le même diff.
  3. Plancher de sécurité inconditionnel (*Safety Floor*) interdisant toute suppression de validation aux frontières de confiance, de gestion d'erreurs critique, de sécurité ou d'accessibilité.
- Lors de `/epure to-spec` (`src/orchestrator/phases/grill-and-plan.ts`), le brouillon généré par l'Éléphant est systématiquement soumis à `runGoldfishSpecAudit` : un appel LLM isolé **zéro-contexte** (sans l'historique des commentaires du grill) qui vérifie l'auto-suffisance documentaire, le *Zoom-Out / YAGNI* et l'*Implementation Readiness*. Si des lacunes sont détectées (`!passed`), l'Éléphant amende automatiquement la spécification avant commit sur `plan/*`.

### 4. Outils d'exploration Web gratuits sans clé API et confinés anti-SSRF (`web_search` & `web_fetch`)

- Le module `src/orchestrator/workspace/web-tools.ts` fournit `web_search` et `web_fetch` sans aucune clé API payante tierce, en interrogeant des sources publiques gratuites (`DuckDuckGo HTML Lite`, `GitHub Search API`, `registry.npmjs.org`, `pypi.org`, `crates.io`, `MediaWiki`).
- Garde-fous de sécurité impératifs :
  - Protocole `https:` sur le port `443` exclusivement.
  - Filtrage anti-SSRF (`validatePublicHttpsUrlForWebTool`) bloquant `localhost`, `.local`, `.internal`, toutes les plages IPv4 privées/loopback/link-local/metadata (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`) et IPv6 non globales (`::1`, `fc00::/7`, `fe80::/10`), y compris à chaque redirection HTTP (`redirect: "manual"`, max 3 sauts).
  - Aucun secret ou en-tête `Authorization` transmis à des domaines tiers ; nettoyage HTML (`<script>`, `<style>`) et troncature à `16 Ko` encapsulée dans `wrapUntrustedContent("untrusted_web_content", ...)`.
  - Exposition limitée aux phases configurées (`plan`, `spec`, `implementation`), jamais pendant la revue multi-agents.

### 5. Norme de Rédaction Technique Contrôlée (`ASD-STE100 Controlled Technical Prompting`)

- Nous adoptons la recommandation d'Andrej Karpathy d'appliquer les principes de l'**ASD-STE100** (*AeroSpace and Defence Simplified Technical English*) aux spécifications (`docs/specs/*.md`), aux ADRs (`docs/adr/*.md`), aux critères d'acceptation des tickets et aux prompts système (`src/orchestrator/prompts/code-discipline.ts`, `src/orchestrator/phases/grill-and-plan.ts`, `src/review/reviewer-roster.ts`) :
  1. **Vocabulaire bijectif (`1 concept = 1 terme` de `GLOSSARY.md`)** : utilisation exclusive du terme canonique défini dans `GLOSSARY.md` et interdiction stricte des synonymes listés sous `_Avoid_`.
  2. **Voix active avec acteur explicite (`Sujet-Verbe-Objet`)** : chaque phrase nomme explicitement le module, la fonction ou l'acteur qui exécute l'action.
  3. **Atomicité procédurale (`1 phrase = 1 action`)** : une seule action observable ou une seule condition testable par phrase (≤ 20 mots pour une instruction procédurale, ≤ 25 mots pour une règle descriptive).
  4. **Conditionnelles déterministes (`WHEN/IF <condition observable>, THEN <acteur> <action>`)** : élimination des modaux flous (`should`, `might`, `if needed`, `if appropriate`, `as necessary`, `correctement`).
  5. **Impératif affirmatif & `Zero-Filler` (`caveman-lite`)** : le mode `caveman-lite` supprime uniquement le remplissage conversationnel (*Zero-Filler*) tout en préservant la structure grammaticale complète Sujet-Verbe-Objet d'ASD-STE100 et les frontières d'`Auto-Clarity`.

## Conséquences

- Plusieurs issues `/epure approve` peuvent s'exécuter concurremment sans conflit bloquant sur `GLOSSARY.md` ou les numéros d'ADR, et `/epure sync` permet à tout moment de rattraper `dev`.
- La consommation de minutes GitHub Actions par l'orchestrateur chute de ~85 % tout en conservant l'exécution complète de la CI externe sur chaque sous-ticket `task/*` et sur `feature/*`.
- Les spécifications validées sur `plan/*` sont auto-suffisantes pour un lecteur ou agent sans mémoire de la conversation de cadrage.
