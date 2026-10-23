---
status: accepted
---
# Vérifier Renovate, diagnostiquer la CI, publier les releases et abstraire les moteurs d’agent

## Contexte

Le projet distribue des workflows et Custom Actions publics à plusieurs dépôts. Il automatise certaines migrations Renovate et propose Pi / Codex comme moteurs interchangeables. Ces mécanismes doivent être fiables sans contourner l’autorisation humaine ni les frontières de sécurité des décisions précédentes.

## Décisions

1. **Q48 — Provenance Renovate.** N’autoriser le lancement automatique de l’agent de migration que si la PR cible `dev`, que son origine est vérifiée comme étant l’application Renovate attendue par le dépôt (identité de l’auteur et de l’application / contexte d’installation), et que `auto_migrate` est activé dans une configuration approuvée. Un titre, une branche ou une étiquette qui ressemble à Renovate ne suffit pas. Vérifier aussi le propriétaire de la branche modifiée avant d’émettre des écritures.
2. **Q49 — Diagnostic des échecs CI.** Classifier l’échec avant de modifier le code : erreurs de compilation ou tests cohérentes avec une rupture de compatibilité → proposer une migration ; incident de runner, réseau ou service externe → relances limitées sans changement de code ; échec ambigu, ou trois tentatives de correction infructueuses → `needs-human`. Les retries d’infrastructure ne doivent pas servir à masquer une CI durablement rouge.
3. **Q50 — Releases SemVer.** Une personne autorisée lance `workflow_dispatch` et fournit la version de release au format `vMAJOR.MINOR.PATCH` (règles de prérelease à spécifier au besoin). Le workflow valide la version, les contrôles requis et l’ascendance Git, promeut `dev` vers `main` par **fast-forward strict**, crée un tag de release protégé pointant sur le SHA publié, puis la GitHub Release associée. Les opérations sont idempotentes et reprenables si la publication de `main` réussit mais que la création de tag ou de release échoue. Aucun agent ne peut lancer seul une release ni déplacer un tag existant.
4. **Q51 — Adaptateurs Pi et Codex.** Supporter **Pi par défaut** et **Codex comme alternative** dès la V1, selon la configuration par dépôt ou par phase. Les deux implémentent un contrat d’entrée/sortie commun (contexte, rôle, événements structurés, résultat, erreurs, métadonnées d’exécution), avec tests de compatibilité. L’adaptateur masque les différences de CLI et de formats de sortie sans supposer des capacités identiques qui ne le sont pas.

## Implications et points à spécifier

- Les paramètres exacts de vérification de l’identité Renovate et des permissions de branche sont vérifiés à l’implémentation contre les API GitHub pertinentes.
- La classification CI peut rester déterministe pour les erreurs simples et utiliser un agent seulement lorsque l’analyse sémantique le justifie ; elle ne peut pas accorder de nouveaux privilèges.
- Le workflow de release utilise une identité séparée (Release App), protège les tags et refuse toute réécriture d’historique. Préciser la politique de préreleases et l’éventuelle publication des notes automatiques.
- Les tests de contrat des adaptateurs Pi et Codex doivent faire partie de la CI de `dev-automation` ; leurs outils restent soumis à l’isolation des secrets de Q9 / Q31.
- Les plafonds financiers ne sont jamais calculés par le système : ils restent chez le fournisseur LLM (ADR-0012).

## Références internes

ADR-0005, ADR-0008, ADR-0012 et ADR-0015.
