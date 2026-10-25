# Guide : Piloter une Issue de Bout en Bout

Ce guide fournit la marche à suivre opérationnelle pour piloter une fonctionnalité ou une correction complexe depuis l'ouverture de l'Issue GitHub jusqu'à la PR finale `feature/* -> dev`, y compris l'utilisation des commandes facultatives et la reprise sur incident.

---

## 1. Lancer le Plan (`/epure plan`)

1. Ouvrez une Issue GitHub décrivant l'objectif, le besoin utilisateur ou le périmètre souhaité.
2. Postez `/epure plan` en commentaire.
3. Patientez quelques secondes pendant que le workflow `epure-issue-command` publie la **Ronde 1 du Grill**.

### Bonnes Pratiques pour Répondre au Grill

- **Répondez en Markdown ordinaire** : inutile de répéter `/epure` tant que l'issue est en phase `grilling`.
- **Plusieurs commentaires successifs sont supportés** : grâce au curseur de lot (`last_processed_comment_id`), si vous ajoutez un second commentaire de précision pendant qu'un run est en file d'attente, EPURE traitera tous vos commentaires dans l'ordre chronologique.
- **Forcer le passage à la Spec (Facultatif)** : si vous estimez le cadrage suffisant et souhaitez générer immédiatement la spécification, commentez `/epure to-spec`.

---

## 2. Relire la Pull Request `plan/*`

Une fois le Grill terminé, EPURE ouvre une PR `plan/<issue>-<slug> -> dev` et crée le DAG de tickets. Avant de poster `/epure approve`, vérifiez :

1. **`GLOSSARY.md`** : les nouveaux termes du domaine sont-ils exacts et sans ambiguïté ?
2. **`docs/adr/`** : les ADRs reflètent-ils fidèlement vos décisions ?
3. **`DESIGN.md` (si une UI est concernée)** : les tokens de couleur, la typographie et les états d'interaction correspondent-ils à votre produit ?
4. **`docs/specs/<slug>.md` & DAG de Tickets** : les critères d'acceptation et les liens `blocked_by` entre tickets sont-ils cohérents ?

---

## 3. Approuver & Suivre l'Exécution (`/epure approve` & `/epure status`)

Postez `/epure approve` sur l'issue de pilotage.

- Pour consulter l'avancement à tout moment sans ouvrir l'onglet Actions, commentez `/epure status` ou consultez le **Tableau de Bord EPURE** épinglé en haut du corps de l'issue.
- Dans les journaux GitHub Actions du job, dépliez les groupes structurés `::group::` pour inspecter :
  - La sortie des tests et du build TDD dans la sandbox sans secret pour chaque ticket.
  - Les appels d'outils en lecture seule (`read_file`, `search_code`) effectués par chaque reviewer spécialisé.
  - Le verdict détaillé de chaque reviewer (`approved` vs `changes_requested`).

---

## 4. Gérer une Escalade `needs-human` & la Reprise Idempotente

EPURE interrompt l'automatisation et pose le label `needs-human` dans deux cas :

1. **Modification d'un Chemin Sensible** : une branche `task/*` a modifié `.github/workflows/**`, `.github/agents.yml`, `.cursor/agents/**` ou `CODEOWNERS`.
   - *Résolution* : inspectez le diff. Si la modification est légitime, ajoutez le label `approved-sensitive-change` sur la PR puis commentez `/epure approve` sur l'issue de pilotage.
2. **Plafond d'Auto-Remédiation Atteint (`max_code_fix_attempts = 3`)** : un ticket a échoué aux tests ou aux constats `must_fix` 3 fois consécutives.
   - *Résolution* : poussez un commit de correction sur la branche `task/*` ou `feature/*` (ou clarifiez la spec), puis repostez `/epure approve` sur l'issue de pilotage. La **reprise idempotente** d'EPURE ignore automatiquement les tickets déjà fermés et reprend exactement au point d'arrêt.
