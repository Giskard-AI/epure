---
status: accepted
---
# Reconstituer l'état du pilotage et rendre les opérations idempotentes

GitHub Issues, leurs relations de parenté/dépendance, les PR, les commits et les validations constituent la source de vérité de l'orchestration. Les runs GitHub Actions sont éphémères : après incident ou relance, le contrôleur reconstruit l'état et vérifie quels effets sont déjà survenus avant d'écrire à nouveau. Il utilise des identifiants d'opération stables, des contrôles sur les références et une réconciliation périodique, afin d'éviter les doublons de PR ou d'issues et les transitions d'état incohérentes. Aucune base de données externe n'est introduite au MVP.

Une annulation validée (`cancelled`) empêche les nouveaux appels LLM, les nouvelles exécutions et les intégrations automatiques pour le plan. Les jobs en cours sont annulés dans la mesure du possible ; les opérations de publication revérifient le statut juste avant leur effet. Les branches, PR et traces existantes sont conservées pour audit ou éventuelle reprise explicitement approuvée.
