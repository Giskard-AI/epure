# Guide : Promouvoir une Release (`dev -> main`)

Dans EPURE, `dev` est la branche d'intégration et `main` est la **ligne de release**. Ni les développeurs humains ni l'`Agent App` ne poussent sur `main` : seule la **Release App** (`<owner>-epure-release`) le fait, depuis le workflow de release, dans l'environnement protégé `release`.

La promotion d'une release constitue le **4e Jalon de Validation Humaine Obligatoire** (Q101).

Les deux points d'entrée exécutent la même implémentation, le workflow réutilisable `Giskard-AI/epure/.github/workflows/release-promote.yml` :

| Dépôt | Workflow à déclencher | Rulesets où la Release App doit être Bypass Actor |
| --- | --- | --- |
| Dépôt consommateur initialisé par `/setup-repo` | `.github/workflows/release.yml` (**EPURE Controlled Release (dev -> main)**), un appelant minimal épinglé sur un SHA d'EPURE | `epure-release-immutability`, `epure-release-tags` |
| `Giskard-AI/epure` lui-même | `.github/workflows/release-promote.yml` (**Promote Dev to Main (Fast-Forward Release)**) | `Main basic protection`, `epure-branch-governance`, `epure-tag-immutability` |

Entrées : `semver_tag` (`vMAJOR.MINOR.PATCH`), `expected_dev_sha` (le SHA complet de 40 caractères de la tête de `dev` que vous avez relue) et, sur `release-promote.yml`, l'entrée optionnelle `ci_workflow` (par défaut `ci.yml`, le fichier du workflow dont l'exécution sur `dev` doit avoir réussi).

---

## 1. Configuration Initiale (une seule fois)

1. **Créer et installer la Release App.** L'étape 3 de `scripts/wizards/setup-github-apps-wizard.sh --repo <owner>/<repo>` crée `<owner>-epure-release` (permissions de dépôt `Contents: Read and write`, `Metadata: Read-only`, sans webhook), l'installe sur ce seul dépôt et enregistre deux **secrets** dans l'environnement `release` : `EPURE_RELEASE_APP_ID` (identifiant numérique de l'App) et `EPURE_RELEASE_APP_PRIVATE_KEY` (PEM). L'assistant enchaîne toujours toutes les étapes, y compris l'Agent App ; si seule la Release App vous intéresse, suivez les mêmes étapes à la main puis enregistrez les secrets avec `gh secret set <NAME> -R <owner>/<repo> --env release`.
2. **Déclarer la Release App comme Bypass Actor** (`actor_type: Integration`, `actor_id: <App ID>`, `bypass_mode: always`) sur chaque ruleset couvrant `main` et les tags `v*` (voir le tableau ci-dessus). Dans un dépôt consommateur, `node dist/cli/setup-repo.mjs --repo <owner>/<repo> --pinned-sha <SHA du commit EPURE> --agent-app-id <ID Agent App> --release-app-id <App ID> --apply --apply-github-settings` le fait pour `epure-release-immutability` et `epure-release-tags`. Ailleurs, ajoutez l'acteur avec `gh api` en conservant les acteurs existants :

   ```bash
   gh api repos/<owner>/<repo>/rulesets/<ruleset-id> \
     | jq '{name, target, enforcement, conditions, rules,
            bypass_actors: (.bypass_actors + [{actor_id: <App ID>, actor_type: "Integration", bypass_mode: "always"}])}' \
     | gh api -X PUT repos/<owner>/<repo>/rulesets/<ruleset-id> --input -
   ```

3. **Protéger l'environnement `release`** avec au moins un relecteur obligatoire et une politique de branches de déploiement limitée à `dev` :

   ```bash
   gh api -X PUT repos/<owner>/<repo>/environments/release --input - <<'EOF'
   {
     "reviewers": [{"type": "User", "id": <reviewer-user-id>}],
     "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
   }
   EOF
   gh api -X POST repos/<owner>/<repo>/environments/release/deployment-branch-policies \
     -f name=dev -f type=branch
   ```

---

## 2. Prérequis Avant Chaque Release

1. Toutes les PRs `feature/* -> dev` prévues pour la version ont été fusionnées en squash dans `dev`.
2. Le workflow `CI` (`.github/workflows/ci.yml`) s'est terminé en `success` sur la tête de `dev`.
3. Vous avez choisi le prochain tag à partir des Conventional Commits depuis le tag précédent (`fix:` -> PATCH, `feat:` -> MINOR, `!:` / `BREAKING CHANGE` -> MAJOR).

---

## 3. Déclencher la Release

Déclenchez le workflow **depuis `dev`** (l'environnement `release` refuse les autres refs), puis approuvez le déploiement en attente dans l'onglet **Actions**.

Dépôt consommateur :

```bash
DEV_SHA="$(gh api repos/my-org/craft-calculator/branches/dev --jq .commit.sha)"
gh workflow run release.yml -R my-org/craft-calculator --ref dev \
  -f semver_tag=v1.0.0 -f expected_dev_sha="$DEV_SHA"
```

EPURE lui-même :

```bash
DEV_SHA="$(gh api repos/Giskard-AI/epure/branches/dev --jq .commit.sha)"
gh workflow run release-promote.yml -R Giskard-AI/epure --ref dev \
  -f semver_tag=v1.0.0 -f expected_dev_sha="$DEV_SHA"
```

---

## 4. Ce qu'exécute `release-promote.yml`

1. **Valide tout avant la moindre écriture** et s'arrête avec une annotation `::error::` lorsque :
   - `semver_tag` ne respecte pas `vMAJOR.MINOR.PATCH` (sans zéro initial) ;
   - `expected_dev_sha` n'est pas un SHA de 40 caractères égal à la tête actuelle de `origin/dev` ;
   - le tag existe déjà ;
   - `origin/main` n'est pas un ancêtre de `expected_dev_sha` (fast-forward impossible) ;
   - la dernière exécution de `CI` pour ce SHA sur `dev` ne s'est pas terminée en `success` ;
   - `EPURE_RELEASE_APP_ID` ou `EPURE_RELEASE_APP_PRIVATE_KEY` manque dans l'environnement `release`.
2. **Vérifie la séparation des rôles de la Release App** avec `actions/verify-app-role` (`promote_dev_to_main` sur `refs/heads/main`, depuis `release.yml` / `release-promote.yml`, environnement `release`).
3. **Émet un jeton d'installation éphémère** avec `actions/create-github-app-token`, limité à ce dépôt et à la seule permission `contents: write`.
4. **Fast-forward de `main` et tag atomiques** : crée le tag annoté sur `expected_dev_sha` au nom de `<owner>-epure-release[bot]`, puis exécute un unique `git push --atomic` de `<sha>:refs/heads/main` et `refs/tags/<tag>`. Les deux refs avancent ensemble ou aucune ne bouge ; aucun push forcé, et le jeton n'est transmis à `git` que par l'environnement du processus (jamais écrit dans `.git/config`).
5. **Publie la GitHub Release** avec `gh release create --verify-tag --generate-notes --notes-start-tag <tag précédent> --latest`.
6. **Révoque le jeton** dans une étape `always()`, même si une étape précédente a échoué.

---

## 5. Relancer Après un Échec

Relancez avec **les mêmes entrées** :

- **Échec avant le push** : rien n'a été écrit ; corrigez la cause et relancez.
- **Push effectué, release non publiée** : le workflow constate que le tag et `origin/main` pointent déjà sur `expected_dev_sha`, saute le push (ainsi que la vérification de la tête de `dev`, qui a pu avancer) et publie seulement la GitHub Release.
- **Release déjà publiée** : l'exécution se termine par une notice sans rien modifier.
- **Tag existant sur un autre commit** : l'exécution s'arrête. Les tags de release sont immuables ; choisissez la version suivante.
