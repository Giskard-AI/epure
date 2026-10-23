# 26: Contrôler les PR Renovate vers dev et leur origine

**What to build:** Un dépôt équipé reçoit les PR de mise à jour dans dev, et l’orchestrateur reconnaît les vraies PR Renovate sans se laisser tromper par une PR imitant son nom.

**Blocked by:** 04 — Initialiser et reconfigurer un dépôt avec setup-repo

**Status:** ready-for-agent

- [ ] Renovate cible dev et produit une PR soumise à l’approbation humaine habituelle.
- [ ] Le contrôleur vérifie identité/app, dépôt et PR réels plutôt que le seul nom ou label Renovate.
- [ ] Une PR externe ressemblante n’accède pas au parcours privilégié de migration.

**Traçabilité :** user stories US-81, US-83, US-85 ; tests T-22.
