//! Every authorized-execution document carries its own canonical digest
//! (SHA-256 of its JCS form without the digest field). An evaluator that only
//! compares the claimed digest with another claimed digest lets a document be
//! changed after it was sealed — for a human decision, the approved request
//! and the request that is applied stop being the same object. These tests
//! give each evaluated document a wrong seal over intact content and require
//! the boundary refusal, and check the seal rule against the contract
//! authority's own digest vectors.

mod support;

use std::fs;
use std::path::PathBuf;

use libre_ai_agent_orchestrator::{
    DecisionObservation, EffectObservation, TransferObservation, evaluate_effect_attestation,
    evaluate_execution_transfer, evaluate_graph_authority, evaluate_human_decision,
    parse_authorized_graph,
};
use libre_ai_contract_types::ContractRegistry;
use serde_json::Value;
use support::authorized_execution::{
    canonical_digest, reseal_decision_request, reseal_decision_response, schema_fixture,
    valid_decision_request, valid_decision_response, valid_effect_attestation,
    valid_execution_transfer, valid_graph_document, valid_plan_document,
};

const SCHEMA_INVALID: &str = "orchestrator.authorized-execution.schema-invalid";
const FORGED: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const DIGEST_VECTORS: &str = "node_modules/@libre-ai/contracts-authority/contracts/fixtures/authorized-execution-v1/digest-vectors.v1.json";

fn registry() -> ContractRegistry {
    ContractRegistry::embedded().expect("embedded registry")
}

fn forge(document: &Value, field: &str) -> Value {
    let mut forged = document.clone();
    forged[field] = Value::String(FORGED.to_owned());
    forged
}

#[test]
fn the_seal_rule_matches_every_contract_digest_vector() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(DIGEST_VECTORS);
    let source = fs::read_to_string(path).expect("locked digest vectors must be readable");
    let vectors: Value = serde_json::from_str(&source).expect("digest vectors must be JSON");
    let cases = vectors["cases"].as_array().expect("digest vectors cases");
    assert!(
        !cases.is_empty(),
        "the digest vector file must not be empty"
    );

    let mut checked = 0;
    for case in cases {
        let schema = case["schema"].as_str().expect("vector schema");
        let excluded: Vec<&str> = case["excludedFields"]
            .as_array()
            .expect("excluded fields")
            .iter()
            .map(|field| field.as_str().expect("excluded field name"))
            .collect();
        let document = schema_fixture(schema);
        assert_eq!(
            canonical_digest(&document, &excluded),
            case["expectedDigest"].as_str().expect("expected digest"),
            "seal rule diverges from the contract vector for {schema}"
        );
        checked += 1;
    }
    // Prints the examined volume: a vector file read as empty must not pass.
    println!("digest vectors checked: {checked}");
    assert_eq!(checked, cases.len());
}

#[test]
fn a_graph_with_a_wrong_seal_is_refused_at_the_boundary() {
    let registry = registry();
    let graph = valid_graph_document();
    assert!(parse_authorized_graph(&registry, &graph).is_ok());

    let refusal = parse_authorized_graph(&registry, &forge(&graph, "graphDigest"))
        .expect_err("a forged graph seal must be refused");
    assert_eq!(refusal.code(), SCHEMA_INVALID);
}

#[test]
fn a_plan_with_a_wrong_seal_is_refused_at_the_boundary() {
    let registry = registry();
    let graph = parse_authorized_graph(&registry, &valid_graph_document()).expect("sealed graph");
    let plan = valid_plan_document();
    assert_eq!(
        evaluate_graph_authority(&graph, &plan, &registry).code(),
        "authority-valid"
    );

    assert_eq!(
        evaluate_graph_authority(&graph, &forge(&plan, "bodyDigest"), &registry).code(),
        SCHEMA_INVALID
    );
}

#[test]
fn a_decision_whose_request_changed_after_sealing_is_refused() {
    const NOW: &str = "2026-09-10T11:00:00Z";
    let approver: &[&str] = &["mission-approver"];
    let observation = DecisionObservation::authoritative(false, false, approver, 4, None);
    let request = valid_decision_request();
    let response = valid_decision_response();
    assert_eq!(
        evaluate_human_decision(&registry(), &request, &response, observation, NOW).code(),
        "decision-valid"
    );

    // The same forged digest on both sides: the claimed values agree, but
    // neither is the digest of the request that would be applied.
    let forged_request = forge(&request, "requestDigest");
    let mut bound_response = response.clone();
    bound_response["requestDigest"] = Value::String(FORGED.to_owned());
    reseal_decision_response(&mut bound_response);
    assert_eq!(
        evaluate_human_decision(
            &registry(),
            &forged_request,
            &bound_response,
            observation,
            NOW
        )
        .code(),
        SCHEMA_INVALID
    );

    // Content changed after sealing, seal kept: the expiry is pushed later.
    let mut extended = request.clone();
    extended["expiresAt"] = Value::String("2027-09-10T11:00:00Z".to_owned());
    assert_eq!(
        evaluate_human_decision(&registry(), &extended, &response, observation, NOW).code(),
        SCHEMA_INVALID
    );

    // Resealed, the same change is a different request: the response no
    // longer names it.
    reseal_decision_request(&mut extended);
    assert_eq!(
        evaluate_human_decision(&registry(), &extended, &response, observation, NOW).code(),
        "request-replaced"
    );
}

#[test]
fn a_decision_response_with_a_wrong_seal_is_refused() {
    const NOW: &str = "2026-09-10T11:00:00Z";
    let approver: &[&str] = &["mission-approver"];
    let observation = DecisionObservation::authoritative(false, false, approver, 4, None);
    let request = valid_decision_request();
    let response = valid_decision_response();

    assert_eq!(
        evaluate_human_decision(
            &registry(),
            &request,
            &forge(&response, "responseDigest"),
            observation,
            NOW
        )
        .code(),
        SCHEMA_INVALID
    );
}

#[test]
fn a_transfer_with_a_wrong_seal_is_refused_at_the_boundary() {
    const NOW: &str = "2026-09-10T10:05:00Z";
    let transfer = valid_execution_transfer();
    let observation = TransferObservation::Authoritative {
        organization_id: "ten_1234567890abcdef",
        mission_id: "urn:libre-ai:mission:synthetic-mission-1",
        predecessor_run_id: "urn:libre-ai:run:synthetic-run-1",
        predecessor_plan_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        successor_plan_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        current_generation: 1,
        revision: 4,
        generation_consumed: false,
        prior_transfer: None,
    };
    assert_eq!(
        evaluate_execution_transfer(&registry(), &transfer, observation, NOW).code(),
        "transfer-valid"
    );

    assert_eq!(
        evaluate_execution_transfer(
            &registry(),
            &forge(&transfer, "transferDigest"),
            observation,
            NOW
        )
        .code(),
        SCHEMA_INVALID
    );
}

#[test]
fn an_effect_attestation_with_a_wrong_seal_is_refused_at_the_boundary() {
    let attestation = valid_effect_attestation("committed");
    let observation = EffectObservation::Authoritative {
        expected_organization_id: "ten_1234567890abcdef",
        expected_run_id: "urn:libre-ai:run:synthetic-run-1",
        expected_attempt_id: "urn:libre-ai:attempt:synthetic-attempt-1",
        current_generation: 1,
        active_fencing: Some(7),
        expected_executor_profile_digest: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        generation_consumed: false,
        lineage_closed: false,
        predecessor_effects_terminal: true,
        executor_profile_qualified: true,
        prior_emission: None,
        existing_attempt_emission_id: None,
    };
    assert_eq!(
        evaluate_effect_attestation(&registry(), &attestation, observation).code(),
        "effect-valid"
    );

    assert_eq!(
        evaluate_effect_attestation(
            &registry(),
            &forge(&attestation, "preimageDigest"),
            observation
        )
        .code(),
        SCHEMA_INVALID
    );
}
