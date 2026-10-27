# Usage de Base (Étude de Cas Réelle : `craft-calculator`)

Pour comprendre comment EPURE fonctionne concrètement, ce guide déroule le cycle de vie complet et anonymisé d'une fonctionnalité réelle sur une application web TypeScript/React nommée **`my-org/craft-calculator`** (un calculateur probabiliste et optimiseur de coûts pour un système d'artisanat incrémental).

Nous allons suivre l'**Issue #16** depuis son ouverture initiale en 3 lignes jusqu'à la release de production **`v1.0.0`** sur `main`.

---

## Machine à États Interactive de l'Issue

Tout au long de ce parcours, EPURE persiste l'état d'orchestration hors des branches standard dans la référence Git atomique `refs/epure/state/16` :

<ArchifyDiagram
  slug="epure-state-machine"
  locale="fr"
  title="Machine à États d'une Issue EPURE (Ref Git CAS : refs/epure/state/<issue>)"
  caption="Transitions atomiques Compare-And-Swap dans refs/epure/state/16 depuis l'entretien Grill jusqu'à l'état Terminé."
/>

---

## Étape 1 : Ouvrir l'Issue & Lancer le Grill

<span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 1</span>

Un mainteneur ouvre l'**Issue #16** (*« Ajouter un simulateur exact par chaînes de Markov et un tableau de bord web responsive »*) et poste le commentaire :

```text
/epure plan
```

### Ce qu'EPURE exécute automatiquement

1. **Porte de Permissions** : vérifie que l'auteur du commentaire dispose des droits `write` ou `admin` sur `my-org/craft-calculator`.
2. **Initialisation de l'État** : crée `refs/epure/state/16` en phase `grilling` et insère le tableau de bord `EPURE Status Dashboard` en haut du corps de l'Issue #16.
3. **Ronde 1 du Grill Structuré** : inspecte le dépôt et poste 4 questions d'architecture ciblées sur l'Issue #16 :
   - *Q1 : Le coût espéré doit-il être calculé par simulation Monte Carlo ou par résolution exacte de chaîne de Markov absorbante (matrice de transition `45 x 45`) ?*
   - *Q2 : Comment modéliser les états de corruption irréversibles dans l'espace d'états ?*
   - *Q3 : Quel modèle de persistance retenir pour les profils de prix utilisateur (base de données backend vs `localStorage` versionné) ?*
   - *Q4 : Le calculateur web doit-il respecter le contraste WCAG 2.1 AA et un layout responsive mobile (`320px`–`1440px`) ?*

### Répondre au Grill (Continuité Implicite — Q84)

Tant que l'Issue #16 est en phase `grilling`, **vous n'avez pas besoin de répéter de commande slash**. Répondez simplement dans un commentaire GitHub ordinaire :

```text
1. Solveur exact de chaîne de Markov absorbante (élimination de Gauss, zéro variance Monte Carlo).
2. Modéliser la corruption comme un état d'échec absorbant déclenchant le coût de remplacement de l'objet.
3. SPA 100 % côté client déployée sur GitHub Pages avec localStorage versionné.
4. Oui, imposer WCAG 2.1 AA et un layout responsive mobile-first via Impeccable.
```

> **Curseur de commentaires en lot (`last_processed_comment_id`, Q75)** : si vous postez deux ou trois commentaires successifs pendant qu'un job est en file d'attente, EPURE lit et intègre tous les commentaires non traités dans l'ordre chronologique strict au démarrage suivant — aucun commentaire n'est jamais perdu.

---

## Étape 2 : Épure, `DESIGN.md`, Spec & DAG de Tickets

<span class="epure-badge epure-badge--auto">Étape Automatisée Obligatoire</span> + <span class="epure-badge epure-badge--optional">Porte Conditionnelle UI</span>

Dès que vos réponses lèvent toutes les ambiguïtés du Grill, EPURE publie la **Synthèse des Décisions** et attend votre validation (`grilling` / `awaiting_human_approval`). Après validation de la frontière via **`/epure to-spec`** (génération et relecture de la spécification sur `plan/*`) puis **`/epure to-tickets`** (découpage en tickets) :

1. **Crée la branche `plan/16-markov-craft-calculator`** depuis `dev`.
2. **Versionne les artefacts du domaine et de spécification** :
   - `GLOSSARY.md` (définissant *Matrice de Transition*, *État Absorbant*, *Coût Espéré*).
   - `docs/adr/0001-exact-markov-solver-and-spa.md`.
   - `DESIGN.md` (généré automatiquement car l'Issue #16 comporte une interface utilisateur, définissant les tokens clair/sombre, le contraste WCAG AA et les points de rupture responsive).
   - `docs/specs/16-markov-craft-calculator.md` (spécification complète enrichie par `user-advocate` en mode **`design-gate`** avec les critères d'acceptation UX par persona).
3. **Crée le Graphe Orienté Acyclique (DAG) de Tickets** :
   - **Issue #25** : *Solveur exact de chaîne de Markov absorbante & tests unitaires* (`ready-for-agent`, `blocked_by: []`)
   - **Issue #26** : *Éditeur de prix et hook localStorage versionné* (`ready-for-agent`, `blocked_by: [#25]`)
   - **Issue #27** : *Interface responsive du simulateur & validation d'accessibilité Impeccable* (`ready-for-agent`, `blocked_by: [#25, #26]`)
4. **Ouvre la PR `plan/16-markov-craft-calculator -> dev`** et se met en attente sur l'état **`awaiting_approval`**.

---

## Étape 3 : Signer le Mandat (`/epure approve`)

<span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 2</span>

Après relecture de la spécification et du découpage en tickets sur la PR `plan/*`, le mainteneur commente sur l'Issue #16 :

```text
/epure approve
```

### Ce que verrouille `/epure approve`

- Fusionne en squash la PR purement documentaire `plan/16-markov-craft-calculator -> dev`.
- Enregistre le mandat signé dans `refs/epure/state/16` (`spec_sha`, `approved_by`, `approved_at`, `status: "active"`).
- Crée la branche d'intégration **`feature/16-markov-craft-calculator`** depuis `dev`.

---

## Étape 4 : TDD Sans Secret & Revue Multi-Agents (`task/* -> feature/*`)

<span class="epure-badge epure-badge--auto">Étape Automatisée Obligatoire</span> + <span class="epure-badge epure-badge--optional">Porte Conditionnelle UI</span>

EPURE exécute alors les tickets du DAG dans l'ordre topologique (`#25`, puis `#26`, puis `#27`) :

1. **Boucle TDD en Sandbox Sans Secret** :
   - Crée `task/25-markov-solver` depuis `feature/16-markov-craft-calculator`.
   - Exécute `npm test` et `npm run build` dans la sandbox isolée (`LLM_API_KEY` et les clés privées PEM des GitHub Apps sont purgées de l'environnement enfant).
   - Ouvre la **PR #28** (`task/25-markov-solver -> feature/16-markov-craft-calculator`).
2. **Revue Multi-Agents Indépendante (chargée depuis `dev`)** :
   - Charge `.cursor/agents/*.md` exclusivement depuis la branche de confiance `dev` (jamais depuis `task/25-*`).
   - Sélectionne jusqu'à 4 reviewers pertinents (ex. `domain-backend-reviewer`, `standards-reviewer`, `security-reviewer`) + `spec-parity-reviewer`.
   - Pour le **Ticket #27** (qui touche des fichiers `.tsx` et `.css`), active automatiquement `frontend-reviewer`, `accessibility-reviewer`, `design-reviewer`, `user-advocate` (`implementation-review`) et le check **`impeccable-gate`**.
   - Si un reviewer émet un `must_fix`, EPURE lance un tour d'auto-remédiation ciblé (jusqu'à `max_code_fix_attempts = 3`) et ne relance que les reviewers en échec + `spec-parity-reviewer`.
3. **Squash Sémantique par IA** :
   - Juste avant chaque fusion `task/* -> feature/*`, EPURE synthétise un titre et un corps Conventional Commit (`feat(solver): implement exact absorbing Markov chain solver (#28)` avec `Refs #25`) et effectue le squash-merge autonome autorisé par le ruleset `epure-feature-governance`.

---

## Étape 5 : PR Finale de Synthèse & Merge Humain sur `dev`

<span class="epure-badge epure-badge--auto">Étape Automatisée Obligatoire</span> -> <span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 3</span>

Une fois les tickets `#25`, `#26` et `#27` fusionnés dans `feature/16-markov-craft-calculator` :

1. EPURE ouvre la **PR #47** finale de synthèse (`feature/16-markov-craft-calculator -> dev`) avec les trailers `Closes #16`, `Closes #25`, `Closes #26`, `Closes #27`.
2. Exécute la revue multi-agents de synthèse complète ainsi que `impeccable-gate` sur le diff consolidé.
3. Met à jour le titre et la description de la PR #47 avec un résumé Conventional Commit synthétisé.
4. **Jalon Humain 3** : comme `epure-dev-governance` interdit à l'Agent App de fusionner du code applicatif dans `dev`, le mainteneur humain relit la PR #47 et clique sur **Squash and merge**. GitHub ferme alors automatiquement les Issues `#16`, `#25`, `#26` et `#27`.

---

## Étape 6 : Promouvoir la Release `dev -> main` (`v1.0.0`)

<span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 4</span>

Pour publier la version en production, le mainteneur déclenche manuellement le workflow **`Release Promote (dev -> main)`** (`workflow_dispatch` avec `version: v1.0.0`), ou via la CLI `gh` :

```bash
gh workflow run release-promote.yml -R my-org/craft-calculator -f version=v1.0.0
```

À l'aide de la **Release App** isolée (`<owner>-epure-release`), le workflow vérifie que `main` est bien un ancêtre de `dev`, effectue un fast-forward atomique de `main` sur `dev`, et pousse le tag immuable `v1.0.0`.
