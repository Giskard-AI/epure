# 23: Reprendre une orchestration sans doublon et annuler un plan

**What to build:** Une exécution interrompue entre création d’une ressource GitHub et enregistrement d’état reprend sans duplicata ; une annulation coupe les nouveaux effets de bord.

**Blocked by:** 22 — Libérer les tickets dépendants sur résolution prouvée

**Status:** ready-for-agent

- [ ] Des retries identiques n’ouvrent pas deux fois la même issue, PR ou publication.
- [ ] Après perte d’événement ou échec de job, l’état observable est reconstruit depuis GitHub.
- [ ] L’annulation refuse les publications et merges ultérieurs, même si un ancien job se termine plus tard.
- [ ] Les branches, issues et traces existantes restent disponibles pour audit ou reprise explicite.

**Traçabilité :** user stories US-73, US-74, US-76, US-77 ; tests T-18, T-19.
