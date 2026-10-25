# Introduction & Sens du Nom EPURE

**EPURE** (`Giskard-AI/epure`) est un framework d'ingénierie logicielle centré sur GitHub qui associe **une gouvernance architecturale humaine structurée** à **une implémentation TDD et une revue de code multi-agents autonomes**.

**EPURE** garantit à l'ingénierie assistée par IA un verrouillage cryptographique du mandat de spécification (`spec_sha`), un fichier de configuration déclaratif unique (`.github/agents.yml`) et un flux reproductible de l'issue jusqu'à la release.

---

## Pourquoi le nom « EPURE » ?

Le nom **EPURE** possède un double sens qui ancre le projet à la fois dans la tradition architecturale française et dans l'ingénierie logicielle moderne :

### 1. L'Épure d'Architecte (Le Tracé Avant l'Usinage)

En architecture classique, en taille de pierre (*stéréotomie*) et en charpente navale, **une épure** est le dessin géométrique tracé à l'échelle grandeur nature sur le mur ou le sol de l'atelier avant même de tailler la première pierre ou d'assembler la moindre pièce.

Dans le développement logiciel assisté par agents IA, la cause principale d'échec est **le codage prématuré** : laisser un modèle deviner les besoins produit, inventer son propre vocabulaire métier ou trancher silencieusement des compromis d'architecture au milieu d'une Pull Request. EPURE impose la discipline inverse :

1. **Tracer l'épure d'abord** : sur une issue GitHub de pilotage, le mainteneur humain et l'agent lèvent chaque ambiguïté lors d'un entretien contradictoire structuré (**le Grill**).
2. **Versionner le domaine et la spécification** : avant qu'une seule ligne de code applicatif ne soit écrite, EPURE versionne le langage ubiquitaire (`GLOSSARY.md`), les décisions d'architecture (`docs/adr/`), la spécification fonctionnelle et technique (`docs/specs/<slug>.md`) et — dès qu'une interface utilisateur est concernée — le contrat de système de design (`DESIGN.md`) sur une branche dédiée `plan/<issue>-<slug>`.
3. **Usiner les pièces sous mandat verrouillé** : ce n'est qu'après la signature explicite du plan par un mainteneur via `/epure approve` (qui verrouille le `spec_sha` exact dans `refs/epure/state/<issue>`) que les agents exécutent le graphe orienté acyclique (DAG) de tickets (`task/* -> feature/*`).

### 2. Le Rétro-Acronyme Bilingue

**EPURE** résume également les cinq piliers de son moteur d'orchestration en français comme en anglais :

| Lettre | Acronyme Français | Acronyme Anglais | Rôle dans le cycle d'ingénierie |
| --- | --- | --- | --- |
| **E** | **Élaboration** | **Engineered** | Entretien de conception structuré (`/epure plan` & Grill) qui explicite les compromis avant de coder. |
| **P** | **Plans** | **Planning** | Versionnement de `GLOSSARY.md`, des ADRs, de `DESIGN.md`, de la Spécification et du DAG de tickets (`blocked_by`). |
| **U** | **Usinage** | **Unified** | Boucle d'implémentation TDD en sandbox sans secret (`npm test`, `npm run build`, contrats) sur des branches `task/*` isolées. |
| **R** | **Revue** | **Review** | Revue de code multi-agents spécialisés chargés depuis `dev`, porte UI Impeccable WCAG AA et squash sémantique par IA. |
| **E** | **Exécution** | **Execution** | Intégration gouvernée (merge humain `feature/* -> dev`) et promotion de release fast-forward (`dev -> main`). |

---

## La Tripartition des Étapes du Flux (Q101)

Un principe fondateur d'EPURE est la clarté absolue sur **qui décide** et **ce qui s'exécute automatiquement**. Chaque étape du cycle de vie appartient à l'une des trois catégories formelles suivantes :

<ArchifyDiagram
  slug="epure-issue-flow"
  locale="fr"
  title="Flux Global d'une Issue & PR EPURE (Portes Humaines, Obligatoire & Conditionnel)"
  caption="Le flux complet d'EPURE réparti entre les 4 Portes Humaines Obligatoires, le Pipeline Automatisé Obligatoire, la Porte UI Conditionnelle et les Contrôles Facultatifs."
/>

### 1. <span class="epure-badge epure-badge--human">Portes de Validation Humaine Obligatoires (4 Jalons)</span>

Aucun agent ne peut contourner ces quatre points de décision. Ils exigent l'intervention explicite d'un contributeur disposant des droits `write` ou `admin` sur le dépôt :

1. **Jalon 1 — Lancement & Réponses au Grill (`/epure plan`)** : un mainteneur déclenche `/epure plan` sur une issue GitHub et répond aux questions de cadrage jusqu'à ce que toutes les ambiguïtés soient levées.
2. **Jalon 2 — Signature du Mandat d'Implémentation (`/epure approve`)** : après relecture de la spécification et du DAG de tickets générés sur `plan/<issue>-<slug>`, le mainteneur poste `/epure approve`. Cette commande fusionne `plan/* -> dev`, scelle le `spec_sha` dans `refs/epure/state/<issue>` et ouvre la branche d'intégration `feature/<issue>-<slug>`.
3. **Jalon 3 — Merge Humain d'Intégration (`feature/* -> dev`)** : lorsque tous les tickets du DAG sont implémentés, audités et squashés dans `feature/*`, EPURE ouvre la PR finale de synthèse `feature/* -> dev`. Le ruleset `epure-dev-governance` **interdit** matériellement à l'Agent App de fusionner du code applicatif dans `dev` : un humain doit cliquer sur **Squash and merge**.
4. **Jalon 4 — Promotion Humaine de Release (`dev -> main`)** : la promotion de `dev` vers `main` et la publication du tag `vX.Y.Z` exigent le déclenchement manuel (`workflow_dispatch`) du workflow `release-promote.yml` par un mainteneur.

### 2. <span class="epure-badge epure-badge--auto">Étapes Automatisées Obligatoires</span>

Dès qu'un jalon humain est franchi, l'orchestrateur EPURE exécute de manière déterministe :

- **Génération de l'Épure & du DAG de Tickets** : commit de `GLOSSARY.md`, `docs/adr/` et `docs/specs/<slug>.md` sur `plan/<issue>-<slug>`, puis création des issues GitHub atomiques avec leurs dépendances `blocked_by` et le label `ready-for-agent`.
- **Boucle TDD en Sandbox Sans Secret** : pour chaque ticket débloqué, écriture des tests et du code dans un environnement isolé dépourvu de `LLM_API_KEY` et des clés privées PEM des GitHub Apps.
- **Revue Multi-Agents depuis `dev` & Squash Sémantique IA** : exécution parallèle de jusqu'à 4 reviewers spécialisés (chargés exclusivement depuis la branche de confiance `dev`) + `spec-parity-reviewer`. En cas de succès (`0 must_fix`), synthèse d'un titre et corps Conventional Commit (`Refs #<ticket>`) et squash-merge automatique `task/* -> feature/*`.
- **Revue de Synthèse Finale** : audit complet du diff consolidé sur la PR `feature/* -> dev` avec génération des liens de fermeture `Closes #<issue>` et `Closes #<ticket>`.

### 3. <span class="epure-badge epure-badge--optional">Étapes Facultatives ou Conditionnelles</span>

Ces opérations ne s'activent que selon la nature du changement ou sur demande explicite d'un mainteneur :

- **Porte Conditionnelle UI & Impeccable (automatique si surface UI)** : dès que la fonctionnalité ou le diff touche des fichiers d'interface (`.vue`, `.tsx`, `.jsx`, `.css`, `.html`), EPURE génère automatiquement `DESIGN.md`, exécute `user-advocate` en mode `design-gate` avant `/epure approve`, puis impose `user-advocate` (`implementation-review`) et `impeccable-gate` comme checks bloquants sur chaque PR. Les projets ou tickets purement backend/CLI ignorent automatiquement cette étape.
- **Détour Exploratoire `/prototype` & Preview Pages Isolée (facultatif)** : lorsqu'un comportement visuel ou une machine d'état ne peut être tranché par le texte pendant le Grill, un mainteneur peut demander un prototype jetable sur `prototype/*`. La prévisualisation statique GitHub Pages est **désactivée par défaut** (`enable_pages_preview: false`) et nécessite un consentement explicite.
- **Commandes Slash de Pilotage Granulaire (facultatives)** :
  - `/epure to-spec` : force le passage immédiat du Grill à la rédaction de la spécification.
  - `/epure to-tickets` : force la génération immédiate du DAG de tickets à partir de la spec existante.
  - `/epure status` : rafraîchit et affiche l'état d'orchestration et la table d'avancement des tickets.
  - `/epure cancel` : interrompt immédiatement l'orchestration et marque le mandat `cancelled` dans `refs/epure/state/<issue>`.
- **Escalade Humaine Conditionnelle (`needs-human`)** : déclenchée automatiquement si une branche `task/*` modifie un chemin sensible (`.github/workflows/**`, `.cursor/agents/**`, `CODEOWNERS`) sans exception approuvée, ou si un ticket échoue encore après `max_code_fix_attempts = 3` tours d'auto-remédiation.

---

## Écosystème Amont & Crédits (ADR-0018)

EPURE s'appuie sur des dépôts open source, des skills d'agents, des outils de design et des moteurs de sécurité épinglés par révision (attributions complètes dans [`NOTICE`](https://github.com/Giskard-AI/epure/blob/dev/NOTICE) et [`skills-lock.json`](https://github.com/Giskard-AI/epure/blob/dev/skills-lock.json)) :

| Dépôt Amont | Licence | Rôle dans EPURE |
| --- | --- | --- |
| **[Matt Pocock Agent Skills (`mattpocock/skills`)](https://github.com/mattpocock/skills)** | MIT | Socle des skills de cadrage et d'exécution (`grill-with-docs`, `to-spec`, `to-tickets`, `domain-modeling`, `tdd`, `code-review`, `prototype`, `wizard`, `pr` avec crédit à [Dex Horthy / HumanLayer](https://github.com/humanlayer/humanlayer)). |
| **[Impeccable (`pbakaus/impeccable`)](https://github.com/pbakaus/impeccable)** | Apache-2.0 | Cadrage UX/UI (`shape`, `DESIGN.md`, `.impeccable/surfaces/*.md`) et contrôle qualité déterministe frontend / accessibilité WCAG 2.1 AA (`actions/impeccable`, `impeccable-gate`). |
| **[Archify (`tt-a1i/archify`)](https://github.com/tt-a1i/archify)** | MIT | Moteur de schémas d'architecture interactifs en qualité showcase embarqué dans `scripts/archify/` (`npm run docs:diagrams`). |
| **[iFixAi (`ifixai-ai/iFixAi`)](https://github.com/ifixai-ai/iFixAi)** | Apache-2.0 | Audit déterministe des trajectoires d'autorisation et des frontières de privilèges (`actions/ifixai`). |
| **[zizmor (`woodruffw/zizmor`)](https://github.com/woodruffw/zizmor)** | MIT | Analyse statique de sécurité des workflows GitHub Actions (`actions/zizmor-audit`). |
| **[Renovate (`renovatebot/renovate`)](https://github.com/renovatebot/renovate)** | AGPL-3.0 (Outil) | Mise à jour automatisée des workflows épinglés par SHA et des dépendances avec migration assistée optionnelle (`auto_migrate`). |
