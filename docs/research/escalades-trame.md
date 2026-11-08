# Escalades trame indépendantes du moteur d'agent

Analyse en lecture seule de l'historique de `Hartorn-Inc/trame` (12 epics, environ 124 escalades), limitée aux escalades qui ne dépendent pas du moteur d'agent : conflits, timeouts d'enregistrement de la CI, erreurs de l'API GitHub et PRs en double.

## Synthèse

Aucune de ces escalades ne dépend du moteur d'agent. La plupart viennent de deux bugs d'EPURE :

- **Résolutions de conflit à un seul parent.** EPURE commite ses résolutions de conflit avec un seul parent. Git n'enregistre donc jamais que la base a été intégrée, et la PR reste en conflit.
- **Réintégration du plan à chaque exécution.** EPURE recommite les artefacts du plan sur `feature/*` à chaque exécution : 61 commits sur `feature/71`, environ un toutes les 4 minutes. La branche de fonctionnalité bouge donc sans cesse sous les PRs de tickets ouvertes.

## 1. Conflits de merge (19 escalades) : non couverts par le lot 1

- **9 : fichiers sensibles modifiés seulement sur `dev`.** EPURE escalade quand un fichier sensible a changé uniquement sur `dev`, alors que rien n'est en conflit. Chaque cas suit de quelques minutes un commit humain sur `.github/agents.yml` ou `.cursor/agents/*`, que les instructions d'escalade d'EPURE demandent justement de modifier. Issue : [#103](https://github.com/Giskard-AI/epure/issues/103).
- **6 : faux « marqueurs de conflit ».** Classés comme qualité du LLM, ce sont en fait un bug de code. Le contrôle détecte toute ligne contenant `=======`, et un humain avait ajouté des bannières de commentaire `// ====` dans les quatre fichiers concernés. Issue : [#104](https://github.com/Giskard-AI/epure/issues/104).
- **2 : merge de PR de ticket refusé (HTTP 405).** La branche de fonctionnalité avait bougé sous la PR de ticket, et EPURE signale le 405 comme une erreur interne au lieu de resynchroniser. Issue : [#105](https://github.com/Giskard-AI/epure/issues/105).
- **2 : « plus de 8 fichiers en conflit ».** Cause probable : EPURE compte les fichiers modifiés des deux côtés, pas les vrais conflits, et ce nombre grossit parce que la base de merge n'avance jamais. Issue : [#105](https://github.com/Giskard-AI/epure/issues/105).
- La réintégration permanente du plan aggrave tous ces cas. Issue : [#106](https://github.com/Giskard-AI/epure/issues/106).

## 2. Timeouts d'enregistrement de la CI (4 escalades) : non couverts

Ce n'est pas un délai d'enregistrement : aucune exécution de CI externe n'est jamais apparue sur ces quatre commits. Les PRs #90 et #113 étaient en conflit, et GitHub ne lance pas les workflows `pull_request` sur une PR en conflit. La CI n'est revenue qu'après un vrai merge à deux parents poussé par le mainteneur. Issues : [#105](https://github.com/Giskard-AI/epure/issues/105) et [#106](https://github.com/Giskard-AI/epure/issues/106).

## 3. Erreurs de l'API GitHub (17 escalades, plus les deux 405 comptés plus haut)

- **10 : rate limit (403), six epics en 8 minutes le 31 octobre.** Le lot 1 ([#96](https://github.com/Giskard-AI/epure/issues/96)) couvre les nouvelles tentatives, l'escalade reprenable et la suppression du déclencheur `check_suite`. Reste non couvert :
  - EPURE télécharge l'arbre complet du dépôt pour chaque fichier lu ;
  - une erreur de lecture est traitée comme un fichier absent, si bien qu'un fichier qui échoue pendant un 403 serait supprimé de la branche cible.

  Issue : [#110](https://github.com/Giskard-AI/epure/issues/110).
- **2 : « changes must be made through a pull request » (422).** Le ruleset `feature/*` généré par `setup-repo` n'autorise le contournement de l'agent que par PR, alors qu'EPURE pousse directement. Le mainteneur a corrigé à la main deux minutes plus tard. Issue : [#108](https://github.com/Giskard-AI/epure/issues/108).
- **4 : courses en écriture.** Trois 404 sur des branches qu'EPURE venait de créer, et un 422 cinq secondes après un push humain. Les mises à jour de branche utilisent `force: true`, ce qui aurait effacé ce commit humain si GitHub l'avait accepté. Issue : [#109](https://github.com/Giskard-AI/epure/issues/109).
- **1 : « base invalid » (422).** L'humain a mergé #134 pendant l'exécution, GitHub a supprimé `feature/98`, et EPURE a tenté d'ouvrir une PR vers cette branche. Issue : [#107](https://github.com/Giskard-AI/epure/issues/107).

## 4. PRs en double : partiellement couvertes

- **PRs de fonctionnalité #55, #59 et #133.** Chacune commence par un commit de réintégration du plan fait juste après le merge humain de la PR précédente. Le lot 1 bloque la seconde PR, mais pas le commit en trop sur `feature/*`. Issue : [#106](https://github.com/Giskard-AI/epure/issues/106).
- **PR de ticket #122.** Ouverte après le merge humain de #97, qu'EPURE n'a jamais détecté. Issue : [#107](https://github.com/Giskard-AI/epure/issues/107).
- **Noms de branche de correction de revue réutilisés.** Le même nom de branche a servi pour plusieurs PRs, toutes auto-mergées sans escalade. Le lot 1 persiste désormais le compteur, ce qui devrait corriger ce cas.

## Causes confirmées

| Cause | Escalades | Issue | Confiance |
| --- | --- | --- | --- |
| Fichier sensible modifié seulement sur la base | 9 | [#103](https://github.com/Giskard-AI/epure/issues/103) | Haute |
| Faux marqueur de conflit `=======` | 6 | [#104](https://github.com/Giskard-AI/epure/issues/104) | Haute |
| Résolution de conflit à un seul parent | 4 + 4 timeouts CI | [#105](https://github.com/Giskard-AI/epure/issues/105) | Haute (moyenne pour « plus de 8 fichiers ») |
| Réintégration du plan à chaque exécution | Aggravant, 3 PRs en double | [#106](https://github.com/Giskard-AI/epure/issues/106) | Haute |
| Merges humains non détectés | 1 + 1 PR en double | [#107](https://github.com/Giskard-AI/epure/issues/107) | Haute |
| Ruleset `feature/*` incompatible avec les pushs directs | 2 | [#108](https://github.com/Giskard-AI/epure/issues/108) | Haute |
| Courses en écriture de branche | 4 | [#109](https://github.com/Giskard-AI/epure/issues/109) | Moyenne à haute |
| Lectures de fichiers trop coûteuses, erreurs lues comme absences | Aggravant du rate limit | [#110](https://github.com/Giskard-AI/epure/issues/110) | Moyenne |
| Rate limit sans nouvelle tentative | 10 | [#96](https://github.com/Giskard-AI/epure/issues/96) (lot 1) | Haute |
