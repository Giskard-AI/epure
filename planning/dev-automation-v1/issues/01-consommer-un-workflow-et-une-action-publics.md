# 01: Consommer un workflow et une action publics

**What to build:** Depuis un dépôt GitHub de démonstration, appeler indépendamment un Reusable Workflow et une Custom Action TypeScript pré-bundlée (Node.js 24 LTS) distribués par `Giskard-AI/epure` et constater un résultat vérifiable, sans infrastructure centrale ni `npm install` à l'exécution chez le consommateur.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Un dépôt consommateur public exécute le workflow réutilisable (`Giskard-AI/epure/.github/workflows/...`) sur son propre runner et obtient un check réussi.
- [ ] Le même dépôt appelle séparément la Custom Action TypeScript pré-bundlée et observe une sortie documentée sans étape d'installation de dépendances.
- [ ] Le paquet distribué contient une licence Apache-2.0, les attributions nécessaires et une documentation d’utilisation sans credentials partagés.
- [ ] Le contrat public décrit les entrées, sorties, erreurs, permissions et la méthode de pinning par SHA complet.

**Traçabilité :** user stories US-1, US-2, US-3, US-14, US-98 ; tests T-32, T-33 ; ADR-0008, ADR-0023, ADR-0025.
