# 09: Reprendre une conversation GitHub depuis un état versionné

**What to build:** Une personne autorisée engage un entretien sur une issue, répond dans un nouveau commentaire et retrouve les décisions conservées malgré l’arrêt du runner précédent (documents métiers sur `plan/<issue>`, état machine dans `refs/epure/state/<issue-number>` et tableau de bord Markdown synchronisé dans l'issue).

**Blocked by:** 05 — Publier une proposition d’agent sans lui céder le token

**Status:** ready-for-agent

- [ ] Une première commande crée un échange, versionne les documents sur `plan/<issue>` et enregistre l'état machine dans `refs/epure/state/<issue-number>` sans polluer `dev`.
- [ ] Une nouvelle réponse humaine reprend l’entretien sans obliger à répéter la commande initiale et met à jour l'encadré Markdown de statut dans l'issue.
- [ ] La reconstruction utilise le contexte canonique et la révision documentée, sans supposer une session de runner persistante.

**Traçabilité :** user stories US-19, US-20, US-26 ; tests T-3 ; ADR-0013, ADR-0024.
