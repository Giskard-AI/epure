---
status: accepted
---
# Prévention des boucles, indépendance des reviews et sûreté des merges

## Contexte

Le pipeline accepte des commentaires humains dans GitHub Issues, publie lui-même des commentaires et peut intégrer automatiquement des tickets vers `feature/*`. Sans garde-fous, ses propres publications pourraient relancer des agents, une review biaisée pourrait approuver son propre code, et une intégration défectueuse pourrait entraîner une cascade de merges. Les dépôts nouvellement installés peuvent aussi manquer de CI significative.

## Décisions (Q52–Q55)

1. **Q52 — Prévention des boucles.** Les commentaires émis par des bots ou les GitHub Apps du système ne sont jamais interprétés comme des commandes humaines. Les étapes suivantes sont déclenchées uniquement par des événements internes authentifiés et rattachés à une autorisation de plan toujours valable (Q46). Dédupliquer les livraisons d'événements et vérifier leur provenance avant toute transition. Un message de bot ne crée pas de nouvelle autorisation.
2. **Q53 — Review IA indépendante.** Le reviewer travaille dans une exécution/session distincte de l'implementer. Il reçoit le texte approuvé de la spécification, les critères d'acceptation, le diff, la révision Git et les résultats des tests ; il ne reçoit ni les raisonnements internes ni la conversation de travail de l'implementer. Il n'a pas de permission de modification du code ou de merge. Le même modèle LLM peut être utilisé si les contextes et responsabilités restent séparés.
3. **Q54 — Régression après intégration.** Si une régression est constatée après un merge automatique vers `feature/*`, suspendre les nouveaux merges automatiques de cette fonctionnalité, ouvrir un ticket correctif lié à la feature et procéder à la reprise seulement après rétablissement des contrôles. Les corrections ordinaires restent bornées à trois tentatives (Q8). En cas d'échec persistant, intervention humaine. Aucun `force-push` ni réécriture automatique de l'historique partagé.
4. **Q55 — CI minimale obligatoire.** Le skill `setup-repo` inspecte les checks réels du dépôt et signale l'absence de contrôles adéquats. L'intégration automatique des tickets reste **désactivée** tant qu'une CI minimale explicite, adaptée à la technologie du dépôt, n'est pas configurée et rendue requise. Le seul succès du job d'orchestration ou de review IA ne constitue pas une CI suffisante.

## Conséquences et contraintes d'implémentation

- Les étapes internes et les commandes utilisateur ont deux circuits d'autorisation séparés : aucun événement `issue_comment` émis par une App ne peut se transformer en commande privilégiée.
- Pour le check `ai-review`, préserver l'identité du reviewer, le SHA et le diff évalués ; ne pas transmettre les notes privées de l'implementer.
- L'arrêt après régression doit être un blocage à l'échelle de la feature, persistant dans l'état GitHub et réévaluable de manière idempotente.
- Le contrôleur ne doit pas conclure qu'il existe une CI suffisante du seul fait qu'un workflow `ci.yml` existe : vérifier les checks requis et documenter les garanties effectivement testées ; lorsque la couverture fonctionnelle reste inconnue, ne pas prétendre garantir la qualité.
- Les règles de protection de branche et les exceptions humaines (Q5, Q32, Q45) conservent priorité sur les résultats automatisés.

## Références internes

ADR-0003, ADR-0004, ADR-0008, ADR-0011, ADR-0013, ADR-0014 et ADR-0015.
