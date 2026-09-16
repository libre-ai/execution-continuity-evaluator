<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Written for the retained Libre AI portfolio on 2026-09-14; earlier source documents and revisions retain their original licensing. -->

# Libre AI Execution Continuity Evaluator

## Intended use

Help a consumer evaluate execution continuity from explicit work state and independently checked observations: which transition is permitted, which result is confirmed and which decision remains pending. AI Work Supervision describes the work. This component evaluates continuity; it does not schedule workers, execute work or authorize external effects.

## Existing candidates and limits

Earlier sources include execution-graph evaluation and integrity-envelope components. Pure evaluations and simulations do not prove a persistent operational orchestrator. This documentary candidate admits no running control plane, real worker integration or authority to perform external effects.

## Proposed contracts

An execution step identifies its permitted transition and expected observations. A result distinguishes an attempted action from its confirmed outcome. A pending decision remains explicit rather than being inferred from a timeout. Untrusted content keeps its provenance; an integrity envelope does not make its instructions authoritative. Canonical exchange formats require admission by Contracts.

## Activation criteria

Qualify the evaluation core on bounded state and observation inputs with a named consumer and independently checked expected decisions. Test incomplete or conflicting observations, refused transitions, interruption and recovery states, and repeated inputs without treating a timeout or attempted action as a confirmed outcome. Executor, persistent storage, permission and confinement integrations require their own admission when selected; they are not prerequisites for the pure evaluator’s separate scope. The evaluator never turns an evaluation result into authority to perform an external action.

When an executor, persistent storage or other effect-producing integration is selected, its own qualification must still test refusal, interruption, retries, recovery and prevention of duplicate external effects; separating the pure evaluator does not waive these integration safety criteria.

Qualification follows the actual selected scope. A candidate module may be admitted independently with its own consumer and evidence; complete journey criteria apply to the corresponding product or integration. A pure core does not require a worker, database or relay integration that is outside its scope. Neither module admission nor this repository’s documentary existence requires a complete Missions journey.

[Français](README.fr.md)

## Portfolio navigation

These links describe the intended retained portfolio. Public availability and reachability are not verified for this private candidate.

### Products

- [Libre AI Work Supervision](https://github.com/libre-ai/ai-work-supervision)
- [Libre AI Model Policy](https://github.com/libre-ai/ai-model-policy)
- [Libre AI Practice Workbench](https://github.com/libre-ai/ai-practice-workbench)
- [Libre AI Learning Session Facilitation](https://github.com/libre-ai/learning-session-facilitation)
- [Libre AI Personal Knowledge Notebook](https://github.com/libre-ai/personal-knowledge-notebook)
- [Libre AI Information Feed Filter](https://github.com/libre-ai/information-feed-filter)
- [Libre AI Travel Itinerary Planner](https://github.com/libre-ai/travel-itinerary-planner)
- [Libre AI Public Vote Comparison](https://github.com/libre-ai/public-vote-comparison)

### Components and tools

- [Libre AI Application Development Toolkit](https://github.com/libre-ai/application-development-toolkit)
- [Libre AI Schemas And Contracts](https://github.com/libre-ai/schemas-and-contracts)
- [Libre AI Collaborative Data Sync](https://github.com/libre-ai/collaborative-data-sync)
- [Libre AI Execution Continuity Evaluator](https://github.com/libre-ai/execution-continuity-evaluator)
- [Libre AI Execution Sandbox](https://github.com/libre-ai/execution-sandbox)
- [Libre AI Capability Authorization](https://github.com/libre-ai/capability-authorization)
- [Libre AI Organization Data Lifecycle](https://github.com/libre-ai/organization-data-lifecycle)
- [Libre AI Database Policy Inspector](https://github.com/libre-ai/database-policy-inspector)
- [Libre AI Artifact Verification](https://github.com/libre-ai/artifact-verification)

### Project

- [Libre AI](https://github.com/libre-ai/.github)
- [Libre AI Project Website](https://github.com/libre-ai/project-website)
- [Libre AI Project Governance](https://github.com/libre-ai/project-governance)



---

## Reviewed editorial source

[Reviewed material](https://github.com/libre-ai/execution-continuity-evaluator/blob/dac5ccb47cd1e1dd52fd383fe513e7dc5b860be2/docs/portfolio-material.json)

SHA-256: `f84e49bc2c1f8df35d363f3a7b91ee1f92b1874767886e74ccaecd63f4c65213`
