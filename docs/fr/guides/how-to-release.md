# Guide : Promouvoir une Release (`dev -> main`)

Dans EPURE, `dev` est la branche d'intégration active par défaut et `main` est la **ligne de release immuable** protégée par le ruleset `epure-release-immutability`. Ni les développeurs humains ni l'`Agent App` ne peuvent pousser directement sur `main`.

La promotion d'une release constitue le **4e Jalon de Validation Humaine Obligatoire** (Q101).

---

## 1. Prérequis Avant la Promotion

Avant de déclencher une promotion en production, vérifiez que :

1. Toutes les PRs `feature/* -> dev` prévues pour la version ont été fusionnées en squash dans `dev`.
2. Le workflow `CI` est au vert sur le dernier commit de `dev`.
3. Les secrets `EPURE_RELEASE_APP_ID` et `EPURE_RELEASE_APP_PRIVATE_KEY` sont configurés, et `<owner>-epure-release` est déclaré comme Bypass Actor sur `epure-release-immutability`.

---

## 2. Déclencher le Workflow de Promotion

Vous pouvez lancer la promotion depuis l'interface GitHub (**Actions** -> **Release Promote (dev -> main)** -> **Run workflow**) ou en ligne de commande avec `gh` :

```bash
gh workflow run release-promote.yml \
  -R my-org/craft-calculator \
  -f version=v1.0.0
```

---

## 3. Ce qu'exécute `release-promote.yml`

1. **Émission d'un Jeton Éphémère Release App** : signe un JWT RS256 avec `EPURE_RELEASE_APP_ID` et `EPURE_RELEASE_APP_PRIVATE_KEY` pour obtenir un jeton d'installation court au nom de `<owner>-epure-release`.
2. **Vérification d'Ascendance Fast-Forward** : contrôle que `main` est un ancêtre strict de `dev` (`git merge-base --is-ancestor origin/main origin/dev`). En cas de divergence, le workflow s'arrête immédiatement sans jamais forcer le push.
3. **Fast-Forward Atomique & Tag** :
   - Pousse `dev` sur `refs/heads/main` (`git push origin dev:refs/heads/main`).
   - Crée et pousse le tag `v1.0.0` pointant exactement sur le SHA promu.
   - Publie la GitHub Release avec les notes générées depuis les Conventional Commits fusionnés depuis le tag précédent.
4. **Révocation Immédiate du Jeton** : révoque le jeton d'installation dans une étape finale `always()`.
