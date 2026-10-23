# 27: Corriger une migration Renovate échouée seulement si autorisée

**What to build:** Quand auto_migrate est activé par une configuration approuvée, une PR Renovate cassant le code peut être réparée par l’agent après analyse du guide de migration, sans auto-merge vers dev.

**Blocked by:** 26 — Contrôler les PR Renovate vers dev et leur origine; 07 — Implémenter un premier ticket avec Pi

**Status:** ready-for-agent

- [ ] Une panne de runner ou réseau provoque une relance bornée de CI, pas un patch de code.
- [ ] Une incompatibilité documentée déclenche une proposition de correction sur la PR Renovate autorisée.
- [ ] La PR corrigée reste soumise à la CI et à l’approbation humaine pour dev.
- [ ] Si auto_migrate est désactivé ou la provenance incertaine, aucun agent privilégié n’est démarré.

**Traçabilité :** user stories US-82, US-84, US-85 ; tests T-23.
