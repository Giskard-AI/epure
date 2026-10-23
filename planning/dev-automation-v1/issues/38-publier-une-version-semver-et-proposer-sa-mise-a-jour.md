# 38: Publier une version SemVer et proposer sa mise à jour

**What to build:** Le mainteneur publie une version stable d'`EPURE` (`Giskard-AI/epure`) sous un tag SemVer `vMAJOR.MINOR.PATCH` strictement immuable (sans tag flottant `v1`), et un dépôt consommateur épinglé sur l’ancien SHA complet (`uses: Giskard-AI/epure/.../@<sha> # vX.Y.Z`) reçoit une PR Renovate pour adopter la nouvelle version après tests de compatibilité.

**Blocked by:** 28 — Faire échouer une CI sur un workflow vulnérable selon zizmor

**Status:** ready-for-agent

- [ ] Les contrats publics Reusable Workflows et Custom Actions de `Giskard-AI/epure` sont testés depuis un dépôt de consommation fixture.
- [ ] Une release SemVer possède uniquement un tag `vMAJOR.MINOR.PATCH` strictement immuable protégé par Ruleset (aucun tag mobile `v1`), un changelog et des attributions tierces correctes.
- [ ] Le dépôt consommateur peut garder son SHA ancien jusqu’à l’acceptation explicite de la PR Renovate.
- [ ] Un changement incompatible d’interface échoue aux tests de compatibilité ou est réservé à une version majeure.

**Traçabilité :** user stories US-4, US-5, US-15, US-98 ; tests T-32, T-33 ; ADR-0008, ADR-0025.
