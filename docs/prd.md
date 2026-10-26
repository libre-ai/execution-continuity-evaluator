# execution-continuity-evaluator — PRD

Maturité du document : décision

Maturité : prototype

Provenance : ce document reprend la spécification de mission
`specs/execution-continuity-evaluator/prd.md` de l'analyse du 2026-10-14. Changements : la ligne
qui déclare le niveau de ce texte (ci-dessus) ; le scénario S6 (section 4), les métriques M8 et M9,
l'hypothèse H7, le quatrième défaut de la section 2 (ADR-0045), la ligne LangGraph de la section 7, deux
phrases de la section 8 (déplacement de `tools/review`, validation du jalon par M8 et M9) et la
section 9 (paquets de travail), qui portent la décision du propriétaire du 2026-10-23 (ADR-0058,
premier consommateur LangGraph JS de la flotte, sous ADR-0045) ; la ligne `WP-4` de la section 9 et
trois phrases de son préambule, qui portent la décision du propriétaire du 2026-10-24 (CA-32) ; la
ligne `WP-7`, le retrait de `CA-31` de la ligne `WP-4`, une phrase du préambule et le compte de la
porte, qui portent la
décision du propriétaire du 2026-10-26 (scission de WP-4) ; et des
réécritures de forme exigées par la norme des paquets de travail de `libre-ai/project-governance`
(`docs/specifications/WORK-PACKAGES.md`) : chaque paramètre écrit entre chevrons y est écrit en
capitales (`ORG/DEPOT`, `DEPOT-CONSOMMATEUR`, `REV`, `SUJET/SHA`), le jalon B prime s'écrit `B'`.
`cahier-des-charges.md` est à côté de ce fichier ; `architecture.md`, `tests-et-evaluation.md`,
`questions-ouvertes.md`, `CADRAGE.md` et `clones.json` désignent l'analyse de mission et ne sont pas
dans ce dépôt.

Portée du niveau : « prototype » qualifie le projet observé (0 consommateur dans la flotte, « built,
not integrated » au sens d'I-09) ; ce document est une décision du propriétaire, promue le 2026-10-23 par une pull request dédiée. La fiche porte `maturity: usable`
(`project.v1.yaml`, `grep -n '^maturity:' project.v1.yaml`) : autre échelle, écart consigné
(`cahier-des-charges.md` section 1.4).

Projet : `libre-ai/execution-continuity-evaluator`, lu au commit de base que rend `git rev-parse
origin/BRANCHE-SERVIE` dans ce dépôt, avant l'ajout de ce document (le 2026-10-23 :
`5d3275ec6bf5d48cf3cf4fba5ebf81945e11ab90`, daté du 2026-10-13, même commit que la mission du
2026-10-14). La doctrine est citée au commit de `libre-ai/project-governance` que rend
`git -C DEPOT-GOVERNANCE rev-parse HEAD` (le 2026-10-23 : `cd39dfd2861f183fe1472631f809b390bb3c8a4e`,
qui porte ADR-0058 fusionné). Les faits d'état sont établis dans `cahier-des-charges.md` section 1 ;
ce document porte la proposition de valeur, les décisions que des mesures déclenchent et le devenir
recommandé. Positionnement : « décision de mission du 2026-10-14 » (CADRAGE section 1.2). Aucun code
des dépôts n'a été exécuté pour établir les faits datés du 2026-10-14 (CADRAGE section 4.15).

## 1. Vision

Un cœur de décision d'orchestration d'agents qui ne fait rien : il reçoit des documents de contrat
scellés et des faits déclarés par l'appelant, et rend un code fermé plus, au plus, une proposition
d'application que l'appelant exécute ou persiste lui-même (`cahier-des-charges.md` section 2). Ce
qu'une organisation autorise un agent à faire se décide alors par une fonction rejouable hors ligne,
inspectable par un auditeur sans la crate (RFC 8785 puis SHA-256), et non par du code mêlé à
l'exécution.

Rattachement : composant de la fabrique, couche 2, `role: satellite`
(`project-governance/ecosystem/repositories.v1.yaml`,
`grep -n -A8 'repository: libre-ai/execution-continuity-evaluator' ecosystem/repositories.v1.yaml`).
Il appartient au socle « libre + services » de la décision de mission du 2026-10-14 au titre de la
supervision du travail ; le rattachement à la vérification d'artefacts, présent dans une première
rédaction, est retiré : il n'a aucune source (`artifact-verification` est un autre projet). Il n'est
pas un P-xx. Le rapprochement avec P35 de la confrontation du 2026-10-07 est contesté (Q8 de
`questions-ouvertes.md`).

Le dépôt porte aussi `tools/review`, l'orchestrateur de revues en éventail de la méthode : une passe
de revue par rôle contre un commit immuable, dans un worktree détaché, avec un verdict machine validé
par schéma. Depuis le 2026-10-23, cet orchestrateur est désigné premier consommateur du runtime
LangGraph JS admis par ADR-0058 (section 4, S6).

## 2. Problème

Trois défauts, énoncés avec leur contre-mesure dans `cahier-des-charges.md` section 2 :

1. une attestation d'effet au statut `state-unknown` lue comme un succès (code `effect-state-unknown`
   sur ce statut déclaré ; la conversion « aucun statut observé » vers ce statut est faite par
   l'appelant, `cahier-des-charges.md` section 2) ;
2. la boucle d'appels d'outil qui reste sous le plafond `maxToolCalls` et échappe aux budgets
   (verdict `no-progress`, ADR-0046) ;
3. la demande de décision humaine qui inverse ses issues ou abaisse le rôle requis
   (`evaluate_bound_human_decision`, ADR-0047).

Pour l'utilisateur primaire du socle (l'équipe qui pose les règles, CADRAGE section 1.4), le problème
s'énonce ainsi : une règle d'autorisation d'agent n'est opposable que si la décision qui l'applique
est rejouable sans effet de bord et ne dépend d'aucune chaîne libre produite par l'agent.

Un quatrième défaut, propre à l'outillage de forge, est ouvert par ADR-0045 : l'orchestrateur de
revues fait lire à des agents qui détiennent des outils des différences de code non fiables, et doit
tenir INV-a, INV-b et INV-c, avec leurs vecteurs rouges, avant le 2026-12-31
(`libre-ai/project-governance@cd39dfd2861f183fe1472631f809b390bb3c8a4e:docs/adr/0045-indirect-prompt-injection-isolation-by-construction.md:94`
et `:123`).

## 3. Proposition de valeur

| Pour | Valeur | Preuve disponible |
| --- | --- | --- |
| l'équipe qui pose les règles | refus à code stable et verdicts fermés (97 codes) ; les types à `Debug` rédigé (12) ne portent pas d'identifiant, sept types à `Debug` dérivé en portent, cinq directement et deux par référence (CA-16) | `tests/compat/stable_codes.snapshot` ; revue vie privée `1ae6b88` de 0.2.0 (2026-09-10), sans revue sur 0.3.0 ni 0.4.0 (CA-17) |
| l'auditeur | rejeu d'un journal `orchestrator-event.v3` en un état identique à l'octet ; recalcul des sceaux sans la crate : hypothèse `[NON VÉRIFIÉ]` | `tests/authorized_execution_replay.rs` ; 54 vecteurs de l'autorité |
| le développeur sous règles | un refus nomme la règle, jamais la valeur rejetée | `src/control.rs:264-272` |
| le consommateur (runtime) | aucune capacité système à auditer : liste de 6 dépendances, 25 motifs interdits (21 + 4) | `check:capabilities` |
| le relecteur de la méthode | des passes de revue par rôle rejouables, un verdict par rôle validé contre `review-verdict.v0.1`, un journal en ajout seul, des worktrees retirés en `finally` | `tools/review/fanout-core.test.ts` (45 tests) ; campagne réelle du 2026-08-19 (`docs/reviews/orchestrator/ca44eb3/`) |

Cadres réglementaires servis, marqués dans `cahier-des-charges.md` section 6, textes non consultés
`[NON VÉRIFIÉ]` : RGPD (minimisation), AI Act art. 12, 14, 15 (traçabilité, contrôle humain,
robustesse), NIS2 art. 21 et DORA art. 11-12 et 28 par le consommateur seulement ; RGS / SecNumCloud
non applicables à une bibliothèque sans hébergement.

## 4. Scénarios d'usage

Aucun n'est exercé en usage réel aujourd'hui pour la crate (0 consommateur, `cahier-des-charges.md`
section 1.4). S6 est exercé par la méthode (une campagne réelle, 2026-08-19).

- **S1 — Démarrage d'un run.** Le runtime consommateur réunit le préflight (15 champs dont 10
  booléens déclarés, `src/control.rs:113-130`), appelle `evaluate_control`, reçoit `Apply` ou un des
  17 refus, persiste la `ControlApplication` et le reçu idempotent. Rejouer la même commande rend
  `idempotent`.
- **S2 — Reprise après coupure.** Le runtime reconstruit l'observation d'effet depuis son journal et,
  faute de statut terminal observé, construit lui-même une attestation `state-unknown`
  (`tests/authorized_execution_crash_e2e.rs:164-172`) ; `evaluate_effect_attestation` rend alors
  `effect-state-unknown` et aucune proposition d'application
  (`src/authorized_execution/effect.rs:267-268`). Bloquer la lignée est la décision du runtime ; la
  crate ne porte pas d'état « bloquée » (Q9).
- **S3 — Audit hors ligne.** L'auditeur dispose d'un journal `orchestrator-event.v3` exporté, appelle
  `replay_authorized_execution` et compare l'état rendu (séquence, digest du dernier événement, étape
  prête, compteurs) à l'état déclaré par le runtime.
- **S4 — Détection de boucle.** Un harness, dont le porteur n'est pas déclaré (Q11), produit des
  fenêtres `tool-invocation-observation.v1` ; `evaluate_tool_observations` rend `no-progress` sur k
  couples identiques en fenêtre w, avec compteurs imprimés.
- **S5 — Décision humaine liée.** Une demande de décision est présentée ; la réponse n'est acceptée
  que si la demande est liée au graphe, au pas et à la politique de décision de ce pas.
- **S6 — Revue par rôle (`tools/review`), sur LangGraph JS.** Un plan JSON désigne un commit
  immuable, des rôles, une preuve partagée, une concurrence, un fournisseur et un modèle
  (`tools/review/plan.example.json`). L'orchestrateur structure la campagne en un graphe
  rôles → lots → vérification → agrégation porté par `@langchain/langgraph` ; chaque passe `pi` reste
  un nœud-outil : un worktree détaché par passe, le binaire `pi` lancé par `Bun.spawn`, le verdict
  extrait de sa sortie et validé contre `review-verdict.v0.1`, l'écriture du verdict faite par
  l'orchestrateur après validation, le journal `events.jsonl` en ajout seul, les worktrees retirés
  en `finally`. Le contrat observable ne change pas : même plan JSON en entrée, mêmes verdicts, ajout
  seul, nettoyage `finally`. Décision du propriétaire du 2026-10-23, dans sa formulation : « Fan-out
  de revue, en l'état — LangGraph structure le graphe rôles → lots → vérification → agrégation ; les
  passes Pi restent des nœuds-outils. Cumule l'obligation ADR-0045 (INV-a à INV-c avant le
  2026-12-31). La condition 6 d'ADR-0058 (valeur propre mesurée face à la version sans le paquet)
  dira si le gain est nul : un écart défavorable s'écrit, il n'interdit pas. » Le graphe LangGraph
  reste opaque et interne (ADR-0032 D3) ; aucun type du paquet n'entre dans le plan, le verdict ni le
  journal (D2) ; un checkpoint en mémoire le temps d'une invocation est permis, aucun checkpointer
  externe ne l'est (ADR-0058 section 2).

## 5. Métriques associées à une décision

Chaque métrique nomme la décision qu'elle déclenche et son seuil. Toutes se rejouent par la commande
indiquée ; les valeurs courantes sont des mesures datées. Les commandes qui enchaînent deux
programmes sont écrites en deux temps (« puis »), la norme refusant la barre de tube dans une cellule.

| Métrique | Commande | Valeur datée | Décision déclenchée | Seuil |
| --- | --- | --- | --- | --- |
| M1 — dépôts de la flotte qui épinglent la crate | `grep -rln 'libre-ai-agent-orchestrator' .clones/*/Cargo.toml .clones/*/crates/*/Cargo.toml`, puis retrait de la ligne de ce dépôt, puis `wc -l` | 0 (rejoué le 2026-10-15) | scinder / réintégrer / abandonner (AB-1) | 0 à la clôture du jalon B' d'ADR-0042 : sortie du cœur |
| M2 — journaux réels rejoués par un consommateur | test qui appelle `replay_authorized_execution` sur un journal produit par le consommateur (CA-8) | 0 | passage de `prototype` à `mise en service` | ≥ 1, dans la composition de flotte |
| M3 — couverture mesurée | `bun run check:coverage` dans la composition | `[NON VÉRIFIÉ]` | rendre le gate de couverture bloquant (R-6) | lignes ≥ 87 %, fonctions ≥ 90 % (`rust-coverage.sh:14-15`) |
| M4 — statut du contrat `tool-invocation-observation-v1` | `jq` sur `catalog.v1.json` au pin | `candidate` | maintenir ou retirer la surface 0.4.0 de la garantie de compatibilité (R-3, Q2) | `locked`, ou surface marquée instable |
| M5 — majeures de contrats lues **par le code** en commun avec ai-work-supervision et execution-sandbox | relevé section 11.1 du cahier, fichiers `*.rs`, `*.ts`, `*.toml` | 0 famille lue en même majeure par deux composants ; vrai par absence de lecteur côté `ai-work-supervision` (son domaine Rust n'importe aucun contrat), pas par écart de versions | fusion de spec / contrat d'interface commun (Q1) | ≥ 1 famille lue en même majeure par deux composants |
| M6 — second producteur de `review-verdict.v0.1` | `grep -rln 'review-verdict' .clones/*/ --include='*.ts'`, puis retrait des lignes de ce dépôt, puis `wc -l` | 0 (rejoué le 2026-10-15) | déplacer `tools/review` vers `project-governance` (AB-4) | ≥ 1 producteur hors dépôt |
| M7 — rejeu du banc à chaque montée de version | `ls docs/reviews/*/*/benchmark.txt`, puis `wc -l`, contre les entrées de `BREAKS.md` (CA-10) | 1 fichier (0.2.0) pour 3 entrées depuis 0.2.0 inclus ; 0 pour 2 postérieures | exiger la mesure dans la définition de fin d'une montée | 1 pour 1 |
| M8 — valeur propre du runtime LangGraph sur l'orchestrateur de revues (ADR-0058 section 3, condition 6) : taille du graphe de dépendances de `tools/review`, temps de démarrage de `fanout.ts --dry-run`, mémoire maximale, des deux côtés (avec et sans le paquet), verbatim | `bun pm ls --all` dans `tools/review`, puis `wc -l` ; `/usr/bin/time -l bun tools/review/fanout.ts PLAN-MESURE --dry-run` (PLAN-MESURE est défini en CA-24 : le plan d'exemple porte un commit nul que `fanout.ts` refuse avant le `--dry-run`) ; les deux côtés mesurés sur le même commit, le chemin sans le paquet restant exécutable (CA-29) | non mesurée (le paquet n'est pas encore dans le manifeste ; référence sans le paquet, mesurée le 2026-10-23 sur un clone sans `node_modules` : `bun pm ls --all --cwd tools/review`, puis `wc -l`, rend 42 lignes, l'en-tête compris ; à rejouer avant toute comparaison) | écriture de l'écart, avec sa date, dans `project.v1.yaml` (CA-24, CA-30) ; un écart défavorable n'interdit pas l'adoption, décidée par ADR-0058 ; sa lecture est une question du propriétaire, pas un seuil | aucun seuil : la décision déclenchée est l'écriture de l'écart |
| M9 — conformité ADR-0045 de l'orchestrateur de revues : les vecteurs rouges 1 à 4 de `docs/adr/0045-*.md` (Conséquences), verts, chacun prouvé rouge sans le contrôle : les vecteurs 1 à 3 sont ceux des trois invariants, le vecteur 4 (suite d'attaques adaptatives, taux d'utilité et taux d'attaque réussie rapportés ensemble) est ajouté au jalon par l'arbitrage du propriétaire du 2026-10-23 (CA-31, R-15 du cahier) | `bun test tools/review/vectors` (CA-26 à CA-28 et CA-31) | 0 vecteur (aucun n'existe au 2026-10-23 ; `ls tools/review/vectors` rend « No such file ») | avant le 2026-12-31 : activation de l'orchestrateur sous LangGraph avec des passes sans outil à effet ; à la date, suspension de l'orchestrateur tant que les vecteurs ne passent pas (ADR-0045 décision 4) | 4 vecteurs verts et 4 neutralisations rouges |

## 6. Hypothèses à valider et expérience

| # | Hypothèse | Expérience qui la valide |
| --- | --- | --- |
| H1 | Le contrat d'entrée de la crate (documents scellés + faits déclarés) est exprimable depuis l'état réel d'un runtime de la fabrique sans perte | Faire écrire par ai-work-supervision un adaptateur qui construit `RunControlState` et `StartPreflight` depuis son magasin et rejouer 10 missions (critère B' d'ADR-0042 section 3) ; mesurer le nombre de refus `schema-invalid` dus à l'adaptateur |
| H2 | Le rejeu octet-identique tient sur un journal produit par un tiers, pas seulement par les tests | CA-8 : journal réel versé, `replay_authorized_execution` rejoué, comparaison d'état |
| H3 | La fenêtre `windowSize` / `repeatThreshold` de l'observation détecte les boucles réelles sans refuser le travail légitime | Rejouer sur des traces de harness réelles anonymisées un échantillon de 100 000 appels (T5) ; compter les `no-progress` confirmés par relecture humaine ; critère de rejet proposé : plus de 1 `no-progress` sur 100 non confirmés à la relecture, soit un taux de faux positifs de 1 % (seuil proposé par cette spec, aucun seuil n'existe dans le dépôt) |
| H4 | Une crate sans capacité système suffit à porter la décision ; l'exécution reste simple côté consommateur | Mesurer, dans l'adaptateur de H1, le volume de code d'effet nécessaire hors crate et le comparer à la surface de 64 symboles |
| H5 | La séparation « décider / agir » en crate native n'est pas redondante avec un moteur d'exécution durable | Comparaison écrite (section 7) puis prototype minimal de la barrière `effect-state-unknown` sur un moteur durable ; test de discrimination : le moteur rejoue-t-il un effet sans statut terminal |
| H6 | L'équipe qui pose les règles tire de la crate un contrôle qu'elle n'obtient pas autrement : elle rejoue un journal `orchestrator-event.v3` d'un run d'`ai-work-supervision` et détecte une transition hors graphe injectée | Injecter une transition hors graphe dans un journal réel exporté, rejouer par `replay_authorized_execution` ; seuil : détection de l'injection sur au moins 1 journal réel ; aucun consommateur ne produit de journal aujourd'hui (M2 = 0) |
| H7 | Un graphe LangGraph apporte à un orchestrateur de sous-processus (passes `pi` lancées par `Bun.spawn`, aucun modèle appelé depuis TypeScript) une structure que `runBatched` et le journal n'offrent pas : reprise d'une campagne interrompue nœud par nœud, agrégation déclarée, lecture du graphe par un relecteur | M8 des deux côtés ; relecture du graphe par un second agent de famille distincte, qui nomme ce que le graphe exprime et que `fanout.ts` n'exprimait pas ; si la liste est vide, l'écart s'écrit (M8) et le propriétaire relit la décision ; la section 4 de l'ADR-0058 garde le retrait possible (CA-29) |

## 7. Positionnement face aux communs existants

Licences et dates de dernier push relevées le 2026-10-15 par `gh api repos/ORG/DEPOT --jq
'[.license.spdx_id,.pushed_at,.archived]'` (détection de licence de GitHub, non lecture du texte) ;
les affirmations sur ce que les communs offrent comme primitives restent `[NON VÉRIFIÉ]` (aucune
lecture de leur documentation dans la mission). La ligne LangGraph est relue le 2026-10-23
(`npm view @langchain/langgraph version license`).

| Commun | Recouvrement | Écart avec ce composant | Licence / maintenance |
| --- | --- | --- | --- |
| LangGraph JS (`langchain-ai/langgraphjs`, paquet `@langchain/langgraph`) | graphes d'étapes, reprise | catalogue de 10 patterns étudié à `c6910a9e`, statut `research-non-normative`, méthode d'étude inchangée (ADR-0032 D1) ; depuis ADR-0058 (2026-10-23) : runtime admis du graphe interne d'un worker TypeScript et de l'outillage de forge, jamais une autorité, jamais dans un contrat, jamais une persistance (D2, D3, D4 maintenus) ; premier consommateur : `tools/review` (S6) ; aucune dépendance LangGraph dans la crate Rust (ADR-0037 D6) | MIT ; `@langchain/langgraph` 1.5.2 et `@langchain/core` 1.3.0 publiés au 2026-10-23 ; avis de l'éditeur corrigés à partir de 1.4.21, 1.4.12 (checkpoint 1.1.4), core 1.1.8 et sdk 1.12.3 (CA-18) |
| Temporal (`temporalio/temporal`), Restate (`restatedev/restate`) | exécution durable, rejeu idempotent | ces moteurs exécutent ; la crate décide sans exécuter et ne porte aucune persistance (section 4.2 du cahier) ; la barrière « effet d'état inconnu » et la liaison de décision humaine n'y sont pas des primitives `[NON VÉRIFIÉ]` | Temporal : MIT, push 2026-10-15 ; Restate : `NOASSERTION` (détection nulle, licence `[NON VÉRIFIÉ]`), push 2026-10-14 ; aucun archivé |
| OpenTelemetry GenAI semantic conventions (`open-telemetry/semantic-conventions`) | observation d'appels d'outils par spans | ADR-0046 / I-33 : aucun argument, résultat ni horodatage par appel ne quitte le harness, empreintes HMAC par run ; OTel nomme les attributs d'outils, la crate rend un verdict | Apache-2.0, push 2026-10-14 ; aucune mention d'OTel dans le dépôt (`grep -rniE 'opentelemetry' .` rend 0 hors ce document, fiche `chevauchements_communs[2]`) |
| `deepseek-ai/deepseek-harness` | benchmark de parité déclaré sur la surface de plugins | ne porte pas le confinement ni la décision | MIT, push 2026-10-14, non archivé |
| in-toto (`in-toto/in-toto`), DSSE (`secure-systems-lab/dsse`) | attestations signées | `effect-attestation.v1`, `harness-attestation.v1` et `review-verdict.v0.1` sont trois formes d'attestation propres à la fabrique (`inventaire/synthese.md` section 4.1 relève « trois formats d'attestation ») ; aucune comparaison de format faite `[NON VÉRIFIÉ]` ; recouvre aussi `pi-evidence` et `artifact-verification` | in-toto : `NOASSERTION`, push 2026-08-27 ; DSSE : Apache-2.0, push 2026-10-09 |
| ai-work-supervision (interne) | missions, contrôle de run, budget, reprise après `SIGKILL`, idempotence, révision périmée (table au cahier section 11.1) | possède l'état accepté et les effets ; le cœur décide sur ses faits ; aucune majeure lue en commun par le code (M5) | EUPL-1.2 déclaré ; E10 : licence MIT constatée là-bas, hors scope |
| execution-sandbox (interne) | attestation de harness, profil de harness | produit `harness-attestation.v1` (`src/attestation.rs`) ; **aucun producteur déclaré** des fenêtres `tool-invocation-observation.v1` au commit lu (Q11) ; ce cœur est un évaluateur candidat de ces fenêtres ; aucune de ses pièces ne cite ce composant | non relevé ici (autre dépôt) |
| capability-authorization (interne) | producteur naturel de `biscuit_allowed`, `authorization_valid`, `AgentIdentity` que `StartPreflight` reçoit déclarés | non cité par les cinq fichiers au commit lu ; I-09 et I-18 portés par le consommateur | non relevé ici (autre dépôt) |
| pi-harness-challenger (interne) | policy-gate d'outils d'agent (R0-R3) | recoupe le verdict `tool-undeclared` ; non cité dans la spec initiale | non relevé ici (autre dépôt) |

Type de livrable de ce positionnement : **bibliothèque** (CADRAGE section 0) ; l'« intégration »
d'un moteur durable n'est pas retenue tant que H5 n'est pas rejouée. L'adoption de LangGraph JS dans
`tools/review` n'est pas une intégration de moteur durable : le paquet structure un outil de forge,
il ne porte ni run, ni mission, ni persistance (ADR-0058 section 2).

## 8. Devenir du projet

**Décision recommandée : conserver**, comme bibliothèque de décision pure, avec trois conditions
vérifiables et une scission déclarée par avance.

Argumentaire :

- Le cœur rejoue un oracle fort (54 + 14 vecteurs de l'autorité `schemas-and-contracts`, instantanés
  de surface et de codes) et une frontière d'effets exécutable ; ces deux propriétés sont celles qui
  manquent aux décisions d'orchestration écrites dans le code d'exécution
  (`tests-et-evaluation.md` section 3).
- Il n'a aucun consommateur (M1 = 0) : la valeur n'est pas démontrée en usage (I-19). Le conserver
  coûte la maintenance d'une surface de 64 symboles ; le retirer perd l'implémentation Rust qui
  rejoue ces vecteurs : les 54 + 14 vecteurs eux-mêmes appartiennent à `schemas-and-contracts`
  (I-03) et subsistent.
- La fusion avec `ai-work-supervision` supprimerait l'écart de contrats (M5). La frontière d'effets
  est un gate par crate (`check-capabilities.ts:96-125`) : elle se conserverait par crate dans un
  dépôt fusionné ; l'argument « B perd la frontière » n'est donc pas établi par les faits cités (Q1).
  Elle reste l'option B de Q1.

Tension à lire avant la décision : AB-1 se déclenche par défaut tant qu'aucun dépôt n'épingle la
crate, et B' n'exige pas ce dépôt (ADR-0042 section 3) ; le domaine Rust d'`ai-work-supervision`
n'importe aucun contrat (`specs/ai-work-supervision/architecture.md:81`). « Conserver » suppose donc
une décision préalable qui rattache ce dépôt à B' (Q1), sinon AB-1 s'applique.

Conditions de maintien :

1. M1 ≥ 1 à la clôture du jalon B' d'ADR-0042 section 3, sinon AB-1 s'applique ;
2. M4 : le contrat d'observation est verrouillé, ou la surface 0.4.0 est déclarée instable ;
3. M3 : la couverture est mesurée et publiée.

Scission anticipée : `tools/review` quitte ce dépôt pour `project-governance` dès qu'un second
producteur de `review-verdict.v0.1` existe (AB-4, M6) ; `docs/apps/memory.md` est tranché par Q5.
Tant que cette scission n'a pas lieu (Q3, option A, état courant), `tools/review` vit ici et le
jalon LangGraph de la section 9 s'y réalise ; le jour du déplacement, le paquet, ses gates et ses
vecteurs suivent l'outil, et la crate Rust n'en a jamais porté la dépendance (ADR-0037 D6).

Chevauchements nommés sans fusion de spec (mandat, addendum) : `ai-work-supervision` (famille
`execution-plan-body`, `orchestrator-event`, `execution-authorization`) et `execution-sandbox`
(`harness-profile`, `harness-attestation`). La dépendance annoncée vers `execution-sandbox`
(producteur des fenêtres d'observation) n'est déclarée que de ce côté : bilatérale à traiter côté
`execution-sandbox` (Q11). Le chevauchement fonctionnel avec `ai-work-supervision` est tabulé au
cahier section 11.1. La fusion éventuelle est un critère de revue de phase 2, pas une décision de
cette phase.

Moyen de validation : rejouer M1 à M7 au point B' ; la décision « conserver » est confirmée si
M1 ≥ 1 et M2 ≥ 1, infirmée par AB-1. Le jalon LangGraph se valide par M8 et M9.

## 9. Paquets de travail

Le tableau ci-dessous ne porte que le jalon décidé le 2026-10-23 : faire de `tools/review` le
premier consommateur LangGraph JS de la flotte, aux six conditions d'ADR-0058 section 3, sous
ADR-0045 (INV-a à INV-c avant le 2026-12-31), avec la preuve de retrait d'ADR-0058 section 4. Les
critères CA-1 à CA-17 du cahier, qui concernent la crate Rust, ses vecteurs et sa couverture, ne sont
pas découpés ici : leurs paquets relèvent d'un jalon ultérieur et d'une autre décision (section 8).
Le découpage suit l'ordre de réalisation que la doctrine impose : les gates d'entrée précèdent le
paquet (ADR-0058 Conséquences : « deux gates nouveaux à écrire dans le dépôt consommateur ») ;
INV-a à INV-c précèdent toute activation (ADR-0045 décision 4), comme le vecteur egress
(ADR-0058 section 3 condition 4) et le confinement des passes à leur worktree (CA-32, décision du
propriétaire du 2026-10-24), qui vaut aussi pour le chemin sans le paquet ; la mesure de valeur et la preuve de retrait ferment le jalon
(ADR-0058 section 3 condition 6 et section 4).

Ce tableau est approuvé : la norme n'accepte un trailer `Work-package` que si le PRD à ce commit est
au moins à `décision` (`ecosystem/work-package-policy.v1.yaml`, `approvedFrom`), et la pull request
dédiée qui a promu ce document l'a fait en citant l'arbitrage du propriétaire du 2026-10-23. La
ligne `WP-4` a été étendue ensuite par une pull request dédiée, qui cite l'arbitrage du propriétaire
du 2026-10-24 (CA-32, et les chemins du mécanisme de R-13 et des deux pilotes) ; l'issue de ce
paquet cite le commit de cette extension. Cette ligne a ensuite été scindée par une pull request dédiée,
qui cite l'arbitrage du propriétaire du 2026-10-26 : `CA-31` passe à la ligne `WP-7`, parce que son
rejeu de sorties de modèle enregistrées contre les contrôles déterministes ne dépend pas du
mécanisme de R-13, et WP-7 peut donc précéder WP-4 ; les issues de ces deux paquets citent le commit
de cette scission. Un paquet s'ouvre par une issue qui nomme ce document et
sa ligne.

Chaque périmètre nomme des chemins sous `tools/review/` ; `tools/review/gates/`,
`tools/review/vectors/` et `tools/review/advisories.v1.json` n'existent pas encore au commit lu
(`git ls-files tools/review` rend 8 fichiers) : ils sont déclarés à créer par WP-1, WP-3 et WP-4,
et le lecteur de la norme le signale comme tel ; `tools/review/confinement/`, ajouté le 2026-10-24
pour le mécanisme de R-13, est déclaré à créer par WP-4. `docs/evidence/` existe (une campagne).

Porte : les sept paquets sont `two-way`. Aucun ne modifie un contrat, un lock, une fiche de phase
acceptée ni un ruleset ; le paquet entre dans un espace de travail Bun propre à `tools/review`,
jamais dans `Cargo.toml` ; le chemin d'exécution sans le paquet reste vivant (CA-29), de sorte que le
retrait est une pull request qui défait l'ajout, sans migration d'un run ni d'un verdict enregistré ;
l'activation d'une passe avec outil à effet n'est ouverte par aucun paquet (elle relève d'ADR-0045
décision 4 et de la supervision humaine d'I-17) ; les mesures de WP-5 et la fiche de WP-6 sont des
écritures datées, défaites par une pull request. Le seul acte qui ne se défait pas, la suppression
de l'orchestrateur ou le déplacement du dépôt (AB-4), n'est pas dans ce jalon.

| WP | CA-n couverts | Périmètre (chemins, globs) | Vérification (commande) | Porte anticipée |
| --- | --- | --- | --- | --- |
| `WP-1` | `CA-18`, `CA-21`, `CA-23` | `tools/review/gates/**`, `tools/review/advisories.v1.json`, `package.json` | `bun test tools/review/gates` | `two-way` |
| `WP-2` | `CA-19`, `CA-20`, `CA-25` | `tools/review/*.ts`, `tools/review/package.json`, `tools/review/bun.lock`, `tools/review/bunfig.toml`, `package.json` | `bun run check:review-tools` | `two-way` |
| `WP-3` | `CA-26`, `CA-27`, `CA-28` | `tools/review/*.ts`, `tools/review/vectors/**` | `bun test tools/review/vectors` | `two-way` |
| `WP-4` | `CA-22`, `CA-32` | `tools/review/vectors/**`, `tools/review/confinement/**`, `tools/review/*.ts`, `docs/evidence/**` | `bun test tools/review/vectors` | `two-way` |
| `WP-5` | `CA-24` | `docs/evidence/**`, `project.v1.yaml`, `README.md` | `grep -n 'langgraph' project.v1.yaml` | `two-way` |
| `WP-6` | `CA-29`, `CA-30` | `tools/review/*.ts`, `project.v1.yaml`, `README.md` | `bun run check:review-tools` | `two-way` |
| `WP-7` | `CA-31` | `tools/review/vectors/**`, `tools/review/fanout-activation.ts`, `docs/evidence/**` | `bun test tools/review/vectors` | `two-way` |
