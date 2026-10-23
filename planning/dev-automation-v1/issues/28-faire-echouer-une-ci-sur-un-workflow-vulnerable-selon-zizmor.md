# 28: Faire échouer une CI sur un workflow vulnérable selon zizmor

**What to build:** Une PR contenant une configuration GitHub Actions dangereuse reçoit un diagnostic zizmor consultable, et la politique de protection empêche son intégration si la règle est bloquante.

**Blocked by:** 04 — Initialiser et reconfigurer un dépôt avec setup-repo

**Status:** ready-for-agent

- [ ] Une fixture de workflow vulnérable provoque le check attendu avec localisation et diagnostic.
- [ ] Une fixture corrigée passe la vérification.
- [ ] Le contrôle est installé sur les changements de workflows et ses versions sont épinglées.

**Traçabilité :** user stories US-86 ; tests T-25.
