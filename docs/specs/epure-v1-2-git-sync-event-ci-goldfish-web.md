# Spécification — Évolutions EPURE v1.2 : Synchronisation Git, Continuation CI Événementielle, Audit Goldfish et Outils Web

- **ADR de référence** : [ADR-0031](../adr/0031-synchronisation-git-continuation-ci-evenementielle-goldfish-et-web-tools.md)
- **Glossaire** : [`GLOSSARY.md`](../../GLOSSARY.md)

## 1. Objectifs et Périmètre

1. **Chantier 1 — Synchronisation Git inter-branches, intégration directe `plan/* -> feature/*`, commande `/epure sync` et résolution de conflits 3-way par LLM** :
   - Supprimer l'ouverture/fusion de la PR intermédiaire `plan/* -> dev` lors de `/epure approve`.
   - Transporter les artefacts de `plan/<issue>-*` directement sur `feature/<issue>-*` avec fusion additive déterministe de `GLOSSARY.md` (`mergeGlossaryMarkdownAdditively`) et renumérotation automatique des ADRs (`renumberCollidingAdrs`).
   - Synchroniser automatiquement `dev -> feature/*` et `feature/* -> task/*` via `syncBranchWithBase`, et exposer la commande explicite `/epure sync` (alias `/epure rebase`).
   - Résoudre les conflits `409` en 3-way via le modèle d'implémentation (jusqu'à 8 fichiers non sensibles) et valider obligatoirement le résultat avec le Sandbox Stage 1 avant commit.
2. **Chantier 2 — Continuation CI événementielle (`waiting_ticket_ci` / `waiting_feature_ci` + `check_suite` / `workflow_run` / `/epure continue`)** :
   - Exécuter la CI externe sur tous les sous-tickets (`task/* -> feature/*`) et sur la branche de fonctionnalité (`feature/* -> dev`).
   - Relâcher immédiatement le runner GitHub Actions (`exit 0`) dès la PR ouverte/mise à jour et `ai-review` publié lorsque l'attente asynchrone est active.
   - Reprendre l'orchestration via `command: "continue"` sur événement `check_suite: [completed]` / `workflow_run: [completed]` ou commande `/epure continue`.
3. **Chantier 3 — Discipline Ponytail 5 et Auditeur de Spécification Goldfish zéro-contexte (Google EGM)** :
   - Enrichir `EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT` et `standards-reviewer` avec l'échelle de réutilisation Ponytail 5, la règle *Caller-Reach* et le *Safety Floor*.
   - Exécuter `runGoldfishSpecAudit` (session zéro-contexte sans l'historique du grill) lors de `/epure to-spec` avec passe d'auto-amendement par l'Éléphant si des lacunes sont détectées.
4. **Chantier 4 — Outils d'exploration Web gratuits sans clé API (`web_search` et `web_fetch`)** :
   - Fournir `web_search` (DuckDuckGo HTML Lite, GitHub Search, npm, PyPI, crates.io, MediaWiki) et `web_fetch` (HTML -> Markdown `16 Ko`) sans clé API tierce.
   - Appliquer un garde-fou anti-SSRF strict (`https://` port 443, blocage de toutes les IPs privées/loopback/link-local/metadata et vérification manuelle des redirections) et encapsuler toute sortie dans `wrapUntrustedContent("untrusted_web_content", ...)`.

## 2. Critères d'Acceptation Vérifiables

- **CA-1** : Lors de `/epure approve`, aucune PR `plan/* -> dev` n'est requise ; les termes ajoutés sur `dev` dans `GLOSSARY.md` sont conservés et fusionnés avec ceux de `plan/*`, et tout ADR `docs/adr/NNNN-*.md` entrant en collision de numéro avec `dev` est renuméroté en `max(dev) + 1` sur `feature/*`.
- **CA-2** : Les commandes `/epure sync` et `/epure rebase` sont autorisées par `evaluateIssueCommandGate` pour les acteurs `write`/`admin` et synchronisent la branche active avec `dev`, en résolvant les conflits 3-way non sensibles via LLM + validation Sandbox Stage 1 (et en escaladant en `needs-human` si un chemin sensible est en conflit ou si Stage 1 échoue).
- **CA-3** : `EpureIssueState` supporte `subphase`, `active_ticket_number`, `active_task_branch`, `active_pr_number` et `active_head_sha`. En mode `asyncCiContinuation: true`, `orchestrateIssueCommand` persiste `waiting_ticket_ci` (ou `waiting_feature_ci`) après publication de `ai-review` et termine immédiatement sans boucler en `sleep`.
- **CA-4** : `command: "continue"` (ainsi que `/epure continue`) résout l'issue en attente par numéro d'issue, SHA ou branche, ignore sans erreur les réveils intermédiaires tant qu'un workflow CI attendu est encore `in_progress`, squash-merge et enchaîne le ticket suivant lorsque la CI et `ai-review` sont verts, ou exécute un round de remédiation unifié lorsque la CI ou `ai-review` échoue.
- **CA-5** : `/epure to-spec` exécute `runGoldfishSpecAudit` sans lui transmettre l'historique des commentaires du grill, et amende automatiquement la spécification lorsque l'auditeur Goldfish signale des lacunes (`passed: false`).
- **CA-6** : `web_search` et `web_fetch` fonctionnent sans clé API tierce, rejettent toute URL non-HTTPS ou visant une IP privée/loopback/metadata (`127.0.0.1`, `10.x`, `172.16.x`, `192.168.x`, `169.254.169.254`, `::1`, `fc00::`, `fe80::`), et encapsulent leurs résultats dans `<untrusted_web_content>`.
