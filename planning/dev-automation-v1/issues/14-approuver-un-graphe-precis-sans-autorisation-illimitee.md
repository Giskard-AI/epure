# 14: Approuver un graphe précis sans autorisation illimitée

**What to build:** Un mainteneur write approuve la version exacte d’une spec et de ses tickets ; le mandat signé (`spec_sha`, `approved_by`, liste des tickets, statut `active`) est enregistré de façon atomique dans `refs/epure/state/<issue-number>` et synchronisé dans l'encadré de l'issue, débloquant les enchaînements autorisés sans extension tacite du périmètre.

**Blocked by:** 13 — Transformer une spec en sous-issues dépendantes; 04 — Initialiser et reconfigurer un dépôt avec setup-repo

**Status:** ready-for-agent

- [ ] Un plan non approuvé ne déclenche aucune implémentation.
- [ ] L’approbation enregistre dans `refs/epure/state/<issue-number>` une révision de spec (`spec_sha`) et de graphe et attribue un mandat vérifiable aux événements internes, sans polluer la branche `dev`.
- [ ] Une modification significative d’ADR, de scope ou de dépendances suspend les tickets concernés jusqu’à nouvelle approbation.
- [ ] Un événement technique non relié à un mandat actif ne peut pas créer une autorisation.

**Traçabilité :** user stories US-32, US-33 ; tests T-5, T-7 ; ADR-0006, ADR-0015, ADR-0024.
