---
status: accepted
---
# Prototypes exploratoires, prévisualisations et approbation des plans

## Contexte

Le parcours frontend intègre un prototype optionnel avant validation d'un plan. Les contributeurs doivent pouvoir examiner les écrans depuis GitHub sans imposer un fournisseur d'hébergement externe, et les agents d'implémentation ne doivent pas confondre un prototype exploratoire avec du code de production.

## Décisions (Q66–Q69)

1. **Q66 — Prévisualisations GitHub-first** : les captures, rapports et fichiers HTML peuvent être fournis sous forme d'artifacts GitHub Actions. Lorsque le dépôt configure une publication de previews statiques, GitHub Pages peut héberger des prototypes HTML/CSS/JS consultables par URL et liés à l'issue ; un fournisseur externe n'est pas requis. Une éventuelle preview déjà existante sur un autre hébergeur peut être référencée. Le choix par défaut de publication est **désactivé**, avec activation explicite par `setup-repo` (Q70). L’isolation des sites (Q73) et la rétention de 14 jours par défaut (Q71) sont requises. GitHub Pages ne fournit pas, à date, de preview publique native indépendante par PR ; une stratégie de chemins isolés sous le site du dépôt est envisageable mais doit être implémentée et sécurisée explicitement. Le site est généralement public : jamais de secrets ni de données non fictives sensibles.
2. **Q67 — Ne pas réutiliser le code exploratoire** : le code d'une branche `prototype/*` n'est pas une base de production et ne doit pas être copié, cherry-pické ou mergé automatiquement vers `feature/*`, `task/*` ou `dev`. L'implémentation repart de la base technique approuvée, guidée par les exigences UX, captures, interactions documentées et critères d'acceptation. Le résultat peut être visuellement similaire, mais pas livré à partir du code exploratoire par défaut.
3. **Q68 — Régression visuelle optionnelle** : les tests de comparaison d'images sur des formats pertinents (desktop et mobile, notamment) peuvent être activés par dépôt en V1. Les images de référence sont versionnées et leurs changements soumis à review ; aucune obligation générale de ce contrôle ne s'ajoute au check Impeccable, qui reste obligatoire par défaut sur frontend (Q59/Q65).
4. **Q69 — Approbation après la spec et les tickets** : le pipeline approuvé est `grill-with-docs → design/shape → prototype éventuel → to-spec → to-tickets → approbation humaine du plan et du graphe de tickets → implémentation`. Les échanges UX peuvent recevoir des avis intermédiaires, mais ils ne valent pas autorisation d'exécuter les agents d'implémentation.

## Précisions validées ultérieurement (Q70–Q73)

- **Q70 — Publication opt-in** : GitHub Pages reste **désactivé par défaut** ; `setup-repo` propose l’activation uniquement avec accord explicite. En l’absence d’activation, utiliser les artifacts/captures. Ne pas réutiliser un site Pages de production comme origine d’un prototype actif sans séparation effective (Q73).

- **Q71 — Rétention** : supprimer automatiquement les previews hébergées après **14 jours par défaut**, délai configurable par dépôt. Les éléments de preuve conservés dans les spécifications et les artifacts suivent leur propre politique de rétention.
- **Q72 — Déclenchement par les skills** : ne pas introduire de seuil arbitraire de complexité. Suivre la bifurcation prévue dans `ask-matt` / `grilling` : une question de conception qui ne peut être tranchée en conversation, qu'elle porte sur une interface ou un modèle d'état, déclenche une proposition de `/prototype`, avec `/handoff` aller-retour pour consigner ce qui a été appris. Pour les sujets UX/UI, faire précéder cette bifurcation par Impeccable `shape`. Le prototype répond à une question délimitée ; il n'est jamais obligatoire pour toutes les fonctionnalités frontend. Conformément à Q67, le code exploratoire ne devient pas le code de production.
- **Q73 — Isolation et confidentialité** : n'autoriser la publication que de previews statiques isolées du site de production, sans secrets ni données personnelles. Le publisher valide ces conditions et refuse sinon la publication. **Un sous-répertoire d'un même domaine n'assure pas une isolation d'origine navigateur** ; s'il existe un site de production GitHub Pages, choisir un site/origine séparé(e) ou des mesures d'isolation équivalentes effectivement vérifiées.

## Conséquences

- Les previews hébergées doivent être statiques et détachées de tout backend secret ; la publication sur Pages est conditionnelle aux paramètres et autorisations du dépôt.
- La publication de multiples previews par sous-répertoire nécessite sérialisation et nettoyage ; ne pas supposer qu'une Action Pages crée une preview par PR nativement.
- La branche `prototype/*` reste clairement distincte du code de production ; les spécifications validées et actifs visuels sont les seuls contrats de transfert à l'implémentation.
- Les tickets créés par `to-tickets` doivent être présentés à l'humain avant que leur exécution soit autorisée.

## Questions restant ouvertes

- Publication Pages automatique ou opt-in, et choix du dépôt/site d'hébergement ; politique de confidentialité de ces previews.
- Stratégie de rétention, nettoyage et indexation des previews ; limitation des risques de partage d'origine HTML entre prototypes.
- Déclencheur et seuil de complexité justifiant un prototype.

## Références

Q2, Q34, Q55, Q59, Q62–Q73 ; ADR-0001, ADR-0013, ADR-0020, ADR-0021.
