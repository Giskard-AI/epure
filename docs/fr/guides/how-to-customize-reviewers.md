# Guide : Personnaliser le Roster de Revue & la Porte Impeccable

Lors de l'invocation du skill **`/setup-repo`** (puis à chaque `/epure plan`), EPURE compose et adapte dynamiquement le roster d'agents de revue dans `.cursor/agents/*.md` ainsi que la porte de qualité UI **[Impeccable (`pbakaus/impeccable`)](https://github.com/pbakaus/impeccable)** (`DESIGN.md` + `impeccable-gate`), en s'appuyant sur les skills de spécification et de revue de **[Matt Pocock (`mattpocock/skills`)](https://github.com/mattpocock/skills)**. Ce guide explique comment ce roster est assemblé selon votre projet et comment l'enrichir en préservant l'immunité contre l'injection de prompt.

---

## 1. Socle Transverse vs Spécialistes Dynamiques dans `.cursor/agents/`

Le roster généré par `/setup-repo` n'est pas figé : il associe un **socle transverse permanent** à des **spécialistes conditionnels** adaptés à votre stack et à vos sous-domaines (par exemple l'exemple complet à 10 agents généré pour l'application web React `craft-calculator`, ou des spécialistes additionnels via `--domain-reviewers realtime,game-systems` et `--no-frontend-reviewers` pour un projet sans UI) :

| Fichier Reviewer | Catégorie | Condition de Génération & Sélection |
| --- | --- | --- |
| `architecture-reviewer.md` | Socle Transverse (Toujours présent) | Vérifie l'encapsulation des modules profonds, le respect des ADRs et l'ubiquité des termes de `GLOSSARY.md`. |
| `security-reviewer.md` | Socle Transverse (Toujours présent) | Audite l'hygiène des secrets, la prévention des injections et les frontières de privilèges. |
| `spec-parity-reviewer.md` | Socle Transverse (Toujours présent) | Exécuté sur **chaque** PR (`task/* -> feature/*` et `feature/* -> dev`) pour vérifier la parité 1-pour-1 avec la spec approuvée. |
| `standards-reviewer.md` | Socle Transverse (Adapté à la stack) | Adapté au langage détecté (TypeScript `it.each`, Python `pytest.mark.parametrize`, Rust ou Go). |
| `user-advocate.md` | Porte UX Personas (Toujours présent) | Intervient en mode **`design-gate`** (sur `plan/*` avant `/epure approve`) puis en mode **`implementation-review`** (sur les PRs). |
| `domain-backend-reviewer.md` (`+ <domain>-reviewer.md`) | Spécialiste Métier (Dynamique) | Adapté au domaine du dépôt (et complété par `--domain-reviewers <slug>`) ; sélectionné dès que la logique métier ou l'API est modifiée. |
| `infra-reviewer.md` | Spécialiste Infra (Dynamique) | Sélectionné lors de modifications de workflows CI, scripts de build ou manifestes de dépendances. |
| `frontend-reviewer.md` | Spécialiste UI (Si UI présente) | Généré si le dépôt comporte une UI ; sélectionné dès que des composants `.vue`, `.tsx`, `.jsx` ou hooks d'état sont touchés. |
| `accessibility-reviewer.md` | UI / Impeccable (Si UI présente) | Généré si le dépôt comporte une UI ; audite le contraste WCAG 2.1 AA, le HTML sémantique, ARIA et `:focus-visible`. |
| `design-reviewer.md` | UI / Impeccable (Si UI présente) | Généré si le dépôt comporte une UI ; vérifie le respect des tokens de `DESIGN.md`, l'absence d'overflow responsive et les états d'interaction. |

---

## 2. Comment l'Agent Crée et Personnalise les Reviewers en Toute Sécurité

Le répertoire `.cursor/agents/**` étant classé comme **chemin sensible de confiance** (Q92) :

1. **Conception sur mesure lors de `/setup-repo` (et enrichissement manuel sur `dev`)** : lors du setup initial, l'agent inspecte le dépôt et peut créer de nouveaux reviewers spécialisés dans `.cursor/agents/<slug>-reviewer.md` en précisant un champ `paths:` dans le frontmatter YAML (ex. `paths: src/realtime, src/ws`). Dès qu'une PR modifie un fichier correspondant à `paths:` (ou au nom `<slug>`), `selectReviewersForDiff` sélectionne automatiquement ce spécialiste.
2. **Versionnez toujours vos changements sur `dev`** : à l'exécution, l'orchestrateur EPURE charge `.cursor/agents/*.md` exclusivement depuis la branche de confiance `dev` — jamais depuis une branche `task/*` non fusionnée.
3. **Enrichissement Automatique lors de `/epure plan`** : lorsqu'une nouvelle fonctionnalité est planifiée via `/epure plan`, EPURE enrichit les reviewers du domaine et `.cursor/agents/user-advocate.md` sur la branche `plan/<issue>-<slug>` avec les nouveaux invariants et personas. Lorsque vous validez avec `/epure approve`, ces définitions sont fusionnées dans `dev` avant le démarrage des tickets `task/*`.

---

## 3. Dogfooding & Personnalisation de `DESIGN.md` (Porte Impeccable)

Dès qu'un dépôt ou une PR touche des fichiers d'interface (`.vue`, `.tsx`, `.jsx`, `.css`, `.html`), le check **`impeccable-gate`** (`evaluateImpeccableFrontendPr`) évalue le diff par rapport au contrat `DESIGN.md`.

### Constats Bloquants vs Non-Bloquants

`impeccable-gate` ne bloque une PR que sur des violations **objectives et vérifiables** :

- **Accessibilité (`accessibility`)** : absence d'attribut `title` sur un `<iframe>`, absence d'`aria-label` sur les boutons d'action, absence de style `:focus-visible` clavier ou ratio de contraste inférieur à `4.5:1` (WCAG 2.1 AA).
- **Layout & Responsive (`layout_overflow`)** : débordement horizontal non maîtrisé ou cassure d'affichage entre `320px` et `1440px`.
- **Tokens de Design (`design_tokens`)** : couleurs codées en dur contournant les variables CSS déclarées dans `DESIGN.md`.
- **États d'Interaction (`interaction_states`)** : composant interactif ou asynchrone dépourvu des états explicites `loading`, `ready` et `error`.

Les préférences esthétiques subjectives ne bloquent jamais une PR.
