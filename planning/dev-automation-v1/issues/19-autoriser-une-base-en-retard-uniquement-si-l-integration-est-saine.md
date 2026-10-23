# 19: Autoriser une base en retard uniquement si l’intégration est saine

**What to build:** Un dépôt règle son mode strict ou relaxed et obtient un résultat de merge prévisible pour une PR dont la branche cible a avancé.

**Blocked by:** 18 — Merger automatiquement un ticket ordinaire sans course

**Status:** ready-for-agent

- [ ] Strict exige une actualisation de la branche et de ses validations selon la protection configurée.
- [ ] Relaxed conserve la review du code inchangé si son SHA/diff reste valide, mais teste le résultat combiné avec la cible actuelle.
- [ ] L’absence de conflit textuel sans checks combinés verts ne permet jamais un merge automatique.

**Traçabilité :** user stories US-57, US-58 ; tests T-13.
