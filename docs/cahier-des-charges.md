# execution-continuity-evaluator — cahier des charges

Maturité : prototype

Provenance : ce document reprend la spécification de mission
`specs/execution-continuity-evaluator/cahier-des-charges.md` de l'analyse du 2026-10-14. Changements :
les sections 1.3, 1.4, 4.1, 4.2, 5 (EF-10), 6 (ENF-8), 7.3, 8.2, 8.4, 12 (risques R-11 à R-15) et la
table de la section 13, qui portent la décision du propriétaire du 2026-10-23 (ADR-0058 :
`tools/review` premier consommateur LangGraph JS de la flotte, sous ADR-0045) ; la comparaison section
à section avec la mission, relevée le 2026-10-23, montre en plus des écarts dans les sections 1.1,
1.5, 3, 7.1, 8.1, 8.3, 10, 11.1 et 11.2, non classés ici entre décision LangGraph et réécriture de forme ;
les critères CA-18 à CA-30, ajoutés à la suite des dix-sept critères de la mission, dont le texte est
inchangé aux réécritures de forme près ; et ces réécritures, exigées par la norme des paquets de
travail de `libre-ai/project-governance` (`docs/specifications/WORK-PACKAGES.md`) : chaque paramètre
écrit entre chevrons y est écrit en capitales (`ORG/DEPOT`, `DEPOT-CONSOMMATEUR`, `REV`,
`SUJET/SHA`), le jalon B prime s'écrit `B'`, et les commandes qui enchaînent deux programmes sont
écrites en deux temps (« puis »). `prd.md` est à côté de ce fichier ; `architecture.md`,
`tests-et-evaluation.md`, `questions-ouvertes.md`, `CADRAGE.md`, `clones.json` et `inventaire/`
désignent l'analyse de mission et ne sont pas dans ce dépôt.

Portée du niveau : « prototype » qualifie le **projet observé** (0 consommateur dans la flotte,
« built, not integrated » au sens d'I-09, section 1.4), pas ce document, qui est une proposition de
la mission. La fiche porte `maturity: usable` (`grep -n '^maturity:' project.v1.yaml`) : échelle de
la fiche et échelle du brief diffèrent, et l'écart est consigné (section 1.4) sans être arbitré.

Dépôt : `libre-ai/execution-continuity-evaluator`, lu au commit que rend `git rev-parse HEAD` (le
2026-10-23 : `5d3275ec6bf5d48cf3cf4fba5ebf81945e11ab90`, même commit que la mission du 2026-10-14,
dernier commit 2026-10-13T23:54:58+02:00). Toute référence `chemin:ligne` sans préfixe de dépôt vise
ce dépôt à ce commit. La doctrine est lue dans `libre-ai/project-governance` au commit que rend
`git -C DEPOT-GOVERNANCE rev-parse HEAD` (la mission l'a lue à `c600e5ddea2a53d0475b79708b9ecfc54e5651ce` ;
les citations d'ADR-0058 et d'ADR-0045 de ce document sont lues à
`cd39dfd2861f183fe1472631f809b390bb3c8a4e`, qui porte ADR-0058 fusionné).

## 1. État des lieux

### 1.1 Identité et rôle

- Crate Rust `libre-ai-agent-orchestrator` 0.4.0, édition 2024, Rust 1.97, `publish = false`
  (`Cargo.toml:2-8`). Le manifeste Bun se nomme `@libre-ai/orchestrator-gates` (`package.json:2`).
  Le dépôt se nomme `execution-continuity-evaluator` (LEXICON section 1.1 ligne 58 : nom public
  « Libre AI Execution Continuity Evaluator »). Trois noms pour un objet : le nom de crate est une
  exception nommée du LEXICON (section 4 « cohérence de famille », `libre-ai-agent-orchestrator`
  conservé).
- `Cargo.toml:7` déclare `repository = "https://github.com/libre-ai/libre-ai"`, le moyeu archivé
  (I-02, I-23). Écart de métadonnée, sans effet sur la compilation.
- Inventaire : `role: satellite`, `layer: couche-2`, `visibility: public`, `lifecycle: active`,
  `owns: agent orchestration and its proof surface`
  (`project-governance/ecosystem/repositories.v1.yaml:182-189` ;
  `grep -n -A8 'repository: libre-ai/execution-continuity-evaluator' ecosystem/repositories.v1.yaml`).
- Architecture de la fabrique : « Continuity evaluation | execution-continuity-evaluator | Evaluates
  observed effects; does not acquire mission authority »
  (`project-governance/docs/architecture/forge/REPOSITORY-ARCHITECTURE.md:20`).
- Fiche de la méthode : dépendance « decision core and review fan-out of the method's agent loops »
  (`project-governance/ecosystem/cards/method.project.v1.yaml:56-58`).
- Génération de flotte : `0db2e10e` (2026-10-13), `code-validation.yml:13,17` ;
  `project-governance/ecosystem/fleet-pins.v1.yaml:208-210`.

### 1.2 Ce que le code fait

Quatre modules sous `src/` (`src/lib.rs:4-7`), 3 746 lignes, 64 symboles publics
(`grep -vcE '^#|^$' tests/compat/public_surface.snapshot`), 97 codes stables
(`grep -vcE '^#|^$' tests/compat/stable_codes.snapshot`) :

| Module | Fonctions publiques | Contrat lu | Ce qu'il décide |
| --- | --- | --- | --- |
| `control.rs` | `parse_control_document`, `command_fingerprint`, `evaluate_control`, `evaluate_simulated_effect` (`src/control.rs:260,275,340,326`) | `orchestrator-control.v1.schema.json` (`:8`) | `start` / `pause` / `resume` / `cancel` d'un run contre un `RunControlState` et un `StartPreflight` fournis par l'appelant ; reçu idempotent ; 17 refus |
| `budget.rs` | `evaluate_budget_event` (`src/budget.rs:62`) | types `event_chain` de `libre-ai-contract-types` | un événement causal contre `PlanBudgetLimits` (7 compteurs, `:7-16`) et l'état accepté présenté ; 3 refus propres |
| `authorized_execution/` | `parse_authorized_graph`, `evaluate_graph`, `select_graph_transition`, `evaluate_graph_authority`, `parse_authorized_execution_event`, `evaluate_causal_transition`, `replay_authorized_execution`, `evaluate_human_decision`, `evaluate_bound_human_decision`, `evaluate_execution_transfer`, `evaluate_effect_attestation` (`src/authorized_execution/mod.rs:10-34`) | `execution-graph.v1`, `execution-plan-body.v2`, `orchestrator-event.v3`, `human-decision-request.v1`, `human-decision-response.v1`, `execution-transfer.v1`, `effect-attestation.v1` | graphe acyclique borné, routage fermé `(stepId, outcomeCode)`, rejeu causal déterministe avec quarantaine, décision humaine liée à la politique de son pas, transfert de génération, continuité d'effet (`effect-state-unknown` rendu sur une attestation au statut déclaré `state-unknown`, `effect.rs:267-268`) |
| `tool_observation.rs` | `evaluate_tool_observations` (`src/tool_observation.rs:313`) | `tool-invocation-observation.v1.schema.json` (`:45`, contrat `candidate`) | un des 7 verdicts fermés d'ADR-0046 décision 4, avec compteurs ; signature vérifiée par un `HarnessSignatureVerifier` fourni par l'appelant (`:54-59`) |

Tout document est validé par le registre embarqué avant lecture, et tout document scellé voit son
sceau recalculé (`src/authorized_execution/document.rs:502-522`). Aucune valeur rejetée n'est
reflétée : les refus sont des codes constants (`src/control.rs:264-272`).

### 1.3 Ce que le dépôt porte en plus de la crate

- `tools/review/` : éventail de revue par rôle contre un commit immuable, `fanout.ts` (effets :
  `git worktree add --detach`, `Bun.spawn(["pi", ...])`, retrait du worktree en `finally`,
  `tools/review/fanout.ts:109,114-127,170-173`) et `fanout-core.ts` (logique pure, schéma de
  verdict `review-verdict.v0.1` côté outil, `:38-115`). Dépend de `@libre-ai/envelope`
  (`tools/review/package.json:12`). Le skill `review-fanout` de `project-governance` renvoie vers ce
  fichier (`project-governance/skills/review-fanout/SKILL.md:23-24`). Espace de travail Bun propre
  (`tools/review/package.json`, `tools/review/bun.lock`, `tools/review/bunfig.toml` avec
  `minimumReleaseAge = 259200`) ; 8 fichiers suivis (`git ls-files tools/review`, puis `wc -l`) ;
  45 tests (`grep -c '^\s*test(' tools/review/fanout-core.test.ts`, mesure du 2026-10-23) ; aucune
  mention de LangGraph dans son code (`grep -c -i 'langgraph' tools/review/fanout.ts tools/review/fanout-core.ts`
  rend 0 et 0). Aucun modèle n'est appelé depuis TypeScript : le modèle est dans `pi`, lancé en
  sous-processus avec les outils par défaut de `pi` (`read`, `bash`, `edit`, `write` ; `pi --help`),
  c'est-à-dire avec des outils à effet au sens d'ADR-0045 INV-a.
- `verification/agent-orchestrator/check-capabilities.ts` : frontière d'effets exécutable.
- `docs/apps/orchestrator.md` : spécification sous Specification Lock à deux couches (« Implemented » /
  « Target », `docs/apps/orchestrator.md:3`). `docs/apps/memory.md` : brouillon de spécification
  « Memory — Agent Persistent Recall » (`:1-3`), **sans code dans ce dépôt**, vérifié par
  `check:specifications --apps orchestrator memory` (`package.json:34`) ; le LEXICON le re-scope
  comme feuille de route de ce dépôt (LEXICON ancien section 8.4 et section 10.1 ; à
  retrouver par `grep -n 're-scopé' docs/decisions/LEXICON.md` dans `project-governance`). `docs/apps/harness.md` : redirection vers `execution-sandbox` (une ligne).
- `docs/research/orchestration-patterns/` : catalogue `research-non-normative` de 10 patterns étudiés
  sur `langchain-ai/langgraphjs@c6910a9e` (ADR-0032 D1). ADR-0058 en fait aussi la liste des
  scénarios de panne contre lesquels le premier worker LangGraph est qualifié (Conséquences).
- `docs/reviews/` : preuves des revues (voir `tests-et-evaluation.md` section 1.4).
- `benches/authorized_execution_replay.rs`.

### 1.4 État déclaré et état observé

| Surface | Déclaré | Observé | Écart |
| --- | --- | --- | --- |
| Maturité | `usable`, `confidence: medium`, `exposure: spec-published` (`project.v1.yaml:78-80`) | code, tests, preuves présents ; 0 consommateur dans la flotte (`grep -rn 'libre-ai-agent-orchestrator' .clones/*/Cargo.toml .clones/*/crates/*/Cargo.toml` rend 0 hors ce dépôt) | « built, not integrated » au sens d'I-09 |
| Fraîcheur | `last_verified_on: 2026-09-10` (`:82`) | 0.3.0 et 0.4.0 datées du 2026-10-09 (`docs/compat/BREAKS.md`) | fiche en retard d'une version majeure fonctionnelle |
| Noyau | « authorized-execution 0.2.0 ... prouvé » (`:22`) | crate 0.4.0 (`Cargo.toml:3`) | texte de situation périmé |
| Preuve `consumed-pinned` | « gate-acceptance-log 2026-07-29, PRs hub #279-#283 » (`:107`) | moyeu archivé (I-23) | référence non résoluble depuis ce dépôt `[NON VÉRIFIÉ]` |
| Couverture | script 87 % lignes / 90 % fonctions (`tools/quality/rust-coverage.sh:14-15`) | `check:coverage` absent de `check` (`package.json:30`) | seuil non appliqué par la chaîne requise |
| Licence | EUPL-1.2 (`Cargo.toml:6`, `package.json:4`, `REUSE.toml:7`), CC-BY-4.0 pour README et `docs/portfolio-material.json` (`REUSE.toml:10-13`) | aucun `LICENSE` racine ; `LICENSES/EUPL-1.2.txt` et `LICENSES/CC-BY-4.0.txt` présents ; GitHub résout `null` (fiche, `licence.source[3]`) | conforme I-11 ; détection GitHub nulle |
| LangGraph | non-objectif « faire de LangGraph une autorité ou une dépendance normative » (`project.v1.yaml:39-41`, texte du 2026-09) | ADR-0058 (2026-10-23) admet le paquet comme runtime du graphe interne d'un worker TypeScript et de l'outillage de forge, jamais comme autorité ; la fiche n'en dit rien | fiche à mettre à jour (CA-30) : le non-objectif reste vrai pour l'autorité, il ne couvre plus la dépendance de `tools/review` |

### 1.5 Contradictions héritées de l'inventaire qui nomment ce dépôt

- **E3** (Work Supervision : outil de la fabrique ou produit) : décide si ce cœur a un utilisateur
  externe ou seulement la fabrique — instruit dans `questions-ouvertes.md` Q1.
- **E22** (cycles de composition inversant les couches) : ce dépôt n'est dans aucun des quatre cycles
  de `synthese.md` section 3.4 ; il consomme `project-governance` et `schemas-and-contracts` par
  `file:../` (`package.json:12-16`) et par git-dep, sans être consommé. Instruit dans
  `questions-ouvertes.md` Q6 pour ce qu'il implique de la composition locale.
- **Fiche, `contradictions_doc_code[0]`** : ADR-0042 section 1 nomme deux composants de la fabrique
  (Work Supervision, confinement) et pas ce cœur — Q1.

## 2. Problème résolu

Une décision de contrôle d'agent prise au milieu du code qui l'exécute est impossible à rejouer sans
effet de bord, impossible à tester sans lancer une mission, et impossible à opposer après la course
(`project.v1.yaml:10`). Le composant sépare **décider** d'**agir** : chaque décision est une fonction
pure sur des identifiants opaques et des observations que l'appelant déclare, qui rend un code fermé
et, au plus, une **proposition d'application** (`ControlApplication`, `EffectApplication`,
`TransferApplication`) que l'appelant persiste ou exécute lui-même. Trois trous fermés par les
contrats qu'il rejoue :

1. une attestation d'effet au statut déclaré `state-unknown` n'est jamais lue comme un succès :
   `evaluate_effect_attestation` rend `ContinuityBarrier` (code `effect-state-unknown`) et aucune
   proposition d'application (`src/authorized_execution/effect.rs:267-268,280`) ; une attestation
   `reserved` ou `started` rend `transition-forbidden` (`effect.rs:277-279`,
   `tests/authorized_execution_effect.rs:372-380`) et une observation indisponible rend
   `store-unavailable` (`effect.rs:227-229`, `tests/authorized_execution_effect.rs:359-369`). La
   conversion « aucun statut terminal observé » vers une attestation `state-unknown` est faite par
   l'appelant (`tests/authorized_execution_crash_e2e.rs:164-172`) ; la crate ne détecte pas
   l'absence et n'a pas d'état « lignée bloquée » (`EffectDecision` n'en porte pas). ADR-0034 D4
   (accepted) demande `EffectStateUnknown` aussi pour `started` et pour une observation
   indisponible (`docs/adr/0034-*.md:228-231` de `project-governance`) : écart signalé en Q9 ;
2. une étape répétée sous le plafond `maxToolCalls` reste invisible aux budgets : l'observation
   d'appels d'outil rend `no-progress` sur k couples identiques dans une fenêtre w (ADR-0046) ;
3. une demande de décision humaine peut inverser ses propres issues ou abaisser le rôle requis :
   `evaluate_bound_human_decision` la lie à la politique de son pas (ADR-0047 Contexte).

## 3. Utilisateurs cibles

Utilisateur primaire du socle : **l'équipe qui pose les règles** (sécurité, conformité, plateforme ;
CADRAGE section 1.4). Pour ce composant, elle n'appelle pas la crate. Hypothèse **non établie** (H6,
`prd.md` section 6) : elle lit les **codes de refus** et les **verdicts** qu'un consommateur
journalise, et elle rejoue un journal `orchestrator-event.v3` hors ligne pour vérifier qu'aucune
transition n'a été prise hors du graphe autorisé. Aucun consommateur ne produit de journal à ce jour
(M2 = 0).

Utilisateurs secondaires :

- le **runtime consommateur** (aujourd'hui aucun ; candidats non déclarés par les candidats eux-mêmes :
  `ai-work-supervision` pour le contrôle et le budget, `execution-sandbox` pour la continuité d'effet
  ; aucune des cinq pièces de `specs/execution-sandbox/` ne cite ce composant, voir Q11) ;
- l'**auditeur**, qui vérifie un verdict en recomputant les sceaux et en rejouant les vecteurs ;
- le **développeur sous règles**, qui écrit un plan et reçoit un refus à code stable, jamais la
  valeur rejetée ;
- le **relecteur de la méthode**, qui lance `tools/review` sur un commit immuable et lit les verdicts
  par rôle sous supervision humaine (I-17).

Agents de code visés par la neutralité protocolaire (CADRAGE section 1.4) : la crate ne connaît aucun
agent ; elle lit des documents de contrat. Claude Code, Codex et Pi n'entreraient que par un harness
producteur de `tool-invocation-observation.v1`, hors de ce dépôt ; ce producteur n'a aucun porteur
déclaré au commit lu (Q11). `tools/review` lance `pi` seulement (`fanout.ts:114-127`).

## 4. Périmètre

### 4.1 Dans le périmètre

- La crate pure et ses quatre surfaces (section 1.2), sa politique de compatibilité
  (`project.v1.yaml:108-131`), sa frontière d'effets exécutable.
- Le rejeu des vecteurs de l'autorité de contrats à la révision épinglée.
- `tools/review` tant qu'il n'a pas de second producteur du schéma de verdict (`project.v1.yaml:39`),
  et, depuis le 2026-10-23, sa réalisation sur LangGraph JS comme premier consommateur du runtime
  admis par ADR-0058 : graphe rôles → lots → vérification → agrégation, passes `pi` en nœuds-outils,
  contrat observable inchangé (plan JSON, verdicts, ajout seul, nettoyage `finally`), six conditions
  d'entrée d'ADR-0058 section 3, INV-a à INV-c d'ADR-0045 avec leurs vecteurs rouges, preuve de
  retrait d'ADR-0058 section 4 (CA-18 à CA-30).
- La preuve de performance de référence (banc).

### 4.2 Hors périmètre (non-objectifs, `project.v1.yaml:34-41`, repris sans réécriture)

- Exécuter ce qui est autorisé : ni processus, ni fichier, ni socket, ni variable d'environnement, ni
  secret, ni persistance, ni bac à sable, ni harnais, ni adaptateur de fournisseur.
- Tenir l'état accepté ; vérifier un jeton Biscuit ou une enveloppe : l'appelant déclare des
  booléens (`StartPreflight`, `src/control.rs:114-130`) et la crate les tient pour des faits
  (`docs/apps/orchestrator.md:54`).
- Revendiquer WP-G3-O01 (frontière de run, PostgreSQL, idempotence au point d'effet, journaux sans
  donnée personnelle, rétention, tombstones, rejeu de restauration, déploiement).
- Promouvoir `review-verdict.v0.1` au rang de contrat avant un second producteur.
- Faire de LangGraph une autorité (ADR-0032 D2, D3, D4, maintenus mot pour mot par ADR-0058) :
  aucun type du paquet dans un contrat, un verdict ou un journal ; aucun checkpointer ni store
  externe ; aucun service managé de l'éditeur ; aucune dépendance LangGraph dans `Cargo.toml`
  (ADR-0037 D6) ; le paquet `langchain` (chaînes, modèles de prompt, chargeurs) n'est pas admis
  (ADR-0058 section 1).
- Appeler un modèle depuis TypeScript dans `tools/review` : le modèle reste dans `pi` ; l'adoption de
  LangGraph n'ajoute aucun client de fournisseur.
- Toute interface humaine.

## 5. Exigences fonctionnelles

- EF-1 — Toute fonction publique est déterministe : même entrées, même sortie, sans lecture
  d'horloge, d'environnement ni de magasin (ADR-0037 D1 ; `check-capabilities.ts:17-39`).
- EF-2 — Tout document d'entrée est validé contre son schéma verrouillé avant toute lecture de
  champ, et tout document scellé a son sceau recalculé (RFC 8785 puis SHA-256) avant lecture
  (`document.rs:502-556`).
- EF-3 — Toute observation déclarée indisponible par l'appelant produit un refus fermé, jamais une
  valeur supposée (ADR-0037 D2 ; `budget.rs:67-73`, `effect.rs:227-229`, `replay.rs:81-83`,
  `control.rs:357-359`).
- EF-4 — Un duplicat octet-identique est idempotent ; un duplicat divergent refuse ou met en
  quarantaine (`replay.rs:84-96`, `control.rs:360-371`, `effect.rs:249-255`, `transfer.rs:191-199`).
- EF-5 — Le routage ne sélectionne qu'une arête par couple `(stepId, outcomeCode)` ; un résultat
  inconnu, une route absente ou ambiguë bloque (ADR-0034 D1 ; `GraphRefusal`, `graph.rs:14-25`).
- EF-6 — L'observation d'appels d'outil rend exactement un verdict parmi sept, dans l'ordre fixé par
  ADR-0046 décision 4, et imprime ses compteurs (`tool_observation.rs:96-106,335-349`).
- EF-7 — L'évaluateur d'observation ne détient aucune clé : les empreintes sont comparées, jamais
  calculées ; la signature est vérifiée par un trait fourni par l'appelant (OBS-b, OBS-c ;
  `tool_observation.rs:54-59`).
- EF-8 — Toute rupture de la surface publique ou d'un code stable exige, dans le même commit, une
  montée de version et une entrée dans `docs/compat/BREAKS.md` ; `cargo test --locked` échoue sinon
  (`tests/compat_surface.rs`).
- EF-9 — `tools/review` crée ses worktrees détachés sur le commit revu et les retire en `finally`,
  refuse un verdict qui porte un finding bloquant avec un `approve` (commit `60c33eb`, PR #9), et
  refuse d'écraser un verdict enregistré (`fanout.ts:235-244`).
- EF-10 — Le contrat observable de `tools/review` ne change pas avec le runtime LangGraph : même plan
  JSON en entrée (`parsePlan`, `fanout-core.ts:112`), même schéma de verdict (`reviewVerdictSchema`,
  `$id` `review-verdict.v0.1`, `fanout-core.ts:42-107`), même journal `events.jsonl` en ajout seul
  et mêmes types d'événements (`ReviewEventType`, `fanout-core.ts:400-408`), même nettoyage
  `finally` ; le graphe est interne et opaque (ADR-0032 D3), et le chemin d'exécution sans le paquet
  reste vivant (CA-29).

## 6. Exigences non fonctionnelles

Cadres réglementaires de CADRAGE section 1.3, marqués un par un.

- ENF-1 — **Refus à codes constants ; sortie sans valeur rejetée** : un refus est un code constant
  (`src/control.rs:264-272`), aucune API de journalisation (ADR-0037 D2). État des `Debug` au commit
  lu (`grep -rn 'impl.*Debug for' src`, puis `wc -l`, rend 12 implémentations manuelles rédigées, dont
  `effect.rs:31`, `transfer.rs:35`, `replay.rs:21`, `tool_observation.rs:189`, `decision.rs:48,78`,
  `document.rs:23,274`, `graph.rs:85`) ; en revanche cinq types de la surface 0.1.0 **dérivent**
  `Debug` et portent des identifiants ou des digests : `ControlCommand` (`src/control.rs:20-35`),
  `RunControlState` (`:99-109`), `StartPreflight` (`:113-130`), `CommandReceipt` (`:162-167`),
  `PlanBudgetLimits` (`src/budget.rs:6-8`) ; deux énumérations dérivées les portent par référence :
  `CommandCollisionObservation` (`src/control.rs:169-174`, contient une référence à `CommandReceipt`) et
  `EventStoreObservation` (`src/budget.rs:31-38`, contient des faits d'événement du crate de
  contrats). L'énoncé « zéro donnée personnelle dans toute sortie » n'est donc **pas établi** : il
  vaut pour les types à `Debug` rédigé, pas pour ces sept (CA-5, CA-16, R-10). Les identifiants de
  fil sont `tenant-private` et pseudonymes (ADR-0034 D3).
  Cadres : **RGPD** (minimisation, art. 5-1-c) `[NON VÉRIFIÉ]` ; **AI Act** (journalisation, art. 12)
  `[NON VÉRIFIÉ]` ; NIS2 et DORA : non applicables à une bibliothèque sans exploitation ; RGS /
  SecNumCloud : non applicables (aucun hébergement).
- ENF-2 — **Traçabilité rejouable** : un journal `orchestrator-event.v3` complet se rejoue en un état
  identique à l'octet (`replay_authorized_execution`). Qu'un auditeur recompute chaque sceau sans la
  crate (RFC 8785 + SHA-256) est une hypothèse `[NON VÉRIFIÉ]` : aucune implémentation indépendante
  ni test du dépôt ne l'établit, le seul second implémenteur est l'oracle TypeScript de l'autorité
  que la crate n'a pas le droit d'appeler (ADR-0037 D3). Cadres, textes non consultés dans la
  mission : **AI Act** art. 12 et 14 (traçabilité, contrôle humain par `human-decision-request.v1`)
  `[NON VÉRIFIÉ]` ; **DORA** art. 11-12 (réponse, rétablissement ; l'article 9-10 initialement cité
  porte prévention et détection) `[NON VÉRIFIÉ]`, applicable au consommateur qui persiste ;
  **NIS2** art. 21-2-b (gestion des incidents) `[NON VÉRIFIÉ]`, idem par le consommateur.
- ENF-3 — **Isolation par construction** : aucune chaîne libre d'un document ne sélectionne une
  transition ; seul le couple fermé `(stepId, outcomeCode)` route (ADR-0037 « Sécurité et vie
  privée » ; I-32 pour la frontière de l'appelant). Cadre : **AI Act** art. 15 (robustesse,
  résistance à la manipulation). Pour `tools/review`, la même exigence est celle d'ADR-0045 INV-a à
  INV-c (section 8.2, CA-26 à CA-28).
- ENF-4 — **Reproductibilité de la chaîne d'approvisionnement** : dépendances épinglées à la version
  exacte (`Cargo.toml:14-19`), git-dep intra-organisation par SHA complet (`deny.toml`
  `[sources.allow-org]`), `cargo-deny` 0.19.5 épinglé par SHA-256 d'archive, licences entrantes
  limitées à la liste de `deny.toml:34-47` (ADR-0042 section 4, section 11). Côté Bun, l'espace de
  travail `tools/review` épingle ses versions exactes, commet son verrou et impose un âge de
  publication de trois jours (`tools/review/bunfig.toml:2`, `minimumReleaseAge = 259200`) ; le paquet
  LangGraph entre à ces mêmes conditions (CA-19). Cadres : **NIS2** art. 21-2-d (sécurité de la
  chaîne d'approvisionnement ; cité 21-2-e dans la première rédaction, lettre corrigée à la lecture
  du relecteur) `[NON VÉRIFIÉ]` ; **DORA** art. 28 (tiers TIC) `[NON VÉRIFIÉ]` ; **RGS** : exigence
  de maîtrise des composants, applicable au consommateur hébergé.
- ENF-5 — **Performance de référence** publiée et rejouable : `cargo bench --bench authorized_execution_replay`
  aux maxima contractuels (256 étapes, 512 arêtes, 767 événements), baseline 0.2.0 du 2026-09-10 :
  `docs/reviews/authorized-execution-native-core/1ae6b88/benchmark.txt` (0.2.0, 2026-09-10) ;
  aucune mesure de 0.3.0 ni 0.4.0 (CA-10) ; aucun seuil matériel en CI (ADR-0037 D3). Aucun cadre
  réglementaire ; axe performance.
- ENF-6 — **Compatibilité** : additive depuis 0.2.0, trois entrées au journal des ruptures, instantanés
  de 64 symboles et 97 codes (`docs/compat/BREAKS.md`). Aucun cadre ; axe qualité.
- ENF-7 — **Licence** : EUPL-1.2 sur le code, CC-BY-4.0 sur la documentation publique (I-11, E10 :
  aucun écart constaté sur ce dépôt ; `REUSE.toml`). Aucune correction de dépôt dans la mission. Le
  graphe de dépendances de `tools/review` reste fermé sur les licences admises par ADR-0042
  section 4 et section 11 (CA-20) ; `@langchain/langgraph` et `@langchain/core` sont MIT (ADR-0058
  Contexte, `npm view PAQUET license`).
- ENF-8 — **Souveraineté de l'outillage de forge** : aucune donnée de revue (prompt, preuve
  enveloppée, sortie de `pi`, verdict, chemin) ne quitte la machine de forge vers un service de
  l'éditeur du paquet ; la télémétrie LangSmith est interdite par construction, par gate textuel et
  par politique réseau (ADR-0058 section 3 condition 4 ; CA-21, CA-22). Cadre : ADR-0042 section 4
  (aucun hyperscaler américain pour le runtime), I-11.

## 7. Interfaces

### 7.1 Entrées

| Entrée | Format | Autorité | Statut au pin `a82d7b54` |
| --- | --- | --- | --- |
| commande de contrôle | `orchestrator-control.v1.schema.json` | `schemas-and-contracts` | `locked` |
| graphe autorisé | `execution-graph.v1.schema.json` | idem | `locked` |
| corps de plan | `execution-plan-body.v2.schema.json` | idem | `locked` (v3 `locked`, v4 `candidate`) |
| événement canonique | `orchestrator-event.v3.schema.json` | idem | `locked` |
| demande / réponse de décision | `human-decision-request.v1`, `human-decision-response.v1` | idem | `locked` |
| transfert de génération | `execution-transfer.v1.schema.json` | idem | `locked` |
| attestation d'effet | `effect-attestation.v1.schema.json` | idem | `locked` |
| fenêtres d'observation d'outil | `tool-invocation-observation.v1.schema.json` | idem | **`candidate`** |
| faits de l'appelant | types Rust `RunControlState`, `StartPreflight`, `CommandCollisionObservation`, `EventStoreObservation`, `EffectObservation`, `TransferObservation`, `DecisionObservation`, `EventCollisionObservation`, `ToolObservationInput`, trait `HarnessSignatureVerifier` | ce dépôt | épinglés par `public_surface.snapshot` |
| horodatage d'évaluation | chaîne RFC 3339 fournie par l'appelant (`control.rs:284-301`, `transfer.rs:161`) | — | — |

Statuts : `git -C .clones/schemas-and-contracts show a82d7b54:contracts/catalog.v1.json`, puis
`jq -r '.contracts[]|"\(.id) \(.status)"'`.

### 7.2 Sorties

Enums Rust de décision, chacune avec `code() -> &'static str` : `ControlDecision`, `BudgetDecision`,
`GraphDecision`, `GraphTransitionDecision`, `AuthorityDecision`, `CausalDecision`, `DecisionDecision`,
`TransferDecision`, `EffectDecision`, `ToolObservationDecision`, plus `AuthorizedExecutionState`
(rejeu) et les applications proposées. Les 97 codes sont énumérés dans
`tests/compat/stable_codes.snapshot`. Aucune sortie HTTP : l'enveloppe `{data, meta}` / `{error}` de
SPECIFICATION-STANDARD n'est pas applicable à cette crate (voir table de conformité).

### 7.3 Interface outillage

`bun tools/review/fanout.ts PLAN.json [--dry-run] [--force]` ; plan validé par `parsePlan`
(`fanout-core.ts:112`) ; verdict JSON validé contre `review-verdict.v0.1` ; journal `events.jsonl`
en ajout seul (`fanout.ts:32-53`). Cette interface est le contrat observable que le runtime
LangGraph ne modifie pas (EF-10) : le graphe, ses nœuds, ses arêtes et son éventuel checkpoint en
mémoire sont internes à l'invocation et n'apparaissent dans aucune entrée ni sortie de l'outil.

## 8. Contraintes de sécurité

### 8.1 Menaces couvertes par construction

| Menace | Contre-mesure | Preuve |
| --- | --- | --- |
| document modifié après scellement | sceau recalculé avant lecture (`document.rs:510-522`) | `tests/authorized_execution_seal.rs` |
| transition choisie par du texte libre d'un worker | routage fermé `(stepId, outcomeCode)` ; graphe acyclique ; `maximum_attempts ≤ 32` | `tests/authorized_execution_graph.rs` ; ADR-0037 |
| effet réémis à l'aveugle après crash | refus de réémission sur attestation `state-unknown` (`effect.rs:267-268,280`) ; une émission par tentative ; fencing comparé ; la conversion « aucun statut observé » vers `state-unknown` est faite par l'appelant (`tests/authorized_execution_crash_e2e.rs:164-172`) ; `started` et observation indisponible : voir Q9 | `tests/authorized_execution_crash_e2e.rs`, `tests/authorized_execution_effect.rs:359-380` |
| demande de décision qui inverse ses issues | liaison à la politique du pas (0.3.0) | `tests/authorized_execution_decision_binding.rs` |
| boucle d'appels d'outil sous le plafond | verdict `no-progress` sur k couples en fenêtre w | `tests/tool_observation_vectors.rs` |
| fuite de contenu ou d'identifiant par diagnostic | `Debug` rédigés sur 12 implémentations manuelles, codes constants, aucune API de log ; **non couvert** : 7 types à `Debug` dérivé portant des identifiants, 5 directement et 2 par référence (ENF-1, CA-16, R-10) | revue vie privée `1ae6b88` de 0.2.0 (2026-09-10) seulement, sans revue sur 0.3.0 ni 0.4.0 (CA-17) ; aucun test automatique (voir `tests-et-evaluation.md` T1) |
| capacité système introduite dans la crate | liste d'autorisation de 6 dépendances, 25 motifs interdits (21 chaînes + 4 expressions régulières), points d'entrée interdits | `check:capabilities` |
| dépendance ou licence hors politique | `cargo-deny` épinglé, `[sources.allow-org] github = ["libre-ai"]` | `check:dependency-policy` |
| reviewer qui écrit dans l'arbre revu | worktree marqué sale → passe invalide (`fanout.ts:143-148`) | `fanout-core.test.ts` |

### 8.2 Menaces hors du périmètre de la crate, à porter par le consommateur

- Un appelant qui ment sur `authorization_active`, `biscuit_allowed`, `harness_attestation_valid` :
  indétectable ici (`docs/apps/orchestrator.md:54`). I-09 (Biscuit) et I-18 (identité d'agent) se
  tiennent dans le consommateur.
- ADR-0037 D2 (accepted) interdit à l'appelant de fournir un verdict déjà classé « autorisé »
  (`docs/adr/0037-*.md:46-52` de `project-governance`). `StartPreflight` reçoit pourtant
  `authorization_valid`, `biscuit_allowed`, `harness_attestation_valid` et `quorum_valid`, des
  verdicts classés (`src/control.rs:113-130`). L'ADR-0037 vise le cœur natif d'exécution autorisée
  et dit que les API de contrôle et de budget gardent leurs signatures (`docs/adr/0037-*.md:119`) ;
  elle ne dit pas si D2 vaut pour cette surface 0.1.0. Écart nommé, non tranché ici.
- I-35 (accepted) : `quorum_valid` est un booléen déclaré par l'appelant sur un quorum d'agents, et la
  crate ne vérifie pas `model-family`. `tools/review` rend des verdicts par rôle sous un seul
  `plan.provider` et un seul `plan.model` (`tools/review/fanout.ts:114-127`) : un verdict d'éventail à
  une famille de modèle ne vaut pas revue au sens d'I-35 et ne remplace pas une revue humaine (I-17).
- Anti-injection I-32 et ADR-0045 : la crate ne place aucune chaîne devant un modèle. `tools/review`
  en place (le prompt de revue contient la preuve enveloppée K3, `fanout.ts:86-91`), et chaque passe
  `pi` détient par défaut `bash`, `edit` et `write`, des outils à effet au sens d'INV-a. I-32 dit que
  K3 « ne compte pour aucune des trois propriétés » et ADR-0045 décision 4 dit que l'orchestrateur
  de revues « continue de tourner sous I-17, avec supervision humaine, jusqu'à sa date de
  conformité : 2026-12-31 », puis est suspendu s'il ne tient pas INV-a, INV-b et INV-c avec leurs
  vecteurs rouges
  (`libre-ai/project-governance@cd39dfd2861f183fe1472631f809b390bb3c8a4e:docs/adr/0045-indirect-prompt-injection-isolation-by-construction.md:84-86`,
  `:94`, `:123`). ADR-0058 section 1 cumule cette condition d'activation avec l'adoption du runtime :
  le graphe LangGraph « ne prouve aucun de ces invariants par lui-même ». Réponse de ce cahier : le
  critère CA-26 pour INV-a (les passes ne détiennent aucun outil à effet,
  `pi --tools read,grep,find,ls --no-mcp` est le mode lecture seule documenté par `pi --help`, et
  l'écriture du verdict est faite par l'orchestrateur après validation de schéma), le critère CA-27
  pour INV-b (tout argument d'un effet de l'orchestrateur dérive du plan et du rôle, jamais du
  contenu revu ni de la sortie du modèle), le critère CA-28 pour INV-c (seuls les champs à
  vocabulaire fermé du verdict sont lus par l'agrégation ; les textes libres sont des données non
  fiables écrites pour une lecture humaine), et les vecteurs rouges 1 à 3 d'ADR-0045
  (Conséquences), chacun prouvé rouge sans son contrôle ; le vecteur 4 (suite d'attaques adaptatives)
  n'a ni critère ni paquet dans ce jalon (R-15).
- Vérification Ed25519 : hors crate par choix de frontière (`tool_observation.rs:19-26`) ; le
  consommateur fournit le `HarnessSignatureVerifier` et lie `signing_key_id` à l'attestation de
  harness du run. Conséquence mesurée : le gate `check:capabilities` refuse toute section de
  dépendances autre que `[dependencies]` (`check-capabilities.ts:78-90`) et toute dépendance hors des
  6 admises (`:96-108`), donc aucune bibliothèque de signature, même de développement, n'entre dans
  ce `Cargo.toml` sans toucher le gate : la vérification Ed25519 réelle n'est aujourd'hui exercée
  nulle part dans le dépôt (Q10).

### 8.3 Zéro donnée personnelle en journal

La crate n'a aucun journal. Les identifiants wire (`tenant_id`, `mission_id`, `run_id`,
`organization_id`) sont `tenant-private` et pseudonymes (ADR-0034 D3) ; ils n'apparaissent dans
aucun `Display`. Le consommateur qui journalise un code doit journaliser le code et un identifiant de
corrélation éphémère, jamais le document (SPECIFICATION-STANDARD « Data and privacy baseline »).
Le journal `events.jsonl` de `tools/review` porte des identifiants de passe, des rôles, des types
d'événements, des codes de sortie et des durées, jamais le prompt ni la sortie du modèle
(`fanout.ts:36-53`, `fanout-core.ts:410-419`) ; le runtime LangGraph n'y ajoute aucun champ (EF-10).

### 8.4 Frontière LangGraph (ADR-0058, ADR-0032 D2 à D4)

Menaces propres au paquet, lues sur les avis publiés par l'éditeur (ADR-0058 Contexte,
`gh api repos/langchain-ai/langgraphjs/security-advisories --jq '.[].ghsa_id'` ;
relevé du 2026-10-23 : GHSA-wp87-994x-j95x corrigé à `@langchain/langgraph` 1.4.21 ; GHSA-j87f-x5h5-gr75 à
`@langchain/langgraph` 1.4.12 et `@langchain/langgraph-checkpoint` 1.1.4 ; GHSA-8p8h-xj5r-m5wf à
`@langchain/langgraph-checkpoint-postgres` 1.0.6 et `-redis` 1.0.12 ; GHSA-r399-636x-v7f6 à
`@langchain/core` 1.1.8 ; GHSA-432w-3h3v-2pv4 à `@langchain/langgraph-sdk` 1.12.3 (et
`@langchain/langgraph` 1.4.21) ; GHSA-r3xm-q2gp-xjjg à `@langchain/langgraph-sdk` 1.12.2. Le paquet
`@langchain/langgraph-sdk` est une dépendance directe de `@langchain/langgraph` 1.5.2 (`~1.12.6`) : les
deux derniers avis visent donc le graphe de `tools/review`, et ADR-0058 ne les liste pas (il couvre
« quatre d'entre eux »).)

| Menace | Classe de la flotte | Contre-mesure | Critère |
| --- | --- | --- | --- |
| une entrée du graphe lue comme directive de contrôle (GHSA-wp87-994x-j95x) | I-32, K2 | version ≥ 1.4.21 ; toute entrée du graphe est une donnée ; le routage entre nœuds est fixé par l'orchestrateur, jamais par la sortie de `pi` ; INV-a à INV-c | CA-18, CA-26 à CA-28 |
| désérialisation non sûre (GHSA-j87f-x5h5-gr75, GHSA-r399-636x-v7f6) | K3 | versions corrigées ; aucun octet venu d'ailleurs que du processus de l'orchestrateur n'est relu par les sérialiseurs du paquet ; aucun checkpoint persistant | CA-18, CA-23, CA-25 |
| espaces de noms de stores non isolés (GHSA-8p8h-xj5r-m5wf) | I-09 | aucun paquet `@langchain/langgraph-checkpoint-postgres`, `-redis`, `-mongodb`, `-sqlite` ni store ; checkpoint en mémoire le temps d'une invocation au plus | CA-23 |
| télémétrie LangSmith activée par variable d'environnement | ADR-0032 D4, ADR-0042 section 4 | gate textuel sur `LANGSMITH_*` et les alias `LANGCHAIN_*` ; politique réseau sans hôte de l'éditeur ; vecteur rouge | CA-21, CA-22 |
| dépendance non épinglée, téléchargement à l'exécution, licence hors politique | ADR-0032 D5, I-11 | versions exactes, verrou, âge de trois jours, clôture des licences | CA-19, CA-20 |
| le paquet devient une autorité par glissement (type dans le verdict, graphe qui étend le plan) | ADR-0032 D2, D3 | `review-verdict.v0.1` byte-identique ; graphe opaque ; chemin sans le paquet vivant | CA-25, CA-29 |

## 9. Critères d'acceptation

Numérotation : les numéros CA-1 à CA-11 de la première rédaction sont conservés ; les critères issus
de la division de CA-1, CA-3, CA-5, CA-7 et CA-9 portent CA-12 à CA-16, et CA-17 est nouveau à la
mission. Les critères CA-18 à CA-30 sont ajoutés le 2026-10-23 pour le jalon LangGraph de
`tools/review` (`prd.md` section 9) ; chacun cite la condition ou l'invariant dont il dérive. Les
commandes de validation sont relatives à la racine du dépôt ; `.clones/` désigne la composition de
flotte de la mission.

- CA-1 Les 54 vecteurs sémantiques `authorized-execution-v1` de la révision épinglée rendent chacun le code attendu. Validation : `cargo test --locked --all-features --test authorized_execution_vectors` vert dans la composition de flotte ; `git -C .clones/schemas-and-contracts show a82d7b54:contracts/fixtures/authorized-execution-v1/semantic-vectors.v1.json`, puis `shasum -a 256`, rend `d3a63edb3f146abe9061a3af0a9ae1bbb2d8d66f3d67fa34bbf7e859c0d0447e` (valeur rejouée le 2026-10-15 ; `tools/quality/authorized-execution-authority.test.ts:3`).
- CA-2 Aucune capacité système n'entre dans `src/`. Validation : `bun run check:capabilities` vert ; mutation de preuve : ajouter `use std::fs;` dans un module de `src/` doit le rougir.
- CA-3 La surface publique est figée (64 symboles). Validation : `cargo test --locked --test compat_surface public_surface_matches_the_committed_snapshot` vert ; mutation de preuve : retirer un symbole de `src/lib.rs` fait échouer cette seule commande sans toucher l'instantané des codes (`project.v1.yaml:129-131`).
- CA-4 Les cinq scénarios de coupure produisent au plus un commit externe et aucune réémission. Validation : `cargo test --locked --test authorized_execution_crash_e2e` vert.
- CA-5 Les types à `Debug` rédigé ne contiennent aucun identifiant ni digest d'entrée : `EffectObservation`, `EffectApplication`, `TransferObservation`, `TransferApplication`, `DecisionObservation`, `DecisionApplication`, `EventCollisionObservation`, `AuthorizedExecutionState`, `ToolObservationInput`, `AuthorizedGraph`, `AuthorizedExecutionEvent`, `GraphTransition`. Validation : test T1 de `tests-et-evaluation.md` section 5 vert sur ces 12 types et `grep -rn 'impl.*Debug for' src`, puis `wc -l`, rend 12 ; mutation de preuve : retirer la rédaction (le marqueur `redacted` entre chevrons) de `DecisionObservation` doit le rougir.
- CA-6 Le seuil de couverture est appliqué, pas seulement écrit. Validation : `bun run check:coverage` exécuté dans la composition de flotte et vert aux seuils 87 % lignes / 90 % fonctions ; `coverage/lcov.info` publié en artefact du run.
- CA-7 Le champ de fraîcheur de la fiche est postérieur à la dernière entrée de `docs/compat/BREAKS.md`. Validation : `grep -n 'last_verified_on' project.v1.yaml` rend une date postérieure au 2026-10-09 (valeur rejouée : `2026-09-10`, critère rouge aujourd'hui) et `grep -n 'authorized-execution 0\.' project.v1.yaml` ne rend plus `0.2.0` (valeur rejouée : `0.2.0` ligne 22).
- CA-8 Un consommateur de la flotte épingle la crate par SHA et rejoue un journal réel. Validation : `grep -rln 'libre-ai-agent-orchestrator' .clones/*/Cargo.toml .clones/*/crates/*/Cargo.toml`, hors la ligne de ce dépôt, rend au moins un dépôt (valeur rejouée : 0), et ce dépôt porte un test qui appelle `replay_authorized_execution` sur un journal qu'il a lui-même produit. Seconde condition, à valider séparément (recoupement de seconde famille du 2026-10-15) : `grep -rn 'replay_authorized_execution' DEPOT-CONSOMMATEUR/tests` rend au moins une ligne ; sans objet tant que la première condition est rouge.
- CA-9 Un test de ce dépôt lit les vecteurs de liaison de décision depuis l'autorité. Validation : `grep -n 'decision-binding-vectors.v1.json' tests/*.rs` rend au moins un chemin sous `node_modules/@libre-ai/contracts-authority` (valeur rejouée : 0 ligne, critère rouge aujourd'hui).
- CA-10 Le banc est rejoué et comparé à la baseline à chaque montée de version. Validation : `ls docs/reviews/*/*/benchmark.txt`, puis `wc -l`, rend un nombre égal à celui des entrées de `docs/compat/BREAKS.md` postérieures à 0.2.0 (valeur rejouée : 1 fichier, celui de 0.2.0 du 2026-09-10, pour 2 entrées postérieures, 0.3.0 et 0.4.0 du 2026-10-09 : 0 fichier pour 2) ; entrées depuis 0.2.0 inclus : 3.
- CA-11 La vérification de signature d'observation est exercée par une vraie vérification Ed25519 hors `src/`, par la voie choisie en Q10. Validation : `bun run check:capabilities` vert avec le test présent (`git diff --stat` ne touche pas `ALLOWED_DEPENDENCIES`, `verification/agent-orchestrator/check-capabilities.ts:9-16`, hors voie décrite par Q10) ; mutation de preuve : un octet changé dans `signature` rend `attestation-invalid` ; valeur rejouée : `RecordingVerifier` renvoie `true` (`tests/tool_observation_vectors.rs:95-102`), critère rouge aujourd'hui.
- CA-12 Les 14 vecteurs sémantiques `tool-invocation-observation-v1` de la révision épinglée rendent chacun le verdict attendu. Validation : `cargo test --locked --all-features --test tool_observation_vectors` vert dans la composition de flotte ; `git -C .clones/schemas-and-contracts show a82d7b54:contracts/fixtures/tool-invocation-observation-v1/vectors.json`, puis `jq '.semantic|length'`, rend 14 (valeur rejouée le 2026-10-15 ; contrat au statut `candidate`).
- CA-13 Les codes stables sont figés (97 codes). Validation : `cargo test --locked --test compat_surface stable_codes_match_the_committed_snapshot` vert ; mutation de preuve : changer une valeur de `ControlRefusal::code` fait échouer cette seule commande sans toucher l'instantané de surface (`project.v1.yaml:129-131`) ; `grep -vcE '^#|^$' tests/compat/stable_codes.snapshot` rend 97 (valeur rejouée).
- CA-14 `bun run heal:card-status` de `project-governance` ne produit aucune différence sur le README. Validation : exécution dans la composition de flotte, diff vide ; non rejoué dans la mission (aucune exécution de code des dépôts).
- CA-15 Le `rev` de `Cargo.toml:15` contient le fichier des vecteurs de liaison de décision. Validation : `git -C .clones/schemas-and-contracts ls-tree --name-only REV contracts/fixtures/authorized-execution-v1/` liste `decision-binding-vectors.v1.json` (valeur rejouée pour `a82d7b54` : absent ; présent à `216ffb92`).
- CA-16 Les types à `Debug` dérivé qui portent des identifiants ont un `Debug` rédigé, ou l'écart est déclaré dans `docs/compat/BREAKS.md` : `ControlCommand`, `RunControlState`, `StartPreflight`, `CommandReceipt`, `PlanBudgetLimits`, `CommandCollisionObservation`, `EventStoreObservation`. Validation : `grep -n 'derive(.*Debug' -A2 src/control.rs src/budget.rs` ne rend plus ces types dans un `derive(Debug)` (valeur rejouée : 7 types à `Debug` dérivé) et T1 couvre les 7.
- CA-17 Les surfaces 0.3.0 et 0.4.0 ont une revue à rôles séparés et à familles de modèle distinctes (I-35). Validation : un dossier `docs/reviews/SUJET/SHA/` dont `SHA` est postérieur à `e29f507` (`git log -1 --format=%ad e29f507` rend 2026-10-10) ; valeur rejouée : 0 dossier (`ls docs/reviews/*/` : `1ae6b88` de 0.2.0 du 2026-09-10, `ca44eb3` du 2026-08-19).
- CA-18 **Versions corrigées, double instrument** (ADR-0058 section 3, condition 1). Toute version résolue du graphe de `tools/review` est supérieure ou égale à la version corrigée de chaque avis publié par l'éditeur au jour de la pull request qui introduit le paquet ; au 2026-10-23 : `@langchain/langgraph` ≥ 1.4.21 (GHSA-wp87-994x-j95x) et ≥ 1.4.12 (GHSA-j87f-x5h5-gr75), `@langchain/langgraph-checkpoint` ≥ 1.1.4 (GHSA-j87f-x5h5-gr75), `@langchain/core` ≥ 1.1.8 (GHSA-r399-636x-v7f6), `@langchain/langgraph-sdk` ≥ 1.12.3 (GHSA-432w-3h3v-2pv4 et GHSA-r3xm-q2gp-xjjg) ; la liste se relit sur les avis, elle n'est pas figée. Deux instruments, tous deux bloquants : `osv-scanner` hors ligne sur `tools/review/bun.lock`, base d'avis synchronisée à une date imprimée dans la sortie du gate, base absente ou plus vieille que sept jours = échec, jamais zéro ; et un fichier de données versionné `tools/review/advisories.v1.json`, une entrée par triplet (paquet, version minimale, identifiant d'avis), que le gate compare au verrou résolu, une entrée absente ou un paquet du verrou sous son plancher = échec. Validation : `bun test tools/review/gates` vert (test `advisory-floor`), sortie du gate imprimant le nombre d'entrées comparées et la date de la base ; neutralisation : abaisser une version du verrou dans une copie, ou retirer une entrée du fichier de données, doit rougir ; environnement du processus fils purgé (`env -i`).
- CA-19 **Épinglage** (ADR-0058 section 3, condition 2 ; ADR-0032 D5, « pin de source, zéro téléchargement dynamique »). `@langchain/langgraph` et ses transitives sont déclarés en version exacte dans `tools/review/package.json`, résolus dans `tools/review/bun.lock` commité, soumis à l'âge minimal de publication de trois jours (`tools/review/bunfig.toml`, `minimumReleaseAge = 259200`, inchangé), et aucun téléchargement n'a lieu à l'exécution de `fanout.ts`. Validation : `bun install --cwd tools/review --frozen-lockfile` vert ; `grep -c '"@langchain/langgraph": "[0-9]' tools/review/package.json` rend 1 (aucun préfixe `^` ni `~`) ; `grep -c 'minimumReleaseAge = 259200' tools/review/bunfig.toml` rend 1 ; `bun tools/review/fanout.ts PLAN-MESURE --dry-run` (PLAN-MESURE : voir CA-24) exécuté sans accès réseau (`env -i PATH=$PATH`, interface réseau coupée ou proxy nul) rend la même sortie qu'avec.
- CA-20 **Clôture des licences** (ADR-0058 section 3, condition 3 ; I-11 ; ADR-0042 section 4 et section 11). Le graphe complet de `tools/review`, transitives comprises, ne porte que des licences admises. Validation : `bun run check:review-licenses` vert, script qui exécute `node_modules/@libre-ai/governance/tools/quality/check-js-licenses.ts` avec `tools/review` comme répertoire courant (le gate lit `bun.lock` et `node_modules/**/package.json` du répertoire courant, `check-js-licenses.ts:39,88`) ; sortie imprimant le nombre de paquets examinés ; neutralisation : un paquet à licence hors liste ajouté dans une copie du verrou doit rougir.
- CA-21 **Télémétrie interdite par gate textuel** (ADR-0058 section 3, condition 4, premier mécanisme ; ADR-0032 D4). Aucun fichier suivi du dépôt, hors les fixtures de ce gate, ne contient une variable d'environnement dont le nom commence par `LANGSMITH_`, ni les alias `LANGCHAIN_TRACING`, `LANGCHAIN_TRACING_V2`, `LANGCHAIN_API_KEY`, `LANGCHAIN_ENDPOINT`, `LANGCHAIN_CALLBACKS_BACKGROUND`, dans le code, la configuration ou un fichier d'environnement ; le gate ne prétend pas voir une construction dynamique du nom. Validation : `bun test tools/review/gates` vert (test `telemetry-variables`), sortie imprimant le nombre de fichiers balayés sur `git ls-files` ; neutralisation : un fichier portant `LANGSMITH_TRACING=true` hors fixture doit rougir ; environnement du fils purgé (`env -i`) ; les occurrences de ce cahier et du PRD sont exemptées par chemin dans les données du gate, et l'exemption est imprimée.
- CA-22 **Egress sans hôte de l'éditeur, prouvé par vecteur rouge** (ADR-0058 section 3, condition 4, second mécanisme). L'orchestrateur et ses passes s'exécutent sous une politique réseau appliquée hors du processus de l'orchestrateur, qui ne déclare aucun hôte de télémétrie de l'éditeur ; une tentative de connexion vers un tel hôte depuis l'orchestrateur est refusée par le mécanisme qui applique la politique et comptée dans ses événements. Le mécanisme est nommé dans le vecteur : le harness d'`execution-sandbox` quand `tools/review` tourne sous un plan `execution-plan-body` à règles réseau, ou, à défaut, le mécanisme réseau de la machine de forge, dont le vecteur imprime le nom et la règle ; un mécanisme qui ne produit pas ce refus n'active pas l'orchestrateur sous LangGraph. Validation : `bun test tools/review/vectors` vert (vecteur `telemetry-egress-refused`), sortie imprimant le mécanisme, l'hôte visé et le compte de refus (≥ 1) ; neutralisation : retirer la règle réseau dans une copie doit faire aboutir la connexion, donc rougir ; le vecteur est écrit et vert avant toute campagne réelle sous LangGraph.
- CA-23 **Aucune persistance LangGraph externe** (ADR-0058 section 3, condition 5 ; ADR-0032 D4 ; ADR-0034 « Frontière du premier incrément »). `@langchain/langgraph-checkpoint-postgres`, `-redis`, `-mongodb`, `-sqlite` et les stores du paquet n'entrent ni dans `tools/review/package.json` ni dans `tools/review/bun.lock` ; un gate les refuse par nom ; le seul checkpoint admis est en mémoire, créé et détruit dans la même invocation (ADR-0032 D3). Validation : `bun test tools/review/gates` vert (test `persistence-packages`), sortie imprimant le nombre de dépendances examinées dans le manifeste et le verrou ; neutralisation : ajouter `@langchain/langgraph-checkpoint-sqlite` au manifeste dans une copie doit rougir ; `grep -n 'checkpoint' tools/review/*.ts` ne rend que des usages en mémoire ou rien.
- CA-24 **Valeur propre mesurée** (ADR-0058 section 3, condition 6 ; ADR-0032 D5 « valeur propre mesurée face à un worker plus petit »). La même tâche est mesurée des deux côtés, avec et sans le paquet, sur le même commit : taille du graphe de dépendances de `tools/review`, temps de démarrage de l'orchestrateur en `--dry-run`, mémoire maximale ; les trois nombres de chaque côté sont relevés verbatim, avec leur commande et leur date, dans `docs/evidence/`, et l'écart est écrit, avec sa date, dans `project.v1.yaml`. Un écart défavorable n'interdit pas l'adoption, décidée par ADR-0058 ; il s'écrit. Validation : un fichier `docs/evidence/` portant les six nombres et les trois commandes (`bun pm ls --all --cwd tools/review` puis `wc -l` ; `/usr/bin/time -l bun tools/review/fanout.ts PLAN-MESURE --dry-run`, temps réel et mémoire maximale résidente) ; PLAN-MESURE est `tools/review/plan.example.json` dont le champ `commit` est remplacé par le commit que rend `git rev-parse HEAD`, écrit dans un fichier hors de l'arbre suivi : le plan d'exemple porte le commit nul (`jq -r .commit tools/review/plan.example.json`), que `fanout.ts` refuse par `git cat-file -e` (`tools/review/fanout.ts:230`) avant la branche `--dry-run` (`:256`), si bien que la commande sur le plan tel quel sort en erreur ; `grep -n 'langgraph' project.v1.yaml` rend une ligne datée portant l'écart ; référence sans le paquet mesurée le 2026-10-23 : 42 lignes de `bun pm ls --all --cwd tools/review` (en-tête compris), à rejouer avant comparaison.
- CA-25 **Le paquet n'est pas une autorité** (ADR-0032 D2 et D3, maintenus par ADR-0058 section 2). Aucun type LangGraph, LangChain ou LangSmith n'entre dans le plan, le verdict ni le journal : `reviewVerdictSchema` est byte-identique à sa forme au commit lu et son `$id` reste `review-verdict.v0.1` ; `fanout-core.ts` ne mentionne pas le paquet ; le graphe interne reste opaque (aucun nœud, aucune arête ni aucun état du graphe n'apparaît dans une entrée ou une sortie de l'outil) et ne peut pas étendre le plan ; les sérialiseurs du paquet ne relisent aucun octet venu d'ailleurs que du processus de l'orchestrateur. Validation : `bun run check:review-tools` vert avec un test qui compare le SHA-256 de `JSON.stringify(reviewVerdictSchema)` à la valeur relevée au commit lu ; `grep -c -i 'langgraph' tools/review/fanout-core.ts` rend 0 ; `grep -c -i 'langgraph' tools/review/plan.example.json tools/review/plan.orchestrator-ca44eb3.json docs/reviews/orchestrator/ca44eb3/events.jsonl` rend 0 partout ; neutralisation : un champ ajouté au schéma dans une copie doit rougir le test de SHA-256.
- CA-26 **INV-a : aucune chaîne non fiable devant un modèle qui détient un outil à effet** (ADR-0045 décision 1, `docs/adr/0045-*.md:84` de `project-governance`). Le contenu revu (différences, fichiers du commit, preuve enveloppée) n'entre dans aucun contexte de modèle qui détient un outil dont l'accès est `write`, `execute` ou `network` : chaque passe `pi` est lancée avec un profil d'outils en lecture seule (`pi --tools read,grep,find,ls --no-mcp`, mode documenté par `pi --help` : « Read-only mode (no file modifications possible) »), et l'écriture du verdict dans `docs/reviews/` est faite par l'orchestrateur, composant déterministe, après validation de schéma ; aucune sortie de `pi` n'est relue par un second modèle. Validation : `bun test tools/review/vectors` vert (vecteur 2 d'ADR-0045 : la ligne de commande de chaque passe, capturée, porte le profil lecture seule et aucun outil à effet ; le prompt privilégié n'existe pas : aucun modèle à outil à effet ne reçoit d'octet du contenu revu) ; `grep -n -- '--tools' tools/review/fanout.ts` rend la liste fermée ; neutralisation : retirer `--tools` dans une copie doit rougir ; valeur au commit lu : aucune option `--tools` (`fanout.ts:114-127`), critère rouge aujourd'hui.
- CA-27 **INV-b : provenance par valeur, politique sur l'argument** (ADR-0045 décision 1, `:85`). Tout argument d'un effet de l'orchestrateur (chemin du worktree, commit extrait, chemin du verdict, chemin du journal, ligne de commande de `pi`) dérive du plan et du rôle, jamais du contenu revu ni de la sortie du modèle ; la sortie du modèle n'alimente que `extractVerdict` puis `validateVerdict`, et un verdict refusé ne produit aucune écriture hors de l'événement `verdict_rejected`. Validation : `bun test tools/review/vectors` vert (vecteur 1 d'ADR-0045 : un verdict piégé qui porte un chemin de sortie, une commande ou une adresse n'obtient aucun effet, le refus vient de la validation et de la construction des arguments, pas du modèle) ; `bun run check:review-tools` vert sur les tests `buildJobs` et `validateVerdict` ; neutralisation : faire dériver `outputPath` d'un champ du verdict dans une copie doit rougir.
- CA-28 **INV-c : sortie de quarantaine à vocabulaire fermé** (ADR-0045 décision 1, `:86`). Le nœud d'agrégation ne lit du verdict que ses champs à vocabulaire fermé : `verdict` (trois valeurs), `commitSha` (40 hexadécimaux), `reviewPassId` et `role` (égalité exacte avec le travail), `mode` (deux valeurs), les comptes de `findings` par gravité ; les textes libres (`title`, `detail`, `residualRisks`, `commands`) sont des données non fiables écrites dans le fichier de verdict pour une lecture humaine, jamais lues par un nœud qui décide ni rendues à un modèle. Validation : `bun test tools/review/vectors` vert (vecteur 3 d'ADR-0045 : un verdict dont `verdict` est un texte hors des trois valeurs échoue à la validation et ne produit aucun appel ni écriture ; un verdict valide dont `detail` porte une consigne n'a aucun effet sur l'agrégation) ; neutralisation : faire lire `detail` par le nœud d'agrégation dans une copie doit rougir.
- CA-29 **Preuve de retrait** (ADR-0058 section 4 ; ADR-0032 D5 étapes 8 et 9). Le fan-out sans le paquet reste exécutable dans le dépôt et rend les mêmes résultats : sur PLAN-MESURE (CA-24) et sur le plan historique, c'est-à-dire `tools/review/plan.orchestrator-ca44eb3.json` dont le champ `commit` est remplacé de la même façon (le commit `ca44eb33` qu'il nomme n'est plus dans l'historique de la branche servie : `git rev-list --all` n'en rend aucune occurrence au 2026-10-23), la sortie de `--dry-run` (liste des passes et chemins de sortie) est identique à l'octet entre le chemin LangGraph et le chemin sans le paquet ; sur le journal historique `docs/reviews/orchestrator/ca44eb3/events.jsonl`, `replayPassStatuses` rend le même résultat ; sur les deux verdicts enregistrés de ce dossier, `validateVerdict` rend la même liste d'erreurs (vide). Une campagne réelle rejouée des deux côtés est une mesure versée dans `docs/evidence/`, pas un test de la chaîne requise (R-5 : binaire `pi` et authentification hors manifeste). Validation : `bun run check:review-tools` vert avec un test de parité qui exécute les deux chemins sur les deux plans et le journal ; neutralisation : altérer un chemin de sortie dans le chemin LangGraph d'une copie doit rougir ; le retrait du paquet est alors une pull request qui supprime le chemin LangGraph, ses gates et ses vecteurs, sans migration d'un verdict ni d'un journal.
- CA-30 **Fiche à jour** (ADR-0058 section 4, critère de sortie de phase, I-08 ; ADR-0058 section 3 condition 6). `project.v1.yaml` porte, pour `tools/review`, l'adoption du runtime LangGraph avec sa date, l'écart de valeur de CA-24 avec sa date, la preuve de retrait de CA-29 comme critère de sortie de phase, et le non-objectif « faire de LangGraph une autorité » reformulé pour ne plus couvrir la dépendance de l'outillage ; `last_verified_on` est postérieur à cette écriture, et la section statut du README est régénérée depuis la fiche. Validation : `grep -c -i 'langgraph' project.v1.yaml` rend au moins 3 ; `grep -n 'last_verified_on' project.v1.yaml` rend une date postérieure au 2026-10-23 ; `bun run heal:card-status` de `project-governance` ne produit aucune différence (CA-14).

## 10. Critères d'abandon

Les quatre critères sont des déclencheurs de décision du propriétaire, pas des abandons automatiques.
AB-1 se déclenche par défaut tant qu'aucune décision n'a rattaché ce dépôt à B' : ADR-0042 section 3
ne l'exige pas et le domaine Rust d'`ai-work-supervision` n'importe aucun contrat
(`specs/ai-work-supervision/architecture.md:81`) ; la recommandation « conserver » du PRD le suppose.

- AB-1 Aucun dépôt de la flotte autre que celui-ci ne dépend de la crate à la clôture du jalon B' d'ADR-0042 section 3 (dix missions consécutives, `docs/adr/0042-*.md:78` de `project-governance`) : le cœur est réintégré dans le dépôt qui en a besoin ou retiré (I-19). Validation : `grep -rln 'libre-ai-agent-orchestrator' .clones/*/Cargo.toml .clones/*/crates/*/Cargo.toml .clones/*/package.json`, hors la ligne de ce dépôt, puis `wc -l`, rend 0 (valeur rejouée le 2026-10-15 : 0) ; la commande ne couvre ni `uses:` ni une git-dep d'un autre langage.
- AB-2 L'autorité de contrats retire ou rétrograde plus de la moitié des 9 identifiants lus (section 7.1 : `orchestrator-control-v1`, `execution-graph-v1`, `execution-plan-body-v2`, `orchestrator-event-v3`, `human-decision-request-v1`, `human-decision-response-v1`, `execution-transfer-v1`, `effect-attestation-v1`, `tool-invocation-observation-v1`) sans que le `rev` de `Cargo.toml:15` avance : la surface n'a plus d'oracle verrouillé. Validation : `git -C .clones/schemas-and-contracts show HEAD:contracts/catalog.v1.json`, puis `jq --argjson ids '["orchestrator-control-v1","execution-graph-v1","execution-plan-body-v2","orchestrator-event-v3","human-decision-request-v1","human-decision-response-v1","execution-transfer-v1","effect-attestation-v1","tool-invocation-observation-v1"]' '[.contracts[]|select(.id as $i|$ids|index($i))|select(.status=="locked")]|length'`, rend moins de 5 (valeur rejouée : 8 sur 9, `tool-invocation-observation-v1` étant `candidate`).
- AB-3 `check:capabilities` est retiré de la chaîne `check`, ou un ajout à `ALLOWED_DEPENDENCIES` introduit une dépendance d'effet : la propriété fondatrice (`project.v1.yaml:11`) est perdue et le composant n'est plus ce que sa fiche décrit. Validation : `grep -c 'check:capabilities' package.json` rend au moins 2 (valeur rejouée : 2, l'appel dans `check` à `package.json:30` et la définition à `:33`) et `git diff -- verification/agent-orchestrator/check-capabilities.ts` ne montre aucun ajout aux lignes 9-16 sans revue ; dépendances admises aujourd'hui : `chrono`, `libre-ai-contract-types`, `serde`, `serde_jcs`, `serde_json`, `sha2` (6). Le paquet LangGraph n'entre jamais dans ce gate ni dans `Cargo.toml` (ADR-0037 D6) : un ajout de `langgraph` à `ALLOWED_DEPENDENCIES` déclenche AB-3.
- AB-4 Abandon du volet `tools/review` dans ce dépôt, par déplacement vers `project-governance` (qui porte déjà le skill qui l'appelle) : un second producteur du schéma `review-verdict.v0.1` existe hors de ce dépôt (critère de scission, M6, déjà porté par `prd.md` section 8). Validation : `grep -rln 'review-verdict' .clones/*/ --include='*.ts'`, hors les lignes de ce dépôt, puis `wc -l`, rend au moins 1 (valeur rejouée : 0 ; 1 fichier hors filtre : `tools/review/fanout-core.ts`). Le paquet LangGraph, ses gates (CA-18, CA-21, CA-23) et ses vecteurs (CA-22, CA-26 à CA-28) suivent l'outil dans le déplacement.

## 11. Dépendances

### 11.1 Internes libre-ai

| Dépendance | Forme | Révision | Source |
| --- | --- | --- | --- |
| `schemas-and-contracts` — crate `libre-ai-contract-types` | git-dep cargo | `a82d7b54cfda00bfcbbdff34a3c34f24a2468a6e` | `Cargo.toml:15` |
| `schemas-and-contracts` — `@libre-ai/contracts-authority` | `file:../schemas-and-contracts` | checkout frère de la composition | `package.json:16` |
| `schemas-and-contracts` — `@libre-ai/envelope` | `file:../../../schemas-and-contracts/packages/envelope` | idem | `tools/review/package.json:12` |
| `project-governance` — `@libre-ai/governance` (gates) | `file:../project-governance` | idem | `package.json:12,15` |
| `project-governance` — `validate-composition.yml` | `uses:` | `0db2e10e3ea785c31c101914483ed501ec4cbb7a` | `code-validation.yml:13` |

`a82d7b54` est ancêtre de la tête du clone de `schemas-and-contracts` (`216ffb92`), 7 commits en
arrière (`git -C .clones/schemas-and-contracts merge-base --is-ancestor a82d7b54 HEAD`, puis
`git log --oneline a82d7b54..HEAD`, puis `wc -l`). Trois révisions de l'autorité coexistent dans la
flotte (E16, `synthese.md` section 3.2) ; ce dépôt est sur la plus récente des trois.

Contrats **partagés** avec les deux autres composants de la fabrique (addendum du mandat), relevés
par `grep -rhoE '(execution-authorization|missions|harness-profile|execution-plan-body|orchestrator-event|harness-attestation)[.-]v[0-9]+' .clones/DEPOT --include='*.md' --include='*.json' --exclude-dir=node_modules`
(mentions dans les documents) ; la lecture par le code se relève avec `--include='*.rs'
--include='*.ts' --include='*.toml'` :

- avec `ai-work-supervision` : famille `execution-plan-body` (ce dépôt v2 ; Work Supervision v1 et
  v3), famille `orchestrator-event` (v3 ici ; v1 et v2 là), famille `execution-authorization`
  (v3 côté Work Supervision, jamais lue ici : la crate reçoit le `authorization_digest` déjà vérifié) ;
  `missions-v1`/`missions-v3` ne sont lus que par Work Supervision ;
- avec `execution-sandbox` : `harness-profile` (v1 et v2 côté sandbox ; v3 `candidate` déclare
  `noProgressGuard.repeatThreshold` et `windowSize`,
  `schemas-and-contracts/contracts/schemas/harness-profile.v3.schema.json:228-235`, que ce dépôt lit
  **indirectement** par les champs `window.repeatThreshold` et `window.windowSize` recopiés dans
  chaque document d'observation), `harness-attestation.v1` (produit par le sandbox, lié ici par
  `harnessAttestationDigest` et par `effect-attestation.v1`), `execution-plan-body.v1`.

Aucun des deux ne consomme la crate. Relevé du 2026-10-15 sur les fichiers de code (`*.rs`, `*.ts`,
`*.toml`) : ce dépôt cite `execution-plan-body` v2 et `orchestrator-event` v3 ; `ai-work-supervision`
cite `missions` v1 seulement ; `execution-sandbox` cite `harness-profile` v1 et v2 et
`harness-attestation` v1. Les **mentions dans les documents** couvrent d'autres majeures
(`execution-plan-body` v1, v3, v4 ; `orchestrator-event` v1, v2 ; `harness-profile` v3), et le domaine
Rust d'`ai-work-supervision` n'importe aucun contrat (`specs/ai-work-supervision/architecture.md:81`).
Les trois composants ne partagent donc aucune majeure identique **lue par le code**, par absence de
lecteur côté `ai-work-supervision` plus que par écart de versions. Fait porteur pour Q1 et pour le
critère de revue R1 de la phase 2.

Chevauchements fonctionnels nommés, sans demande de fusion de spec :

| Fonction | `ai-work-supervision` (v0) | Cette crate | Écart |
| --- | --- | --- | --- |
| reprise après coupure | reprise après `SIGKILL` à 14 points (`specs/ai-work-supervision/cahier-des-charges.md:206`) | refus de réémission sur attestation `state-unknown`, 5 points de coupure contre faux exécuteur (`tests/support/crash.rs:20-26`) | un moteur d'exécution réel d'un côté, une décision pure de l'autre ; aucune comparaison de comportement faite `[NON VÉRIFIÉ]` |
| idempotence de commande | `commandId` et conflit d'idempotence (`specs/ai-work-supervision/cahier-des-charges.md:236`) | reçu par `idempotency_key` et `command_fingerprint` (`src/control.rs:162-167`) | deux formes de code (`command.idempotency_conflict` du standard contre `orchestrator.control.idempotency-conflict`, Q4) |
| révision périmée | `mission.revision_stale` (`specs/ai-work-supervision/cahier-des-charges.md:371`) | `stale-revision` (`src/control.rs`) | même fonction, noms distincts |
| budget par run | budgets par run (`specs/ai-work-supervision/cahier-des-charges.md:371`) | `PlanBudgetLimits`, 7 compteurs (`src/budget.rs:6-16`) | l'état accepté est tenu par `ai-work-supervision` ; la crate décide sur ses faits |

Autres recouvrements nommés : `capability-authorization` produit naturellement `biscuit_allowed`,
`authorization_valid` et `AgentIdentity` que `StartPreflight` reçoit déclarés ; `pi-harness-challenger`
(policy-gate d'outils d'agent) recoupe le verdict `tool-undeclared` ; `pi-evidence` et
`artifact-verification` portent d'autres formes d'attestation que `effect-attestation.v1`,
`harness-attestation.v1` et `review-verdict.v0.1` (trois formes dans ce périmètre).

### 11.2 Externes

`chrono 0.4.45` (sans `clock`), `serde 1.0.229`, `serde_jcs 0.2.0`, `serde_json 1.0.151`
(`float_roundtrip`), `sha2 0.11.0` (`Cargo.toml:14-19`) ; Bun ≥ 1.4.0, Biome 2.5.3, TypeScript 7.0.2
(`package.json:6-19`) ; `ajv 8.20.0` dans `tools/review` ; outils de gate : `cargo-deny 0.19.5`,
`cargo-llvm-cov 0.9.1`, `pi` (binaire externe appelé par `fanout.ts`, hors manifeste). LangGraph :
oracle hors graphe de dépendances de la crate (ADR-0032, ADR-0037 D6) ; dans `tools/review`, à
compter du paquet de travail WP-2 du PRD, `@langchain/langgraph` en version exacte, avec sa
transitive `@langchain/core` et `@langchain/langgraph-checkpoint`, aux conditions de CA-18 à CA-23
(versions publiées au 2026-10-23 : `@langchain/langgraph` 1.5.2, `@langchain/core` 1.3.0,
`@langchain/langgraph-checkpoint` 1.2.1, `npm view PAQUET version`). `osv-scanner` pour CA-18.

## 12. Risques

| # | Risque | Signal mesurable | Effet |
| --- | --- | --- | --- |
| R-1 | Aucun consommateur : le cœur reste prouvé sur des entrées fabriquées par ses propres tests | `grep` CA-8 rend 0 | la propriété de rejeu réel n'est jamais exercée ; I-19 non satisfait |
| R-2 | Dérive fiche / code : la fiche décrit 0.2.0 et date du 2026-09-10 | `project.v1.yaml:22,82` | les gates de flotte agrègent un état faux ; E15 étendue à ce dépôt |
| R-3 | Contrat `tool-invocation-observation-v1` encore `candidate` : la surface 0.4.0 lit un schéma non verrouillé | `catalog.v1.json` au pin | une révision du candidat casse 17 tests sans rupture déclarée côté autorité |
| R-4 | Trois majeures de `execution-plan-body` et deux d'`orchestrator-event` dans la fabrique | section 11.1 | le premier consommateur devra adapter ou monter de version avant d'appeler la crate |
| R-5 | `tools/review` dépend d'un binaire `pi` et d'une authentification de fournisseur hors manifeste (`docs/evidence/2026-08-19-first-real-fanout-campaign.md:43-64`) | reproductibilité de la campagne | l'outil n'est pas rejouable depuis une composition neuve ; la parité de CA-29 se mesure sur les parties déterministes, la campagne réelle est une preuve versée |
| R-6 | Couverture écrite, non appliquée | `package.json:30` | un recul de couverture passe la chaîne requise |
| R-7 | `docs/apps/memory.md` : spécification d'un composant sans code, hébergée ici, sous gate `check:specifications` | `package.json:34` | un brouillon dont le verrou est en attente (bannière « DRAFT — Specification Lock pending », `docs/apps/memory.md:3`, mécanisée par `check:memory-draft-sync`) qui ne décrit rien d'existant dans le dépôt ; périmètre documentaire ambigu (Q5) |
| R-8 | Métadonnée `repository` pointant le moyeu archivé | `Cargo.toml:7` | sans effet sur la compilation ; un index de crates afficherait un lien mort |
| R-9 | Écart entre `evaluate_effect_attestation` et ADR-0034 D4 (accepted) pour `started` et observation indisponible | `effect.rs:277-279` rend `transition-forbidden`, `:227-229` rend `store-unavailable` | un consommateur qui lit « bloqué » sur ces deux cas lit un état que la crate ne rend pas (Q9) |
| R-10 | Cinq types à `Debug` dérivé portent des identifiants et deux énumérations les portent par référence | `grep -n 'derive(.*Debug' -A2 src/control.rs src/budget.rs` | un diagnostic de l'appelant qui formate l'un de ces types journalise des identifiants de fil ; CA-5 ne les couvre pas, CA-16 les couvre |
| R-11 | La valeur de LangGraph sur un orchestrateur de sous-processus est nulle ou négative (M8, H7) | écart de CA-24 défavorable sur les trois nombres | l'écart s'écrit dans la fiche, il n'interdit pas (arbitrage du 2026-10-23) ; le propriétaire relit la décision sur ce relevé ; CA-29 garde le retrait possible |
| R-12 | L'échéance ADR-0045 (2026-12-31) arrive avant WP-3 et WP-4 | M9 à 0 vecteur à la date | l'orchestrateur de revues est suspendu (ADR-0045 décision 4), avec ou sans LangGraph ; le passage en lecture seule des passes (CA-26) ne dépend pas du paquet et peut précéder WP-2 |
| R-13 | Le mécanisme réseau qui applique CA-22 n'existe pas sur la machine de forge (aucun plan `execution-plan-body` ne couvre `tools/review` au commit lu) | vecteur `telemetry-egress-refused` sans mécanisme nommé | l'orchestrateur sous LangGraph ne s'active pas (ADR-0058 section 3 condition 4 : « un harness qui ne produit pas ce refus n'active pas le worker ») ; le mécanisme est une décision à prendre avant WP-4 (question fermée dans la pull request du PRD) |
| R-14 | Un avis de l'éditeur absent de la base `osv-scanner` | date de base et nombre d'entrées imprimés par CA-18 | le fichier `tools/review/advisories.v1.json` le porte ; l'ajout d'une entrée est une édition revue |
| R-15 | Le vecteur 4 d'ADR-0045 (suite d'attaques adaptatives, taux d'utilité et taux d'attaque réussie rapportés ensemble) n'a ni critère ni paquet : M9 ne le mesure pas | `grep -n 'AgentDojo' docs/adr/0045-*.md` dans `project-governance` rend la ligne du vecteur ; aucun CA de ce document ne le cite | décision du propriétaire, ouverte : l'ajouter à WP-4 ou le déclarer hors jalon par ADR ; tant qu'elle n'est pas prise, M9 ne dit rien du vecteur 4 |

## 13. Table de conformité à SPECIFICATION-STANDARD

Les 13 sections de `project-governance/docs/specifications/SPECIFICATION-STANDARD.md:15-27`.
Cette crate est une bibliothèque Rust pure sans tenant, sans HTTP et sans interface : plusieurs
sections sont absentes par nature, raison donnée.

| # | Section du standard | Traitée dans | Absente : raison |
| --- | --- | --- | --- |
| 1 | Purpose and actors | `cahier-des-charges.md` section 2, section 3 ; `prd.md` section 1-2 | — |
| 2 | Journeys | `prd.md` section 4 (scénarios d'usage) ; `architecture.md` section 3 (états) | aucune « entry state / exit » utilisateur : la crate n'a pas de parcours, seulement des appels |
| 3 | Non-goals | `cahier-des-charges.md` section 4.2 | — |
| 4 | Domain protocol | `architecture.md` section 2 (contrats), section 3 (machines d'état) | les commandes/requêtes/événements du runtime cible restent « Target » dans `docs/apps/orchestrator.md:134-142`, non implémentés |
| 5 | Refusal matrix | `architecture.md` section 4 (décompte de familles de 97 codes) | **partielle** : section 4.1 compte des familles de codes, ce n'est pas une table cause / refus ; la matrice des 17 `ControlRefusal` reste à écrire |
| 6 | Data | `architecture.md` section 5 | absente pour la crate : aucun enregistrement, aucune clé tenant, aucune rétention ; obligations reportées sur le consommateur (ADR-0040 pour PostgreSQL) |
| 7 | Authentication and authorization | `cahier-des-charges.md` section 8.2 ; `architecture.md` section 6 | absente pour la crate : aucun Biscuit ni RLS ; booléens déclarés par l'appelant |
| 8 | Runtime boundaries | `architecture.md` section 1, section 6 ; section 8.4 de ce cahier pour `tools/review` | — |
| 9 | Accessibility and degraded mode | `architecture.md` section 4.2 (mode dégradé = refus fermé) | accessibilité absente : aucune interface humaine |
| 10 | Contracts | `cahier-des-charges.md` section 7 ; `architecture.md` section 2 | — |
| 11 | Evidence | `tests-et-evaluation.md` section 1 ; `docs/evidence/` pour CA-24 et CA-29 | gates navigateur et smoke absents : pas d'application |
| 12 | Work packages | `prd.md` section 9 (jalon LangGraph de `tools/review`) ; `prd.md` section 8 (devenir) ; `questions-ouvertes.md` Q1, Q5 | WP-G3-O02 clos, WP-G3-O01 non revendiqué (`project.v1.yaml:22`) ; aucun paquet ouvert sur la crate |
| 13 | Release and rollback | `architecture.md` section 7 (reconstructibilité), section 8 (sortie) | aucune release : `publish = false`, consommation par git-dep ; rollback = revert ou épinglage antérieur (`docs/apps/orchestrator.md:279`) ; pour `tools/review`, retrait du paquet par pull request (CA-29) |

Langage normatif, enveloppe `{data, meta}` / `{error}`, protocole de mutation (`commandId`,
`command.idempotency_conflict`, `command.stale_revision`) : les codes de cette crate suivent la
même intention sous une autre forme (`orchestrator.control.idempotency-conflict`,
`orchestrator.control.stale-revision`) parce qu'ils précèdent le standard et sont figés par la
politique de compatibilité ; l'alignement lexical des codes est une question ouverte (Q4).
