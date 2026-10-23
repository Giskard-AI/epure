---
status: accepted
---
# Dépôt public `Giskard-AI/epure`, Repository Ruleset de release et tags SemVer immuables

## Contexte

Il restait à fixer l'identité publique finale du framework, le mécanisme exact permettant d'autoriser uniquement la promotion fast-forward `dev → main` tout en bloquant les pushs directs humains, ainsi que la politique de tags de version consommés par les dépôts cibles.

## Décisions (Q80, Q81, Q82, Q83)

1. **Q80 — GitHub Repository Ruleset avec `Release App` en Bypass Actor** : le bootstrap `setup-repo` configure un **GitHub Repository Ruleset** ciblant `main` et `refs/tags/v*` qui interdit les pushs directs, les force-pushs et les suppressions, avec la seule `Release App` déclarée comme *Bypass Actor*. Le workflow manuel `release.yml` s'exécute derrière un GitHub Environment `release` avec revue obligatoire, vérifie que `dev` est strictement *fast-forwardable* sur `main` et que tous les checks requis sont verts sur le SHA de `dev`, puis effectue le `git push origin dev:main --ff-only` et crée le tag de release.
2. **Q81 & Q82 — Identité publique `EPURE` (`Giskard-AI/epure`)** : le framework est publié en open-source dans l'organisation **`Giskard-AI`** sous le slug **`Giskard-AI/epure`** et le nom d'affichage **`EPURE`** :
   - **EN** : *Engineered Planning, Unified Review & Execution*
   - **FR** : *Élaboration de Plans, Usinage, Revue et Exécution*
3. **Q83 — Tags SemVer `vMAJOR.MINOR.PATCH` strictement immuables** : aucun tag flottant mobile (`v1`) n'est maintenu. Chaque release publie uniquement un tag SemVer immuable `vX.Y.Z` protégé contre la suppression et le déplacement par le Ruleset. Les dépôts consommateurs épinglent les workflows et actions d'`EPURE` par leur SHA Git complet avec commentaire de version (`uses: Giskard-AI/epure/.github/workflows/plan.yml@<40-char-sha> # v1.0.0`), mis à jour automatiquement par Renovate.

## Conséquences

- Hébergé publiquement sous `Giskard-AI`, `EPURE` bénéficie des runners standards GitHub Actions gratuits et illimités ainsi que des fonctionnalités d'organisation (Merge Queue native et Repository Rulesets avec Bypass Actors).
- La chaîne d'approvisionnement des workflows et actions est déterministe et protégée contre toute réécriture de tag a posteriori.

## Références

Q4, Q18, Q21, Q29, Q50, Q80–Q83 ; ADR-0005, ADR-0008, ADR-0009, ADR-0011.
