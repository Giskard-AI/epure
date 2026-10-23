# 10: Traiter les commentaires dans l’ordre une fois chacun

**What to build:** Sur une issue très active, plusieurs commentaires successifs ou événements GitHub répétés sont traités dans l’ordre sans perte ni écriture concurrente grâce à `concurrency: issue-<N>` et au rattrapage séquentiel en lot depuis le curseur `last_processed_comment_id` stocké dans `refs/epure/state/<issue-number>`.

**Blocked by:** 09 — Reprendre une conversation GitHub depuis un état versionné

**Status:** ready-for-agent

- [ ] Trois commentaires rapides produisent un rattrapage séquentiel complet depuis `last_processed_comment_id` dans l’ordre logique de l’issue, même si GitHub Actions fusionne la file d'attente.
- [ ] Un événement rediffusé ne crée ni nouvelle réponse ni nouvel effet de bord.
- [ ] L’édition d’un ancien commentaire n’altère pas silencieusement des décisions déjà prises.
- [ ] Des entretiens sur des issues différentes restent exécutables en parallèle.

**Traçabilité :** user stories US-21, US-22 ; tests T-4 ; ADR-0013, ADR-0024.
