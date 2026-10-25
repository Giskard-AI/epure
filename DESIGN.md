# DESIGN.md — EPURE Documentation & Interactive Diagrams Design System (Impeccable Gate)

Ce document définit le système de design, les tokens visuels, les règles d'accessibilité WCAG 2.1 AA et les états d'interaction obligatoires du site de documentation bilingue d'**EPURE (`Giskard-AI/epure`)** propulsé par VitePress et les schémas interactifs **Archify**. Toute nouvelle violation objective par rapport à ce contrat bloque la porte CI `impeccable-gate` (Q79, Q96, Q103).

---

## 1. Identité Visuelle : « L'Épure d'Architecte » (Blueprint & Precision)

Le design repose sur une lisibilité éditoriale épurée et sur la métaphore de **l'épure** (le tracé géométrique à l'échelle grandeur nature sur fond bleu cyanotype ou papier millimétré d'atelier) :

- **Clarté éditoriale prioritaire** : hiérarchie typographique nette, largeur de lecture maximale de `74ch` pour le corps de texte documentaire, et pleine largeur contrôlée pour les diagrammes interactifs Archify.
- **Sémantique des 3 catégories d'étapes (Q101)** :
  - **Porte de validation humaine obligatoire** (*Mandatory Human Gate*) : Ambre / Or d'autorité (`--epure-gate-human`).
  - **Étape automatisée obligatoire** (*Mandatory Automated Step*) : Bleu Épure / Cobalt (`--epure-step-auto`).
  - **Étape facultative ou conditionnelle** (*Optional / Conditional Step*) : Émeraude / Teal à bordure pointillée (`--epure-step-optional`).

---

## 2. Tokens de Couleurs & Ratios de Contraste WCAG 2.1 AA

Tous les couples texte/fond respectent un ratio de contraste minimal de **4.5:1** pour le texte normal et **3:1** pour les grands titres et composants d'interface (WCAG 2.1 AA). L'utilisation de couleurs hexadécimales arbitraires hors tokens dans les composants personnalisés est interdite.

### Mode Clair (`:root`)

| Token CSS | Valeur | Usage | Contraste sur `--vp-c-bg` (`#ffffff`) |
| --- | --- | --- | --- |
| `--epure-brand-1` | `#1d4ed8` | Liens primaires, accents actifs, boutons primaires | `6.7:1` (AA / AAA grand texte) |
| `--epure-brand-2` | `#1e40af` | Survol (`:hover`) et états actifs | `8.6:1` (AAA) |
| `--epure-brand-soft` | `rgba(29, 78, 216, 0.10)` | Fond de badge et surbrillance douce | N/A (fond décoratif) |
| `--epure-surface-card` | `#f8fafc` | Conteneur de diagramme `<ArchifyDiagram>` et encadrés | Bordure `#cbd5e1` (`1.6:1` couplé à texte `#0f172a` `16.1:1`) |
| `--epure-border-strong` | `#64748b` | Bordures de contrôles interactifs et focus | `4.6:1` (AA UI component) |
| `--epure-gate-human-fg` | `#92400e` | Texte badge « Validation Humaine Obligatoire » | `7.1:1` sur `#fef3c7` |
| `--epure-step-auto-fg` | `#1e3a8a` | Texte badge « Étape Automatisée Obligatoire » | `9.4:1` sur `#dbeafe` |
| `--epure-step-optional-fg` | `#065f46` | Texte badge « Étape Facultative / Conditionnelle » | `7.8:1` sur `#d1fae5` |
| `--epure-danger-fg` | `#991b1b` | Texte d'état d'erreur (`error`) | `8.1:1` sur `#fef2f2` |

### Mode Sombre (`.dark`)

| Token CSS | Valeur | Usage | Contraste sur `--vp-c-bg` (`#0f172a`) |
| --- | --- | --- | --- |
| `--epure-brand-1` | `#60a5fa` | Liens primaires, accents actifs | `7.4:1` (AAA) |
| `--epure-brand-2` | `#93c5fd` | Survol (`:hover`) et états actifs | `10.1:1` (AAA) |
| `--epure-brand-soft` | `rgba(96, 165, 250, 0.14)` | Fond de badge et surbrillance douce | N/A |
| `--epure-surface-card` | `#1e293b` | Conteneur de diagramme `<ArchifyDiagram>` | Texte `#f8fafc` (`13.8:1`) |
| `--epure-border-strong` | `#94a3b8` | Bordures de contrôles interactifs | `5.8:1` (AA UI component) |
| `--epure-gate-human-fg` | `#fde68a` | Texte badge « Validation Humaine Obligatoire » | `11.2:1` sur `#451a03` |
| `--epure-step-auto-fg` | `#bfdbfe` | Texte badge « Étape Automatisée Obligatoire » | `10.8:1` sur `#172554` |
| `--epure-step-optional-fg` | `#a7f3d0` | Texte badge « Étape Facultative / Conditionnelle » | `10.5:1` sur `#064e3b` |
| `--epure-danger-fg` | `#fecaca` | Texte d'état d'erreur (`error`) | `10.9:1` sur `#450a0a` |

---

## 3. Typographie & Hiérarchie

- **Police sans-serif éditoriale (`--vp-font-family-base`)** : `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
- **Police monospace technique (`--vp-font-family-mono`)** : `'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` pour toutes les commandes `/epure`, les chemins Git (`refs/epure/state/<issue>`), les clés `.github/agents.yml` et les SHA de 40 caractères.
- **Échelle modulaire** :
  - `h1` : `2.25rem` (`line-height: 1.25`, `font-weight: 700`, `letter-spacing: -0.02em`)
  - `h2` : `1.65rem` (`line-height: 1.3`, `font-weight: 650`, bordure supérieure subtile)
  - `h3` : `1.25rem` (`line-height: 1.4`, `font-weight: 600`)
  - Corps : `1rem` (`16px`, `line-height: 1.7`)

---

## 4. États d'Interaction Obligatoires & Accessibilité du Composant `<ArchifyDiagram>` (Bloquants en CI `impeccable-gate`)

Chaque diagramme interactif intégré dans la documentation via `<ArchifyDiagram>` (`docs/.vitepress/theme/components/ArchifyDiagram.vue`) **doit** respecter les invariants suivants :

1. **Sémantique HTML & ARIA** :
   - Encapsulation dans une balise `<figure class="epure-archify-figure" role="group" :aria-labelledby="...">` accompagnée d'un `<figcaption>` descriptif.
   - L'élément `<iframe>` possède obligatoirement un attribut `title` explicite et localisé (EN ou FR) ainsi que `loading="lazy"`.
   - Tous les boutons d'action (bascule Plein écran / Quitter le plein écran, ouverture dans un nouvel onglet, réessayer) possèdent un `type="button"` et un `aria-label` explicite.
2. **Trois états d'interface explicites (`loading`, `ready`, `error`)** :
   - **État `loading`** : indicateur visuel et textuel accessible (`role="status"`, `aria-live="polite"`) affiché tant que l'`iframe` n'a pas émis son événement `load`.
   - **État `ready`** : `iframe` interactive visible, contrôles de plein écran et lien direct actifs.
   - **État `error` / secours** : en cas d'échec de chargement (`@error`), affichage d'un message d'erreur explicite (`role="alert"`) avec bouton de rechargement et lien direct vers le fichier HTML autonome.
3. **Navigation Clavier & Focus Visible** :
   - Anneau de focus haute visibilité (`outline: 2px solid var(--epure-brand-1); outline-offset: 2px`) sur `:focus-visible` pour tous les boutons, liens et onglets.
   - En mode plein écran, la touche `Escape` referme immédiatement le mode plein écran et restitue le focus au bouton déclencheur.
4. **Intégrité Responsive (`320px` à `1440px+`)** :
   - Aucun débordement horizontal (`overflow-x: hidden` sur le conteneur, largeur `100%`, `max-width: 100%`).
   - Sur mobile (`< 640px`), la barre d'en-tête du diagramme passe en disposition empilée (`flex-wrap: wrap`) et la hauteur de l'`iframe` s'adapte (`min-height: 420px` sur mobile, `560px` sur desktop) sans tronquer les contrôles.
