# Specification — Confinement Noyau Ubuntu 26.04, Formatage Sans État RTK v1.0.1 et Discipline Anti-Slop Sans Dépendance Tierce

## Problem Statement

Lorsqu'un agent d'implémentation ou de remédiation d'`EPURE` exécute la vérification locale de pré-publication (Stage 1) sur le code d'un dépôt consommateur (`npm ci`, `pytest`, `cargo test`, `go test`), la sandbox actuelle (`runInUntrustedCodeSandbox`) assainit les variables d'environnement (`process.env`) et isole les clés API derrière un proxy local `127.0.0.1`, mais lance les sous-processus directement via `child_process.spawn` sans confinement noyau Linux (ni Landlock LSM, ni namespaces réseau/montage). Un script de test ou un hook `postinstall` malveillant pourrait donc ouvrir des connexions réseau sortantes arbitraires, inspecter d'autres répertoires du runner (`~/.ssh`, `~/.config`) ou polluer `/tmp`.

De plus, sur les runners Ubuntu 24.04 (`ubuntu-latest` avant migration), l'utilisation de `bubblewrap` est entravée par la restriction AppArmor sur les namespaces utilisateurs non privilégiés (`kernel.apparmor_restrict_unprivileged_userns=1`), et l'outil `landrun` (Landlock ABI v8 avec filtrage TCP par port) n'est pas fourni nativement par `apt`.

Par ailleurs, les sorties brutes des outils de test, de lint et de compilation en Stage 1 contiennent une grande quantité de bruit (barres de progression, codes ANSI, centaines de lignes de tests réussis, fichiers de lock ou dossiers `node_modules`/`target`), ce qui gonfle la fenêtre de contexte du modèle LLM lors des boucles de remédiation. L'utilisation d'un outil comme `rtk` (`rtk-ai/rtk`) sans configuration stricte activerait par défaut un suivi analytique SQLite (`history.db`) et un magasin d'état (`recall.db`) non souhaités en CI éphémère, et l'installation de binaires externes sans suivi Renovate laisserait des versions figées obsolètes ou exposées aux attaques supply-chain du jour 0.

Enfin, lors de la génération de code en CI, les modèles LLM ont tendance à produire du « code slop » (fichiers utilitaires pour un seul appel, commentaires paraphrasant le code, refactorings hors périmètre, dépendances non demandées) et une verbosité inutile entre les tours d'outils, tandis que l'installation de packages communautaires tiers pour `pi` ou `@caveman-ai/cli` introduirait un risque d'attaque supply-chain dans le processus hôte Node.js.

## Solution

Nous migrons l'ensemble des workflows GitHub Actions d'`EPURE` et les modèles de workflows générés par `setup-repo` vers **`ubuntu-26.04`** (Ubuntu 26.04 LTS, noyau Linux 7.0 supportant Landlock ABI v8, avec `landrun` 0.1.17 et `bubblewrap` 0.11.1 installés depuis les dépôts officiels `apt` d'Ubuntu).

Nous implémentons un **confinement noyau de sandbox à deux phases** dans la vérification locale de pré-publication (Stage 1) et le lanceur de sandbox :
1. **Phase d'installation (`install`, politique `https_only`)** : exécutée sous **`landrun` (Landlock ABI v8)** avec `--connect-tcp 443` uniquement, lecture seule sur `/usr`, `/bin`, `/lib`, `/lib64`, `/etc` et écriture restreinte au répertoire de travail (`workDir`), `/tmp` et aux caches du gestionnaire de paquets, bloquant toute exfiltration sur des ports non-HTTPS et toute écriture hors espace de travail.
2. **Phase d'exécution et de vérification (`codegen`, `typecheck`, `lint`, `test`, politique `offline`)** : exécutée hors-ligne sous **`bubblewrap`** (`--unshare-net --unshare-pid --unshare-ipc --tmpfs /tmp --die-with-parent`), isolant totalement le réseau (TCP, UDP, sockets Unix abstraits) et `/tmp`, avec repli automatique sur `landrun` sans aucun port TCP autorisé lorsque les namespaces utilisateurs sont indisponibles dans un environnement de développement local (ex. WSL).
3. **Phase d'exécution d'adaptateur d'agent (`proxy_only`)** : exécutée sous **`landrun`** avec `--connect-tcp <proxyPort>` comme unique port TCP autorisé vers `127.0.0.1`.

Nous intégrons **`rtk` (`rtk-ai/rtk`) en mode 100 % sans état (stateless)** pour le formatage et la condensation des logs en Stage 1 : `tracking.enabled = false`, `telemetry.enabled = false`, `retriever.mode = "disabled"` (`RTK_TELEMETRY_DISABLED=1`, `RTK_RECALL=0`, `RTK_TEE=0`, `NO_COLOR=1`). Aucune base SQLite d'apprentissage, d'historique ou de rappel n'est créée. En cas d'échec d'une étape Stage 1 (`exit_code !== 0`), le runner combine le résumé formaté par `rtk` avec la queue bornée (4 000 derniers caractères) du flux brut `stdout`/`stderr` capturé en mémoire pour garantir au LLM les numéros de ligne et piles d'appels exacts.

La version de `rtk` et des outils CLI/Actions épinglés est gouvernée par **Renovate** via un `customManager` regex (`# renovate: datasource=github-releases depName=rtk-ai/rtk`) assorti d'un délai de quarantaine (`minimumReleaseAge: "7 days"`) et d'une vérification d'intégrité SHA-256 à l'installation.

Enfin, nous embarquons directement en première partie (zéro dépendance externe) les règles de discipline de code **`kill-slop`** et de concision **`caveman` (`lite` + Auto-Clarity)** dans les prompts d'implémentation/remédiation de l'orchestrateur et sous forme de skill local `.cursor/skills/kill-slop-caveman/SKILL.md`.

## User Stories

### Migration Ubuntu 26.04 LTS et confinement noyau à deux phases (Stage 1 & Proxy)

1. En tant qu'administrateur de sécurité, je veux que tous les workflows GitHub Actions d'`EPURE` et ceux générés par `setup-repo` s'exécutent sur `ubuntu-26.04`, afin de disposer du noyau Linux 7.0 (Landlock ABI v8) et des paquets officiels `landrun` et `bubblewrap` maintenus par Canonical/Debian.
2. En tant qu'administrateur de sécurité, je veux que l'étape `install` de Stage 1 (`npm ci`, `pip install`, `cargo fetch`) s'exécute sous confinement noyau `landrun` avec la politique `https_only` (`--connect-tcp 443` uniquement et écriture restreinte au workspace, `/tmp` et caches d'installation), afin d'empêcher toute connexion vers des ports arbitraires ou modification du système hôte.
3. En tant qu'administrateur de sécurité, je veux que les étapes `codegen`, `typecheck`, `lint` et `test` de Stage 1 s'exécutent sous la politique `offline` via `bubblewrap` (`--unshare-net --unshare-pid --unshare-ipc --tmpfs /tmp --die-with-parent`), afin qu'aucun test applicatif ne puisse effectuer de requête réseau (TCP ou UDP) ni lire des fichiers temporaires d'autres processus.
4. En tant que développeur exécutant les tests d'`EPURE` dans un environnement local ou WSL dépourvu de namespaces utilisateurs non privilégiés pour `bubblewrap`, je veux que la politique `offline` se replie automatiquement sur `landrun` sans aucun flag `--connect-tcp`, afin de conserver un confinement noyau du système de fichiers et du réseau TCP sans casser le développement local.
5. En tant qu'administrateur de sécurité, je veux que lorsqu'un adaptateur d'agent (`pi` ou `codex`) est lancé avec la politique `proxy_only`, `landrun` restreigne les connexions TCP sortantes au seul port éphémère du proxy local (`--connect-tcp <proxyPort>`), afin que le sous-processus ne puisse joindre que `127.0.0.1:<proxyPort>`.
6. En tant qu'administrateur de sécurité, je veux que si le mode d'application stricte du confinement noyau est exigé en CI (`EPURE_ENFORCE_KERNEL_SANDBOX=true`) et qu'aucun binaire de confinement (`landrun` ou `bubblewrap`) n'est fonctionnel sur le runner, `runInUntrustedCodeSandbox` échoue en mode fermé (`SANDBOX_ISOLATION_UNAVAILABLE`), afin de respecter l'invariant fail-closed d'ADR-0011 et ADR-0023.

### Formatage et condensation des logs sans état via RTK (`rtk-ai/rtk`)

7. En tant qu'orchestrateur d'exécution de ticket, je veux que la configuration RTK (`config/rtk/config.toml`) désactive explicitement la télémétrie (`telemetry.enabled = false`), le suivi d'historique (`tracking.enabled = false`), le magasin de rappel SQLite (`retriever.mode = "disabled"`), les couleurs et les emojis, afin que `rtk` agisse uniquement comme un formateur et filtre de logs pur, sans base de données ni apprentissage.
8. En tant qu'administrateur de sécurité, je veux que `buildSanitizedSandboxEnv` injecte systématiquement `RTK_TELEMETRY_DISABLED=1`, `RTK_RECALL=0`, `RTK_TEE=0`, `RTK_SUPPRESS_HOOK_WARNING=1` et `NO_COLOR=1` dans l'environnement de la sandbox, afin de garantir par variables d'environnement qu'aucune donnée ni fichier SQLite ne soit persisté ou transmis par `rtk`.
9. En tant qu'agent de remédiation en Stage 1, je veux que les sorties de commandes volumineuses soient nettoyées des séquences ANSI, des barres de progression et des lignes redondantes de dossiers ignorés (`.git`, `node_modules`, `dist`, `target`, `__pycache__`, `.venv`, `*.lock`, `*.min.js`), afin d'économiser des tokens de contexte sur les appels LLM.
10. En tant qu'agent de remédiation en Stage 1, je veux que lorsqu'une commande de vérification échoue (`exit_code !== 0`), la sortie transmise au prompt de correction contienne à la fois le résumé condensé et la queue bornée (4 000 caractères) du flux d'erreur brut capturé en mémoire par le runner, afin de disposer systématiquement de la stack trace et des lignes d'assertion exactes sans dépendre d'une commande interactive `rtk recall`.

### Gouvernance Renovate des dépendances binaires et CLI (`rtk`, Actions, outils de sécurité)

11. En tant que mainteneur d'`EPURE` et d'un dépôt consommateur, je veux que `renovate.json` (et `buildRenovateConfigJson` dans `setup-repo`) déclare un `customManager` regex détectant les annotations `# renovate: datasource=<datasource> depName=<depName>` dans les workflows YAML et les fichiers TypeScript/Shell, afin que Renovate mette automatiquement à jour la version épinglée de `rtk` (`rtk-ai/rtk`) et des constantes d'outils CI.
12. En tant qu'administrateur de sécurité, je veux que les mises à jour issues de `github-releases` et `github-tags` (comme `rtk-ai/rtk` et `zizmorcore/zizmor`) soient soumises dans `renovate.json` à une période de quarantaine minimale de 7 jours (`minimumReleaseAge: "7 days"`) avec `automerge: false`, afin de protéger la CI contre toute publication compromise de jour 0.
13. En tant qu'administrateur de sécurité, je veux que l'étape d'installation de `rtk` dans les workflows GitHub Actions télécharge la release versionnée depuis `rtk-ai/rtk` et vérifie son empreinte SHA-256 par rapport au fichier `checksums.txt` officiel de la release avant d'installer le binaire dans `$RUNNER_TEMP/bin`, afin d'empêcher l'exécution d'une archive corrompue ou altérée.

### Discipline de code `kill-slop` et concision `caveman` (`lite` + Auto-Clarity) sans dépendance tierce

14. En tant que mainteneur de dépôt consommateur, je veux que les prompts d'implémentation et de remédiation de tickets (`ticket-execution`) ainsi que d'intégration de fonctionnalité (`feature-integration`) intègrent les règles strictes `kill-slop` (diff minimal, zéro fichier ou dossier `utils/`/`helpers/` créé pour un usage unique, zéro dépendance non demandée, zéro refactoring adjacent hors périmètre, zéro commentaire paraphrasant le code, suppression immédiate du code mort introduit), afin que les PRs soumises par l'agent soient chirurgicales.
15. En tant que mainteneur, je veux que ces mêmes prompts intègrent les règles `caveman` en mode `lite` avec frontières d'Auto-Clarity (suppression des formules de politesse, préambules et hésitations dans les champs de résumé et tours d'outils, tout en conservant intacts à 100 % le code source, les chemins de fichiers, les identifiants, les messages d'erreur, les avertissements de sécurité, les schémas JSON et les descriptions de PR), afin de réduire les tokens de sortie sans jamais dégrader la précision technique.
16. En tant que développeur utilisant un agent local (Cursor, Pi, Claude Code, Codex) sur le dépôt, je veux disposer du skill local `.cursor/skills/kill-slop-caveman/SKILL.md` embarqué en première partie sans aucun exécutable ni proxy tiers (`@caveman-ai/cli` exclu), afin d'appliquer sur demande la même discipline anti-slop et de concision sans risque supply-chain.

## Implementation Decisions

1. **Modèle de confinement noyau à deux phases dans le lanceur de sandbox** :
   * Le contrat d'entrée `SandboxExecutionInput` est enrichi d'une propriété optionnelle `networkPolicy?: "proxy_only" | "https_only" | "offline"` (par défaut `"proxy_only"` lorsque le proxy est utilisé par un adaptateur d'agent, `"https_only"` pour l'étape `install` de Stage 1, et `"offline"` pour les étapes `codegen`, `typecheck`, `lint`, `test` et `build` de Stage 1).
   * Un constructeur pur `buildKernelSandboxedCommand` traduit une commande atomique `(command, args, cwd, sanitizedEnv, networkPolicy, proxyPort, capabilities)` en une invocation enveloppée :
     * Pour `proxy_only` et `https_only` (ou en repli de `offline` lorsque `bubblewrap` n'est pas disponible mais `landrun` l'est) : invocation de `landrun` avec `--rox /usr,/bin,/lib,/lib64,/etc,/opt`, `--ro /dev,/proc`, `--rwx <cwd>,/tmp` (ainsi que les répertoires de cache d'outils en `https_only`), `--connect-tcp <proxyPort>` (en `proxy_only`), `--connect-tcp 443` (en `https_only`), aucun `--connect-tcp` (en repli `offline`), et passage explicite des clés de `sanitizedEnv` via `--env`.
     * Pour `offline` lorsque `bubblewrap` est disponible : invocation de `bwrap` avec `--unshare-net --unshare-pid --unshare-ipc --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind <cwd> <cwd> --chdir <cwd>`.
   * Une sonde de capacités `probeKernelSandboxCapabilities` vérifie la disponibilité fonctionnelle de `landrun` et de `bwrap`. Lorsque `EPURE_ENFORCE_KERNEL_SANDBOX === "true"` et qu'aucun backend noyau requis n'est fonctionnel, `runInUntrustedCodeSandbox` échoue en mode fermé avec `SANDBOX_ISOLATION_UNAVAILABLE`.

2. **Formatage et condensation des logs sans état avec RTK** :
   * Un fichier de configuration versionné `config/rtk/config.toml` fixe `telemetry.enabled = false`, `tracking.enabled = false`, `retriever.mode = "disabled"`, `display.colors = false`, `display.emoji = false`, `display.max_width = 120`, et configure `filters.ignore_dirs` et `filters.ignore_files`.
   * `buildSanitizedSandboxEnv` injecte `RTK_TELEMETRY_DISABLED=1`, `RTK_RECALL=0`, `RTK_TEE=0`, `RTK_SUPPRESS_HOOK_WARNING=1` et `NO_COLOR=1`.
   * Un formateur déterministe `formatAndCondenseStage1CommandOutput` dans le runner polyglotte Stage 1 nettoie systématiquement les codes ANSI, les barres de progression et les lignes de bruit (et utilise `rtk` en mode sans état lorsqu'il est activé), tout en garantissant qu'en cas d'échec (`exit_code !== 0`), les 4 000 derniers caractères du flux brut d'erreur restent présents pour le diagnostic LLM.

3. **Migration vers `ubuntu-26.04` et gouvernance Renovate (`customManagers`)** :
   * Tous les workflows du dépôt et les générateurs de workflows consommateurs (`setup-repo` et `ci-and-renovate`) passent de `runs-on: ubuntu-latest` à `runs-on: ubuntu-26.04`.
   * Une constante exportée `PINNED_RTK_VERSION = "v1.0.1"` annotée par `# renovate: datasource=github-releases depName=rtk-ai/rtk` et un helper `buildSandboxToolingSetupSteps` sont ajoutés pour installer `landrun`, `bubblewrap` et le binaire `rtk` vérifié par SHA-256 (`checksums.txt`).
   * `renovate.json` et `buildRenovateConfigJson` intègrent une section `customManagers` (`customType: "regex"`) reconnaissant les annotations `# renovate: datasource=... depName=...` ainsi qu'une règle `packageRules` imposant `minimumReleaseAge: "7 days"` et `automerge: false` sur les datasources `github-releases` et `github-tags`.

4. **Discipline de code `kill-slop` et concision `caveman` (`lite` + Auto-Clarity) embarquées** :
   * Un module `src/orchestrator/prompts/code-discipline.ts` exporte `EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT` regroupant les règles impératives `kill-slop` et `caveman` (`lite` + Auto-Clarity).
   * Ce bloc est injecté dans les instructions système de `ticket-execution.ts` et `feature-integration.ts`.
   * Un skill `.cursor/skills/kill-slop-caveman/SKILL.md` est créé pour les agents locaux, et l'exclusion de `pi-epure-extension.ts` est actée tant que le binaire CLI `pi` n'est pas substitué à `LLMClient` dans l'orchestrateur.

5. **Modèle du domaine (`GLOSSARY.md` et `ADR-0030`)** :
   * Ajout des termes canoniques **Confinement noyau de sandbox (Stage 1)** et **Formatage et condensation sans état des sorties de test (RTK)** dans `GLOSSARY.md`.
   * Enregistrement de l'ADR-0030 consignant ces choix architecturaux et l'évaluation supply-chain.

## Testing Decisions

* **Qu'est-ce qu'un bon test** : les tests vérifient uniquement le comportement observable aux 3 coutures publiques existantes via des tables paramétrées `it.each`, sans dépendre de l'état du noyau de la machine de développement ni télécharger de binaires sur le réseau pendant `npm test`.
* **Coutures et modules testés** :
  1. **Couture 1 — Sandbox et Runner Stage 1 (`runInUntrustedCodeSandbox`, `buildKernelSandboxedCommand`, `runPolyglotStage1Verification`)** :
     * Vérification par `it.each` de la construction des arguments `landrun` (`--connect-tcp 443` en `https_only`, `--connect-tcp <proxyPort>` en `proxy_only`, zéro `--connect-tcp` en repli `offline`) et `bubblewrap` (`--unshare-net --tmpfs /tmp` en `offline`).
     * Vérification du comportement fail-closed (`SANDBOX_ISOLATION_UNAVAILABLE`) lorsque `EPURE_ENFORCE_KERNEL_SANDBOX=true` et que les sondes noyau échouent.
     * Vérification de l'injection des variables sans état `RTK_TELEMETRY_DISABLED=1`, `RTK_RECALL=0`, `RTK_TEE=0`, `NO_COLOR=1` et de la préservation de la queue d'erreur brute en cas d'échec de test Stage 1.
  2. **Couture 2 — Bootstrap et Gouvernance Renovate (`planAndApplyRepoSetup`, `buildRenovateConfigJson`, `buildStackAwareCiWorkflowYaml`)** :
     * Vérification que les workflows générés ciblent `runs-on: ubuntu-26.04`.
     * Vérification que `renovate.json` généré contient le `customManager` regex pour `# renovate: datasource=...` et la règle de quarantaine de 7 jours sur `github-releases` / `github-tags`.
     * Audit de sécurité statique Zizmor (`tests/zizmor-workflow-audit.test.ts`) sur les workflows mis à jour.
  3. **Couture 3 — Orchestrateur d'Issues (`orchestrateIssueCommand`)** :
     * Vérification que les instructions système transmises au fournisseur LLM lors de l'exécution de ticket et de l'intégration de fonctionnalité contiennent les clauses `kill-slop` et `caveman` (`lite` + Auto-Clarity) tout en respectant strictement les schémas JSON de sortie.
* **Art antérieur dans le dépôt** : `tests/polyglot-sandbox.test.ts`, `tests/untrusted-code-sandbox.test.ts`, `tests/setup-repo.test.ts`, `tests/zizmor-workflow-audit.test.ts` et `tests/issue-orchestrator.test.ts`.

## Out of Scope

* Écriture d'une extension TypeScript `pi-epure-extension.ts` pour la CLI interactive `@earendil-works/pi-coding-agent` tant que l'orchestrateur exécute les phases d'implémentation directement via `LLMClient` et `repo-tools.ts`.
* Activation de la base SQLite d'historique (`history.db`), du magasin `recall.db` ou de la télémétrie de `rtk`.
* Installation du proxy CLI `@caveman-ai/cli` ou de packages communautaires tiers depuis `pi.dev/packages`.
* Application du style `i-have-adhd` dans les commentaires GitHub destinés aux humains.

## Further Notes

* Après modification des sources sous `src/`, exécuter `npm run build` pour régénérer les bundles `dist/actions/*/index.mjs` et `dist/cli/setup-repo.mjs` vérifiés par `tests/public-distribution.test.ts`.
