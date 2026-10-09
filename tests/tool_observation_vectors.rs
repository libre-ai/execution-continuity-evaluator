//! Conformance of the pure tool-observation evaluator (ADR-0046) against the
//! contract authority's `tool-invocation-observation-v1` vectors, replayed
//! directly from the pinned `schemas-and-contracts` checkout.
//!
//! Two inputs of the evaluator are not carried by the semantic vectors, and
//! each is supplied here by a declared rule rather than a silent default:
//!
//! - **Signatures.** Every vector document carries the same placeholder
//!   signature (64 zero bytes) under `harness_key_1`, and the authority
//!   publishes no harness test key. The conformance verifier therefore accepts
//!   exactly that placeholder and nothing else, and
//!   `vector_signatures_are_the_published_placeholder` fails the day the
//!   authority publishes real signatures, so this rule cannot outlive its
//!   reason. A refusing verifier is exercised separately below.
//! - **`toolCalls`.** The vectors carry no orchestrator counter. A stream is
//!   given the counter its own final window declares (the last
//!   `lastCallSequence`): the only value consistent with a `progress` stream.
//!   The mismatch rule is exercised separately below.

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;

use libre_ai_agent_orchestrator::{
    HarnessSignatureVerifier, ToolObservationDecision, ToolObservationInput,
    ToolObservationRefusal, ToolObservationVerdict, evaluate_tool_observations,
};
use libre_ai_contract_types::ContractRegistry;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const VECTORS: &str = "node_modules/@libre-ai/contracts-authority/contracts/fixtures/tool-invocation-observation-v1/vectors.json";
const PLACEHOLDER_KEY_ID: &str = "harness_key_1";
const PLACEHOLDER_SIGNATURE: &str =
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
/// Re-measured on `schemas-and-contracts@197d8299`: 14 semantic, 4 valid,
/// 40 invalid. A different count is a different suite, not a pass.
const SEMANTIC_VECTOR_COUNT: usize = 14;
const VALID_VECTOR_COUNT: usize = 4;
const INVALID_VECTOR_COUNT: usize = 40;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    schema_version: String,
    valid: Vec<DocumentVector>,
    invalid: Vec<DocumentVector>,
    semantic: Vec<SemanticVector>,
}

#[derive(Deserialize)]
struct DocumentVector {
    name: String,
    document: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticVector {
    name: String,
    parameters: SemanticParameters,
    observations: Vec<Value>,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticParameters {
    plan_tool_names: Vec<String>,
}

struct PublishedPlaceholderVerifier;

impl HarnessSignatureVerifier for PublishedPlaceholderVerifier {
    fn verify(&self, signing_key_id: &str, _preimage: &[u8], signature: &str) -> bool {
        signing_key_id == PLACEHOLDER_KEY_ID && signature == PLACEHOLDER_SIGNATURE
    }
}

struct RefusingVerifier;

impl HarnessSignatureVerifier for RefusingVerifier {
    fn verify(&self, _signing_key_id: &str, _preimage: &[u8], _signature: &str) -> bool {
        false
    }
}

/// Records the preimage digest of every call, to prove what is handed over.
struct RecordingVerifier {
    seen: RefCell<Vec<String>>,
}

impl HarnessSignatureVerifier for RecordingVerifier {
    fn verify(&self, _signing_key_id: &str, preimage: &[u8], _signature: &str) -> bool {
        let digest: String = Sha256::digest(preimage)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        self.seen.borrow_mut().push(digest);
        true
    }
}

fn vectors() -> Vectors {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(VECTORS);
    let source =
        fs::read_to_string(path).expect("pinned tool-observation vectors must be readable");
    serde_json::from_str(&source).expect("tool-observation vectors must match their declared shape")
}

fn registry() -> ContractRegistry {
    ContractRegistry::embedded().expect("embedded registry")
}

/// Recomputes `preimageDigest` after a deliberate edit, so that a derived
/// stream fails on the rule under test and not on its seal.
fn reseal(document: &mut Value) {
    let mut preimage = document.clone();
    let object = preimage.as_object_mut().expect("document object");
    object.remove("preimageDigest");
    object.remove("signature");
    let canonical = serde_jcs::to_vec(&preimage).expect("canonical preimage");
    let digest: String = Sha256::digest(canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    document["preimageDigest"] = Value::String(digest);
}

/// Derived streams carry their own toolCalls counter: the final window's.
fn evaluate_documents(
    registry: &ContractRegistry,
    documents: &[Value],
    plan_tool_names: &[String],
) -> ToolObservationDecision {
    evaluate_tool_observations(
        registry,
        ToolObservationInput {
            documents,
            plan_tool_names,
            observed_tool_calls: final_call_sequence(documents),
        },
        &PublishedPlaceholderVerifier,
    )
}

fn final_call_sequence(observations: &[Value]) -> u64 {
    observations
        .last()
        .and_then(|document| document["window"]["lastCallSequence"].as_u64())
        .unwrap_or(0)
}

fn evaluate(
    registry: &ContractRegistry,
    vector: &SemanticVector,
    observed_tool_calls: u64,
    verifier: &dyn HarnessSignatureVerifier,
) -> ToolObservationDecision {
    evaluate_tool_observations(
        registry,
        ToolObservationInput {
            documents: &vector.observations,
            plan_tool_names: &vector.parameters.plan_tool_names,
            observed_tool_calls,
        },
        verifier,
    )
}

fn semantic<'a>(vectors: &'a Vectors, name: &str) -> &'a SemanticVector {
    vectors
        .semantic
        .iter()
        .find(|vector| vector.name == name)
        .unwrap_or_else(|| panic!("semantic vector {name:?} must exist"))
}

#[test]
fn every_semantic_vector_reaches_its_declared_verdict() {
    let vectors = vectors();
    assert_eq!(
        vectors.schema_version,
        "libre-ai.tool-invocation-observation-vectors.v1"
    );
    let registry = registry();
    let mut matched = 0_usize;
    let mut mismatches = Vec::new();
    for vector in &vectors.semantic {
        let decision = evaluate(
            &registry,
            vector,
            final_call_sequence(&vector.observations),
            &PublishedPlaceholderVerifier,
        );
        if decision.code() == vector.expected {
            matched += 1;
        } else {
            mismatches.push(format!(
                "{}: expected {}, got {}",
                vector.name,
                vector.expected,
                decision.code()
            ));
        }
    }
    println!(
        "tool-observation conformance: {matched}/{} semantic vectors",
        vectors.semantic.len()
    );
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    assert_eq!(vectors.semantic.len(), SEMANTIC_VECTOR_COUNT);
    assert_eq!(matched, SEMANTIC_VECTOR_COUNT);
}

#[test]
fn the_semantic_suite_exercises_every_closed_verdict() {
    let vectors = vectors();
    let mut exercised: Vec<&str> = vectors
        .semantic
        .iter()
        .map(|vector| vector.expected.as_str())
        .collect();
    exercised.sort_unstable();
    exercised.dedup();
    let mut closed: Vec<&str> = [
        ToolObservationVerdict::AttestationInvalid,
        ToolObservationVerdict::ObservationReplayed,
        ToolObservationVerdict::ObservationChainBroken,
        ToolObservationVerdict::ObservationIncomplete,
        ToolObservationVerdict::ToolUndeclared,
        ToolObservationVerdict::NoProgress,
        ToolObservationVerdict::Progress,
    ]
    .iter()
    .map(|verdict| verdict.code())
    .collect();
    closed.sort_unstable();
    assert_eq!(exercised, closed);
}

#[test]
fn vector_signatures_are_the_published_placeholder() {
    let vectors = vectors();
    let mut documents = 0_usize;
    for vector in &vectors.semantic {
        for document in &vector.observations {
            documents += 1;
            assert_eq!(
                document["signingKeyId"], PLACEHOLDER_KEY_ID,
                "{}",
                vector.name
            );
            assert_eq!(
                document["signature"], PLACEHOLDER_SIGNATURE,
                "{}",
                vector.name
            );
        }
    }
    assert!(documents > 0);
}

#[test]
fn every_schema_invalid_vector_is_refused_before_evaluation() {
    let vectors = vectors();
    let registry = registry();
    assert_eq!(vectors.invalid.len(), INVALID_VECTOR_COUNT);
    let mut refused = 0_usize;
    for vector in &vectors.invalid {
        let documents = [vector.document.clone()];
        let decision = evaluate_tool_observations(
            &registry,
            ToolObservationInput {
                documents: &documents,
                plan_tool_names: &[],
                observed_tool_calls: 0,
            },
            &PublishedPlaceholderVerifier,
        );
        assert_eq!(
            decision,
            ToolObservationDecision::Refused(ToolObservationRefusal::SchemaInvalid),
            "{}",
            vector.name
        );
        refused += 1;
    }
    println!("tool-observation schema refusal: {refused}/{INVALID_VECTOR_COUNT} invalid vectors");
    assert_eq!(refused, INVALID_VECTOR_COUNT);
}

#[test]
fn every_schema_valid_vector_reaches_evaluation() {
    let vectors = vectors();
    let registry = registry();
    assert_eq!(vectors.valid.len(), VALID_VECTOR_COUNT);
    for vector in &vectors.valid {
        let documents = [vector.document.clone()];
        let decision = evaluate_tool_observations(
            &registry,
            ToolObservationInput {
                documents: &documents,
                plan_tool_names: &[],
                observed_tool_calls: 0,
            },
            &PublishedPlaceholderVerifier,
        );
        assert!(decision.evaluation().is_some(), "{}", vector.name);
    }
}

#[test]
fn a_signature_the_verifier_refuses_is_attestation_invalid() {
    let vectors = vectors();
    let registry = registry();
    for name in [
        "a chained stream with no repeated couple makes progress",
        "a window bound to another worker invocation is a replay",
    ] {
        let vector = semantic(&vectors, name);
        let decision = evaluate(
            &registry,
            vector,
            final_call_sequence(&vector.observations),
            &RefusingVerifier,
        );
        assert_eq!(decision.code(), "attestation-invalid", "{name}");
    }
}

#[test]
fn the_verifier_receives_the_sealed_preimage_of_every_document() {
    let vectors = vectors();
    let registry = registry();
    let vector = semantic(
        &vectors,
        "a chained stream with no repeated couple makes progress",
    );
    let verifier = RecordingVerifier {
        seen: RefCell::new(Vec::new()),
    };
    let decision = evaluate(
        &registry,
        vector,
        final_call_sequence(&vector.observations),
        &verifier,
    );
    assert_eq!(decision.code(), "progress");
    let claimed: Vec<String> = vector
        .observations
        .iter()
        .map(|document| {
            document["preimageDigest"]
                .as_str()
                .expect("preimage digest")
                .to_owned()
        })
        .collect();
    assert_eq!(*verifier.seen.borrow(), claimed);
}

#[test]
fn a_covered_count_other_than_the_tool_calls_counter_is_incomplete() {
    let vectors = vectors();
    let registry = registry();
    for name in [
        "a chained stream with no repeated couple makes progress",
        "the same couple k times in one window is no progress",
    ] {
        let vector = semantic(&vectors, name);
        let covered = final_call_sequence(&vector.observations);
        for observed in [covered - 1, covered + 1, 0] {
            let decision = evaluate(&registry, vector, observed, &PublishedPlaceholderVerifier);
            assert_eq!(
                decision.code(),
                "observation-incomplete",
                "{name} with toolCalls {observed}"
            );
        }
    }
}

#[test]
fn an_empty_stream_is_incomplete_and_counts_nothing() {
    let registry = registry();
    let decision = evaluate_tool_observations(
        &registry,
        ToolObservationInput {
            documents: &[],
            plan_tool_names: &[],
            observed_tool_calls: 0,
        },
        &PublishedPlaceholderVerifier,
    );
    let evaluation = decision.evaluation().expect("an empty stream is evaluated");
    assert_eq!(
        evaluation.verdict(),
        ToolObservationVerdict::ObservationIncomplete
    );
    assert_eq!(evaluation.counters().documents_read, 0);
    assert_eq!(evaluation.counters().calls_covered, 0);
}

#[test]
fn counters_report_what_was_examined() {
    let vectors = vectors();
    let registry = registry();
    let vector = semantic(
        &vectors,
        "k identical consecutive calls across a disjoint window boundary are seen in the k - 1 overlap",
    );
    let decision = evaluate(
        &registry,
        vector,
        final_call_sequence(&vector.observations),
        &PublishedPlaceholderVerifier,
    );
    let evaluation = decision.evaluation().expect("evaluated");
    assert_eq!(evaluation.verdict(), ToolObservationVerdict::NoProgress);
    let counters = evaluation.counters();
    let documents = vector.observations.len() as u64;
    let entries: u64 = vector
        .observations
        .iter()
        .map(|document| document["entries"].as_array().map_or(0, Vec::len) as u64)
        .sum();
    let threshold = vector.observations[0]["window"]["repeatThreshold"]
        .as_u64()
        .expect("k");
    assert_eq!(counters.documents_read, documents);
    assert_eq!(counters.entries_read, entries);
    assert_eq!(
        counters.calls_covered,
        final_call_sequence(&vector.observations)
    );
    assert!(counters.maximum_repetition >= threshold);
}

// ---- Rules the authority's semantic vectors leave unexercised ---------------
//
// Each stream below is derived from an authority vector and resealed, so its
// only defect is the one named by the test.

const PROGRESS: &str = "a chained stream with no repeated couple makes progress";

#[test]
fn a_skipped_window_sequence_breaks_the_chain() {
    let vectors = vectors();
    let registry = registry();
    let vector = semantic(&vectors, PROGRESS);
    let mut documents = vector.observations.clone();
    documents[1]["window"]["sequence"] = Value::from(3);
    reseal(&mut documents[1]);
    let decision = evaluate_documents(&registry, &documents, &vector.parameters.plan_tool_names);
    assert_eq!(decision.code(), "observation-chain-broken");
}

#[test]
fn a_document_after_a_final_window_breaks_the_chain() {
    let vectors = vectors();
    let registry = registry();
    let vector = semantic(&vectors, PROGRESS);
    let mut documents = vector.observations.clone();
    documents[0]["window"]["final"] = Value::Bool(true);
    reseal(&mut documents[0]);
    documents[1]["previousObservationDigest"] = documents[0]["preimageDigest"].clone();
    reseal(&mut documents[1]);
    let decision = evaluate_documents(&registry, &documents, &vector.parameters.plan_tool_names);
    assert_eq!(decision.code(), "observation-chain-broken");
}

#[test]
fn a_repeated_window_sequence_is_a_replay() {
    let vectors = vectors();
    let registry = registry();
    let vector = semantic(&vectors, PROGRESS);
    let mut documents = vector.observations.clone();
    documents.push(documents[1].clone());
    let decision = evaluate_documents(&registry, &documents, &vector.parameters.plan_tool_names);
    assert_eq!(decision.code(), "observation-replayed");
}

#[test]
fn a_couple_split_across_entries_still_counts_once() {
    let vectors = vectors();
    let registry = registry();
    let vector = semantic(
        &vectors,
        "the same couple k times in one window is no progress",
    );
    let mut documents = vector.observations.clone();
    let entry = documents[0]["entries"][0].clone();
    let mut head = entry.clone();
    head["count"] = Value::from(2);
    head["lastCallSequence"] = Value::from(2);
    let mut tail = entry;
    tail["count"] = Value::from(2);
    tail["firstCallSequence"] = Value::from(3);
    documents[0]["entries"] = Value::Array(vec![head, tail]);
    reseal(&mut documents[0]);
    let decision = evaluate_documents(&registry, &documents, &vector.parameters.plan_tool_names);
    assert_eq!(decision.code(), "no-progress");
    let counters = decision.evaluation().expect("evaluated").counters();
    assert_eq!(counters.maximum_repetition, 4);
}

#[test]
fn the_verdict_order_puts_attestation_before_every_other_finding() {
    let vectors = vectors();
    let registry = registry();
    // A replayed stream with an altered seal: two findings, the first wins.
    let vector = semantic(
        &vectors,
        "a window bound to another worker invocation is a replay",
    );
    let mut documents = vector.observations.clone();
    documents[0]["preimageDigest"] = Value::String("0".repeat(64));
    let decision = evaluate_documents(&registry, &documents, &vector.parameters.plan_tool_names);
    assert_eq!(decision.code(), "attestation-invalid");
}

#[test]
fn an_undeclared_tool_outranks_no_progress() {
    let vectors = vectors();
    let registry = registry();
    let vector = semantic(
        &vectors,
        "the same couple k times in one window is no progress",
    );
    let decision = evaluate_documents(&registry, &vector.observations, &[]);
    assert_eq!(decision.code(), "tool-undeclared");
}

#[test]
fn rendered_forms_carry_codes_and_counts_never_content() {
    let refused = ToolObservationDecision::Refused(ToolObservationRefusal::SchemaInvalid);
    assert_eq!(
        refused.to_string(),
        "orchestrator.tool-observation.schema-invalid"
    );
    assert_eq!(
        ToolObservationRefusal::SchemaInvalid.to_string(),
        refused.code()
    );
    assert!(refused.evaluation().is_none());
    assert_eq!(
        ToolObservationVerdict::NoProgress.to_string(),
        "no-progress"
    );

    let vectors = vectors();
    let vector = semantic(&vectors, PROGRESS);
    let input = ToolObservationInput {
        documents: &vector.observations,
        plan_tool_names: &vector.parameters.plan_tool_names,
        observed_tool_calls: 5,
    };
    let rendered = format!("{input:?}");
    assert_eq!(
        rendered,
        "ToolObservationInput { document_count: 2, plan_tool_count: 2, observed_tool_calls: 5 }"
    );
    let registry = registry();
    let decision = evaluate_tool_observations(&registry, input, &PublishedPlaceholderVerifier);
    assert_eq!(decision.to_string(), "progress");
}
