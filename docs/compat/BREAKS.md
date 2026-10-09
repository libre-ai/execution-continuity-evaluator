# Compat-policy breaks journal

Mechanized by `tests/compat_surface.rs` against `project.v1.yaml`'s
`compat-policy` exit criterion. Two surfaces are pinned: the symbols
`src/lib.rs` re-exports (`tests/compat/public_surface.snapshot`) and the
exhaustive stable code strings (`tests/compat/stable_codes.snapshot`). Both
are consumed as fact by anything that git-deps this crate.

`cargo test --locked` fails the moment either drifts from its snapshot. The
fix is never to only edit the snapshot: a real, intentional break is recorded
here — date, what changed, old value, new value, why — in the same commit
that bumps `version` in `Cargo.toml` and updates the snapshot file.

| Date | Crate version | Surface | Change | Reason |
| ---- | ------------- | ------- | ------ | ------ |
| 2026-09-10 | 0.2.0 | Public API and stable codes | Add the authorized-execution graph, routing, authority, causal-validation, deterministic-replay, human-decision, generation-transfer and effect-continuity surface; retain all 0.1.0 symbols and behavior | Record the first coherent additive authorized-execution API before any consumer can pin it |
| 2026-10-09 | 0.3.0 | Public API and stable codes | Add `evaluate_bound_human_decision` and the `DecisionRefusal` variants `GraphBindingMismatch` (`graph-binding-mismatch`), `StepNotDecision` (`step-not-decision`) and `DecisionPolicyMismatch` (`decision-policy-mismatch`); `evaluate_human_decision` and every 0.2.0 symbol and code keep their behavior. A consumer matching `DecisionRefusal` exhaustively must add the three arms | Bind a decision request to its step's policy (candidate `decision-binding-vectors.v1`, `libre-ai/schemas-and-contracts` `599cd8e`): a request could otherwise invert the outcomes of its choices or lower the approver role |
| 2026-10-09 | 0.4.0 | Public API and stable codes | Add the pure tool-observation evaluator (`evaluate_tool_observations`, its input, counters, decision, caller-supplied `HarnessSignatureVerifier`), the 7 closed verdict codes of ADR-0046 decision 4 and `orchestrator.tool-observation.schema-invalid`; move the `libre-ai-contract-types` pin from `4f3d53c3` to `197d8299`, which embeds the candidate `tool-invocation-observation.v1` schema; retain all 0.3.0 symbols and behavior | ADR-0046 (accepted 2026-10-09) authorizes the evaluator after acceptance; its 14 semantic vectors had no executing code before this version |
