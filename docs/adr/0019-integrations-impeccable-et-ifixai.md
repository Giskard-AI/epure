---
status: accepted
---
# Intégrations Impeccable et iFixAi

## Contexte

L'orchestrateur doit fournir des outils de qualité réutilisables sans imposer des dépendances et coûts non pertinents à tous les dépôts. L'écosystème inclut des projets frontend et des mécanismes d'audit d'agents.

## Décisions (Q57–Q58)

1. **Impeccable** : intégrer dès la V1 un skill d'assistance frontend et une **Custom Action publique** qui exécute un contrôle qualité UI/CI selon la politique du dépôt consommateur (activée par défaut pour les projets frontend, explicitement désactivable). L'intégration est facultative et ne s'applique pas aux dépôts backend sans interface.
2. **iFixAi** : intégrer dès la V1 une **Custom Action publique** pour l'audit de traces/trajectoires et d'autorisations, principalement utilisée pour vérifier `dev-automation`. Les tests comportementaux nécessitant un LLM sont facultatifs et ne sont pas un prérequis à chaque PR applicative.
3. Privilégier des adaptateurs minces sur des outils externes **épinglés à des révisions connues**, plutôt que de forker ou copier inutilement leur moteur. Exposer des contrats d'Action clairs (inputs, outputs, codes d'erreur, versions).
4. Les audits complètent la validation déterministe (GitHub permissions, tokens, checks, SHA, politique de merge) et ne se substituent jamais à celle-ci.

## Conséquences

- Prévoir `actions/impeccable` et `actions/ifixai`, plus la configuration de chargement du skill Impeccable dans les moteurs Pi et Codex.
- Éviter les coûts/latences d'audit pour les tâches non concernées.
- Vérifier compatibilité CLI et licence par version, et couvrir les adaptateurs par tests.
- La politique exacte d'activation, le caractère bloquant des résultats, le schéma des traces, leur confidentialité et leur rétention restent à spécifier.

## Références

Q9, Q31, Q38, Q51, Q53, Q57, Q58 ; ADR-0004, ADR-0008, ADR-0013, ADR-0018.
