---
status: accepted
---
# Sandbox par proxy LLM local, stack TypeScript Node.js 22+ et seuils opérationnels par défaut

## Contexte

Lorsqu'un agent d'implémentation ou de migration Renovate travaille sur un dépôt consommateur, il doit à la fois interroger le modèle LLM et exécuter la suite de tests/builds du dépôt (qui peut contenir du code ou des scripts `postinstall` non fiables). Par ailleurs, la stack d'implémentation des Custom Actions et les valeurs numériques par défaut de `.github/agents.yml` devaient être figées avant l'implémentation.

## Décisions (Q74, Q77, Q78, Q79)

1. **Q74 — Isolation des secrets par proxy/sidecar LLM sur le runner** : la clé API LLM et les tokens GitHub App ne sont jamais injectés dans les variables d'environnement du processus qui exécute le code ou les tests du dépôt consommateur. Un proxy/sidecar local sur le runner détient la clé API en mémoire ; l'agent et les sous-processus de test/build tournent dans un conteneur isolé et communiquent uniquement via l'endpoint local du proxy. Si le mécanisme d'isolation est indisponible, le job échoue en mode fermé (*fail-closed*).
2. **Q77 — Monorepo TypeScript strict sur Node.js 22+** : les Custom Actions et contrôleurs d'`EPURE` sont écrits en TypeScript strict (Node.js 22+) et pré-bundlés afin qu'aucun `npm install` ne soit requis au runtime chez les consommateurs. Le bootstrap `setup-repo` est fourni sous forme de CLI TypeScript invocables par le skill local, et les Composite Actions sont réservées à l'invocation de binaires externes épinglés (`pi`, `codex`, `zizmor`).
3. **Q78 — Valeurs par défaut de `.github/agents.yml`** :
   - `max_code_fix_attempts`: **3**
   - `max_transient_api_retries`: **4** (backoff exponentiel 5s → 15s → 45s → 120s)
   - `job_timeout_minutes`: **60 minutes (1h)** pour les jobs d'implémentation (30 minutes pour les phases courtes de review/triage)
   - `max_concurrent_tasks_per_feature`: **3**
   - `trace_retention_days`: **30 jours** (et **14 jours** pour les previews statiques hébergées)
4. **Q79 — Périmètre des violations bloquantes Impeccable** : le check CI Impeccable bloque par défaut toute nouvelle violation portant sur : (a) le socle objectif par défaut (accessibilité vérifiable WCAG/ARIA/contraste/clavier, cassures de layout/overflow responsive, absence des états obligatoires loading/error/empty), ainsi que (b) toutes les règles et tokens ajoutés dans `DESIGN.md` et `.impeccable/surfaces/*.md`. Les suggestions purement esthétiques restent informatives.

## Conséquences

- Les bundles des Custom Actions (`dist/`) sont versionnés dans le dépôt avec `dist/** binary linguist-generated=true` dans `.gitattributes` et vérifiés en CI.
- Aucun test applicatif ni dépendance tierce ne peut lire les clés LLM dans `process.env`.

## Références

Q9, Q31, Q59, Q65, Q74, Q77–Q79 ; ADR-0008, ADR-0011, ADR-0012, ADR-0020, ADR-0021.
