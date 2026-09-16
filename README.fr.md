<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Written for the retained Libre AI portfolio on 2026-09-14; earlier source documents and revisions retain their original licensing. -->

# Libre AI Execution Continuity Evaluator

## Usage visé

Aider un consommateur à évaluer la continuité d’une exécution à partir d’un état de travail explicite et d’observations vérifiées indépendamment : quelle transition est permise, quel résultat est confirmé et quelle décision reste en attente. AI Work Supervision décrit le travail. Ce composant évalue la continuité ; il ne planifie pas les workers, n’exécute pas le travail et n’autorise aucun effet externe.

## Candidats existants et limites

Les anciennes sources comprennent des composants d’évaluation de graphes d’exécution et d’enveloppe d’intégrité. Les évaluations pures et les simulations ne démontrent pas un orchestrateur opérationnel persistant. Ce candidat documentaire n’admet aucun système de pilotage actif, intégration de workers réels ou autorité pour produire des effets externes.

## Contrats proposés

Une étape identifie sa transition permise et les observations attendues. Un résultat distingue une action tentée de son issue confirmée. Une décision en attente reste explicite, sans être déduite d’un délai expiré. Un contenu non fiable conserve sa provenance ; une enveloppe d’intégrité ne rend pas ses instructions légitimes. Les formats d’échange canoniques nécessitent une admission par Contracts.

## Critères d’activation

Qualifier le cœur d’évaluation sur des entrées délimitées d’état et d’observation, avec un consommateur nommé et des décisions attendues vérifiées indépendamment. Tester les observations incomplètes ou contradictoires, les transitions refusées, les états d’interruption et de reprise, ainsi que les entrées répétées, sans assimiler un délai expiré ou une action tentée à une issue confirmée. Les intégrations d’exécuteur, de stockage persistant, de permissions et de confinement nécessitent leur propre admission lorsqu’elles sont retenues ; elles ne sont pas des prérequis du périmètre distinct de l’évaluateur pur. L’évaluateur ne transforme jamais son résultat en autorité pour produire une action externe.

Lorsqu’un exécuteur, un stockage persistant ou une autre intégration produisant des effets est retenu, sa qualification propre doit toujours tester les refus, interruptions, reprises, récupérations et la prévention des effets externes dupliqués ; la séparation de l’évaluateur pur ne dispense pas de ces critères de sécurité des intégrations.

La qualification suit le périmètre réellement retenu. Un module candidat peut être admis séparément avec son consommateur et ses preuves ; les critères de parcours complet s’appliquent au produit ou à l’intégration correspondante. Un noyau pur ne nécessite pas une intégration de worker, de base de données ou de relais hors de son périmètre. Ni l’admission d’un module ni l’existence documentaire de ce dépôt ne nécessitent un parcours Missions complet.

[English](README.md)

## Navigation du portefeuille

Ces liens décrivent le portefeuille retenu visé. La disponibilité publique et l’accessibilité ne sont pas vérifiées pour ce candidat privé.

### Produits

- [Libre AI Work Supervision](https://github.com/libre-ai/ai-work-supervision)
- [Libre AI Model Policy](https://github.com/libre-ai/ai-model-policy)
- [Libre AI Practice Workbench](https://github.com/libre-ai/ai-practice-workbench)
- [Libre AI Learning Session Facilitation](https://github.com/libre-ai/learning-session-facilitation)
- [Libre AI Personal Knowledge Notebook](https://github.com/libre-ai/personal-knowledge-notebook)
- [Libre AI Information Feed Filter](https://github.com/libre-ai/information-feed-filter)
- [Libre AI Travel Itinerary Planner](https://github.com/libre-ai/travel-itinerary-planner)
- [Libre AI Public Vote Comparison](https://github.com/libre-ai/public-vote-comparison)

### Composants et outils

- [Libre AI Application Development Toolkit](https://github.com/libre-ai/application-development-toolkit)
- [Libre AI Schemas And Contracts](https://github.com/libre-ai/schemas-and-contracts)
- [Libre AI Collaborative Data Sync](https://github.com/libre-ai/collaborative-data-sync)
- [Libre AI Execution Continuity Evaluator](https://github.com/libre-ai/execution-continuity-evaluator)
- [Libre AI Execution Sandbox](https://github.com/libre-ai/execution-sandbox)
- [Libre AI Capability Authorization](https://github.com/libre-ai/capability-authorization)
- [Libre AI Organization Data Lifecycle](https://github.com/libre-ai/organization-data-lifecycle)
- [Libre AI Database Policy Inspector](https://github.com/libre-ai/database-policy-inspector)
- [Libre AI Artifact Verification](https://github.com/libre-ai/artifact-verification)

### Projet

- [Libre AI](https://github.com/libre-ai/.github)
- [Libre AI Project Website](https://github.com/libre-ai/project-website)
- [Libre AI Project Governance](https://github.com/libre-ai/project-governance)



---

## Source éditoriale revue

[Matière revue](https://github.com/libre-ai/execution-continuity-evaluator/blob/dac5ccb47cd1e1dd52fd383fe513e7dc5b860be2/docs/portfolio-material.json)

SHA-256: `f84e49bc2c1f8df35d363f3a7b91ee1f92b1874767886e74ccaecd63f4c65213`
