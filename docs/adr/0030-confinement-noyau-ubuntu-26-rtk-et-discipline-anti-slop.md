---
status: accepted
---
# ADR-0030 : Confinement noyau Ubuntu 26.04 à deux phases, formatage sans état RTK et discipline anti-slop

- **Statut** : Accepté
- **Date** : 2026-10-28
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0011, ADR-0016, ADR-0023, ADR-0028, ADR-0029

## Contexte

L'isolation de la sandbox sans secret définie dans les ADR-0011 et ADR-0023 protège les identifiants GitHub App et les clés d'API LLM en expurgeant l'environnement (`buildSanitizedSandboxEnv`) et en routant les appels LLM via un proxy HTTP éphémère sur `127.0.0.1:<proxyPort>`. Toutefois, lors de la vérification locale de pré-publication (Stage 1, ADR-0028), les commandes d'installation et de test du dépôt consommateur (`npm ci`, `pytest`, `cargo test`, `go test`) étaient lancées directement via `child_process.spawn` sans confinement au niveau du noyau Linux.

Trois risques et frictions opérationnelles en découlaient :

1. **Absence de confinement noyau réseau et système de fichiers en Stage 1** : un script de test ou de build pouvait effectuer des connexions sortantes arbitraires ou accéder à des chemins du runner en dehors du répertoire de travail. Sur Ubuntu 24.04 LTS, la restriction AppArmor sur les namespaces utilisateurs non privilégiés (`kernel.apparmor_restrict_unprivileged_userns=1`) compliquait l'usage de `bubblewrap`, tandis que `landrun` (Landlock ABI v8 avec filtrage TCP par port) n'était pas empaqueté dans les dépôts `apt` standards.
2. **Bruit dans les journaux de test Stage 1 et risque d'état caché avec RTK** : les sorties brutes de compilation et de test saturent la fenêtre de contexte du modèle lors des boucles de remédiation. Si l'outil `rtk` (`rtk-ai/rtk`) permet de condenser et formater ces sorties, son comportement par défaut active un suivi SQLite (`history.db`), un magasin de rappel (`recall.db`) et de la télémétrie, qui sont indésirables dans un runner CI éphémère et sans état. De plus, l'épinglage manuel d'un binaire externe sans gouvernance Renovate ni délai de quarantaine expose soit à l'obsolescence, soit à une publication compromise de jour 0.
3. **Dérive « AI code slop » et risque supply-chain des extensions tierces** : lors des phases d'implémentation et d'intégration, les modèles LLM tendent à créer des fichiers utilitaires superflus, des commentaires redondants et des formules de politesse verbeuses. L'installation de packages communautaires tiers (tels que `@caveman-ai/cli` ou des extensions `pi.dev/packages` non auditées) introduirait une surface d'attaque supply-chain inacceptable dans le runtime de l'orchestrateur.

## Décisions

### 1. Migration des workflows et des modèles `setup-repo` vers `ubuntu-26.04`

- Tous les workflows GitHub Actions d'`EPURE` (`.github/workflows/ci.yml`, `issue-command.yml`, `epure-check.yml`, `docs.yml`, `release-promote.yml`) ainsi que les workflows générés par `setup-repo` (`src/bootstrap/setup-repo.ts` et `src/bootstrap/ci-and-renovate.ts`) ciblent désormais `runs-on: ubuntu-26.04` (Ubuntu 26.04 LTS « Resolute Raccoon »).
- Ce runner fournit nativement le noyau Linux 7.0 (Landlock LSM ABI v8) ainsi que les paquets officiels `apt` `landrun` (`0.1.17`) et `bubblewrap` (`0.11.1`, accompagné de son profil AppArmor `/etc/apparmor.d/bwrap-userns-restrict`).

### 2. Confinement noyau de sandbox à deux phases (`landrun` + `bubblewrap`)

- Le lanceur `runInUntrustedCodeSandbox` (`src/sandbox/llm-sandbox.ts`) supporte une politique réseau explicite `SandboxNetworkPolicy` (`"proxy_only" | "https_only" | "offline"`) traduite par le constructeur pur `buildKernelSandboxedCommand` :
  - **Phase `install` de Stage 1 (`networkPolicy: "https_only"`)** : exécutée sous `landrun` avec `--connect-tcp 443` uniquement, `--rox /usr,/bin,/lib,/lib64,/etc,/opt`, `--ro /dev,/proc`, et `--rwx` limité au répertoire de travail (`cwd`), à `/tmp` et aux répertoires de cache de paquets.
  - **Phases `codegen`, `typecheck`, `lint`, `test` et `build` de Stage 1 (`networkPolicy: "offline"`)** : exécutées hors-ligne sous `bubblewrap` (`--unshare-net --unshare-pid --unshare-ipc --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind <cwd> <cwd> --chdir <cwd>`), coupant intégralement l'accès réseau (TCP, UDP, sockets abstraits) et isolant `/tmp`. Lorsque les namespaces utilisateurs de `bubblewrap` ne sont pas disponibles en développement local (ex. WSL), le lanceur se replie automatiquement sur `landrun` sans aucun flag `--connect-tcp` (zéro port TCP autorisé).
  - **Exécution d'adaptateur d'agent (`networkPolicy: "proxy_only"`)** : exécutée sous `landrun` avec `--connect-tcp <proxyPort>` comme unique port TCP sortant autorisé.
- Lorsque `EPURE_ENFORCE_KERNEL_SANDBOX=true` est défini en CI et qu'aucun backend noyau (`landrun` ou `bubblewrap`) n'est fonctionnel selon `probeKernelSandboxCapabilities`, l'exécution échoue en mode fermé (`SANDBOX_ISOLATION_UNAVAILABLE`).

### 3. Formatage et condensation sans état des sorties via RTK (`rtk-ai/rtk`) et gouvernance Renovate

- Nous intégrons `rtk` (`rtk-ai/rtk`, binaire Rust statique sous licence Apache-2.0) **exclusivement comme formateur et filtre de logs sans état** :
  - Le fichier `config/rtk/config.toml` fixe `telemetry.enabled = false`, `tracking.enabled = false`, `retriever.mode = "disabled"`, `display.colors = false`, `display.emoji = false` et filtre les répertoires et fichiers de bruit (`.git`, `node_modules`, `dist`, `target`, `__pycache__`, `.venv`, `*.lock`, `*.min.js`).
  - `buildSanitizedSandboxEnv` injecte systématiquement `RTK_TELEMETRY_DISABLED=1`, `RTK_RECALL=0`, `RTK_TEE=0`, `RTK_SUPPRESS_HOOK_WARNING=1` et `NO_COLOR=1`. Aucune base SQLite d'apprentissage ou d'historique n'est créée.
  - En Stage 1 (`formatAndCondenseStage1CommandOutput` dans `src/sandbox/polyglot-workspace-runner.ts`), lorsqu'une commande échoue (`exit_code !== 0`), le résumé nettoyé est systématiquement complété par la queue bornée (4 000 derniers caractères) du flux brut `stdout`/`stderr` conservé en mémoire par le runner afin de préserver les piles d'appels et numéros de ligne exacts.
- La constante `PINNED_RTK_VERSION = "v1.0.1"` et les références associées sont annotées avec `# renovate: datasource=github-releases depName=rtk-ai/rtk`.
- `renovate.json` et `buildRenovateConfigJson` déclarent un `customManager` regex détectant ces commentaires ainsi qu'une règle `packageRules` imposant `minimumReleaseAge: "7 days"` et `automerge: false` sur `github-releases` et `github-tags`. L'installation en CI vérifie l'archive téléchargée par rapport au fichier `checksums.txt` officiel de la release (`sha256sum --check --ignore-missing`).

### 4. Discipline de code `kill-slop` et concision `caveman` (`lite` + Auto-Clarity) embarquées en première partie

- Aucune dépendance externe (`@caveman-ai/cli` ou packages `pi`) n'est ajoutée.
- Le module `src/orchestrator/prompts/code-discipline.ts` définit `EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT`, injecté dans les instructions système de `ticket-execution.ts` et `feature-integration.ts` :
  - **Discipline `kill-slop`** : diff minimal, interdiction de créer des fichiers ou dossiers `utils/`/`helpers/` pour un usage unique, interdiction de refactorer le code adjacent hors périmètre, interdiction des commentaires paraphrasant le code, suppression immédiate des imports/variables rendus inutilisés.
  - **Concision `caveman` (`lite` + Auto-Clarity)** : suppression des formules de politesse, préambules et hésitations dans les résumés et tours d'outils, avec obligation de conserver intacts à 100 % le code source, les identifiants, les chemins de fichiers, les commandes, les schémas JSON, les avertissements de sécurité et les descriptions de PR.
- Le skill `.cursor/skills/kill-slop-caveman/SKILL.md` expose ces mêmes règles pour les agents locaux, et la création d'une extension `pi-epure-extension.ts` est écartée tant que l'orchestrateur s'appuie directement sur `LLMClient` et `repo-tools.ts`.

## Conséquences

- Les étapes de vérification Stage 1 bénéficient d'une isolation noyau réelle sans nécessiter de privilèges `root` ni de conteneur Docker imbriqué, tout en préservant un repli transparent en développement local.
- Les journaux de test transmis aux modèles de remédiation sont débarrassés du bruit ANSI et des lignes redondantes sans introduire de base SQLite ni de télémétrie, tout en garantissant la présence de la trace d'erreur brute en cas d'échec.
- Les mises à jour de `rtk` et des outils binaires sont automatisées par Renovate derrière un tampon de sécurité de 7 jours.

## Références

ADR-0011, ADR-0016, ADR-0023, ADR-0028, ADR-0029 ; `GLOSSARY.md` ; `docs/specs/ubuntu-26-kernel-sandbox-rtk-and-anti-slop.md`.
