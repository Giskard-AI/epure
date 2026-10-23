# 36: Promouvoir dev vers main par fast-forward manuel

**What to build:** Un humain autorisé lance une release SemVer ; un workflow de release protégé par l'environnement `release` et s'exécutant sous la seule `Release App` (déclarée en *Bypass Actor* du GitHub Repository Ruleset sur `main` et `refs/tags/v*`) vérifie l’état exact de `dev`, avance `main` uniquement par fast-forward et publie le tag SemVer immuable et la GitHub Release au même SHA.

**Blocked by:** 21 — Intégrer une feature terminée à dev avec review humaine; 28 — Faire échouer une CI sur un workflow vulnérable selon zizmor

**Status:** ready-for-agent

- [ ] Le lancement manuel requiert l’identité Release App (seule *Bypass Actor* du Ruleset sur `main` et `refs/tags/v*`) et les approbations de l'environnement GitHub `release`.
- [ ] Le workflow refuse un main divergent, une CI manquante, un SHA dev changé ou un tag contradictoire.
- [ ] La promotion est un vrai fast-forward (`git push origin dev:main --ff-only`) sans merge commit, rebase ni squash.
- [ ] Le tag SemVer `vMAJOR.MINOR.PATCH` immuable et la GitHub Release désignent exactement le SHA promu ; la release englobe tout dev.

**Traçabilité :** user stories US-91, US-92, US-93, US-94, US-97 ; tests T-28, T-29 ; ADR-0005, ADR-0025.
