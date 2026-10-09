# orchestrator

Agent orchestration brick of the Libre AI constellation (couche 2) — the
agent-orchestrator crate, the review fan-out and its proof surface.

Born from the hub dismantling ([ADR-0020](https://github.com/libre-ai/governance/blob/main/docs/adr/0020-general-activation-and-hub-dismantling.md)). Consumed as a sha-pinned Cargo git-dep.

## Authorized-execution API

The `0.2.0` API validates locked contract documents and evaluates graph,
causal, human-decision, generation-transfer and effect-continuity semantics
without performing I/O. This synthetic example is compiled by
`cargo test --doc --locked` through the crate-level README inclusion:

```rust
use libre_ai_agent_orchestrator::{evaluate_graph, parse_authorized_graph};
use libre_ai_contract_types::ContractRegistry;
use serde_json::json;

let registry = ContractRegistry::embedded().expect("embedded schemas are build-time authorities");
let document = json!({
    "schemaVersion": "libre-ai.execution-graph.v1",
    "id": "urn:libre-ai:graph:synthetic-example",
    "organizationId": "ten_1234567890abcdef",
    "entryStepId": "urn:libre-ai:step:calculate",
    "steps": [
        {
            "stepId": "urn:libre-ai:step:calculate",
            "kind": "calculation",
            "outcomeCodes": ["ready"],
            "retryPolicy": { "maximumAttempts": 1, "retryableOutcomeCodes": [] }
        },
        {
            "stepId": "urn:libre-ai:step:terminal",
            "kind": "terminal",
            "outcomeCodes": []
        }
    ],
    "edges": [{
        "edgeId": "urn:libre-ai:edge:complete",
        "fromStepId": "urn:libre-ai:step:calculate",
        "outcomeCode": "ready",
        "toStepId": "urn:libre-ai:step:terminal"
    }],
    "createdAt": "2026-09-10T10:00:00Z",
    // Seal: SHA-256 of the JCS form of this document without `graphDigest`.
    // A document whose seal is not the digest of its content is refused.
    "graphDigest": "4dee06c8098e4bb29175d14dd19afab992b37a68db811436b83e237a1e622b39"
});
let graph = parse_authorized_graph(&registry, &document).expect("valid synthetic graph");
assert_eq!(evaluate_graph(&graph).code(), "graph-valid");
```

Returned applications are pure proposals. They require a separately
authorized persistence and effect boundary before they can change external
state.

## Tool-observation evaluator

The `0.4.0` API adds `evaluate_tool_observations`, the pure evaluator of
[ADR-0046](https://github.com/libre-ai/project-governance/blob/HEAD/docs/adr/0046-tool-invocation-observation.md).
It replays the harness-signed `tool-invocation-observation.v1` windows of one
worker invocation and renders one closed verdict, the first that applies in
this order: `attestation-invalid`, `observation-replayed`,
`observation-chain-broken`, `observation-incomplete`, `tool-undeclared`,
`no-progress`, `progress`. Every verdict carries its counters (documents read,
entries read, calls covered, maximum repetition); a schema-invalid document is
refused before evaluation with `orchestrator.tool-observation.schema-invalid`.

- **Inputs.** The documents, the plan's tool names, the `toolCalls` counter the
  orchestrator received (OBS-e: a covered count that differs is
  `observation-incomplete`, never a correction), and a caller-supplied
  `HarnessSignatureVerifier` bound to the run's harness attestation. The crate
  holds no key: argument and result digests are compared, never computed
  (OBS-b), and the capability boundary admits no signature dependency.
- **Authority.** The verdict is `operational` data and blocks nothing on its
  own (K2). The harness holds the typed `no-progress` stop on its sliding
  window (ADR-0046 decision 2, owner decision Q5); a disagreement between the
  harness reaction and this verdict is itself a finding.
- **Conformance.** `tests/tool_observation_vectors.rs` replays every semantic
  vector of the pinned `schemas-and-contracts` revision and requires 14 of 14,
  and refuses each of its 40 schema-invalid vectors.

```rust
use libre_ai_agent_orchestrator::{
    HarnessSignatureVerifier, ToolObservationInput, evaluate_tool_observations,
};
use libre_ai_contract_types::ContractRegistry;

struct NoKnownKey;
impl HarnessSignatureVerifier for NoKnownKey {
    fn verify(&self, _key_id: &str, _preimage: &[u8], _signature: &str) -> bool {
        false
    }
}

let registry = ContractRegistry::embedded().expect("embedded schemas are build-time authorities");
let decision = evaluate_tool_observations(
    &registry,
    ToolObservationInput { documents: &[], plan_tool_names: &[], observed_tool_calls: 0 },
    &NoKnownKey,
);
// No document means no final window: the stream is not complete.
assert_eq!(decision.code(), "observation-incomplete");
```

## Verify

```sh
bun install --frozen-lockfile && bun run check
cargo test --locked
```

## État du projet

<!-- libre-ai:project-status:begin -->
<!-- Section générée depuis project.v1.yaml — ne pas éditer à la main. -->

- Situation actuelle : Le noyau natif authorized-execution 0.2.0 de WP-G3-O02 est prouvé sur un commit immuable. Le run boundary, les effets réels et le déploiement restent bloqués et WP-G3-O01 n'est pas revendiqué.
- Maturité : usable
- Exposition : spec-published
- Confiance : medium
- Preuves vérifiées le : 2026-09-10
- Avancement : 100 % du périmètre actuellement déclaré

<!-- libre-ai:project-status:end -->

La fiche [`project.v1.yaml`](./project.v1.yaml) est l'autorité de l'état du projet ; cette section en est générée et le gate de flotte échoue si elles divergent.
