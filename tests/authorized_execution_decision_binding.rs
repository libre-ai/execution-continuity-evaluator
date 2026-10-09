//! `evaluate_bound_human_decision`: a decision request must restate its step's
//! policy in the authorized graph before the decision is evaluated (candidate
//! contract `decision-binding-vectors.v1`, `libre-ai/schemas-and-contracts`).
//! Each case below mirrors one candidate vector, in Rust fixtures.

mod support;

use libre_ai_agent_orchestrator::{
    AuthorizedGraph, DecisionObservation, evaluate_bound_human_decision, evaluate_human_decision,
    parse_authorized_graph,
};
use libre_ai_contract_types::ContractRegistry;
use serde_json::{Value, json};
use support::authorized_execution::{
    reseal_decision_request, reseal_decision_response, reseal_graph, schema_fixture,
    valid_graph_document,
};

const NOW: &str = "2026-09-10T11:00:00Z";
const DECISION_STEP: &str = "urn:libre-ai:step:decision-1";
const APPROVER: &[&str] = &["mission-approver"];

/// A named change applied to a bound request.
type Edit = Box<dyn FnOnce(&mut Value)>;

fn registry() -> ContractRegistry {
    ContractRegistry::embedded().expect("embedded registry")
}

fn observation() -> DecisionObservation<'static> {
    DecisionObservation::authoritative(false, false, APPROVER, 4, None)
}

fn graph(document: &Value) -> AuthorizedGraph {
    parse_authorized_graph(&registry(), document).expect("sealed graph")
}

/// A request bound to `graph`: its step, digest and organization, resealed.
fn request_for(graph: &Value) -> Value {
    let mut request = schema_fixture("human-decision-request.v1.schema.json");
    request["stepId"] = json!(DECISION_STEP);
    request["graphDigest"] = graph["graphDigest"].clone();
    request["organizationId"] = graph["organizationId"].clone();
    reseal_decision_request(&mut request);
    request
}

/// The response to `request`, resealed.
fn response_to(request: &Value) -> Value {
    let mut response = schema_fixture("human-decision-response.v1.schema.json");
    response["stepId"] = request["stepId"].clone();
    response["organizationId"] = request["organizationId"].clone();
    response["requestDigest"] = request["requestDigest"].clone();
    reseal_decision_response(&mut response);
    response
}

fn bound_code(graph_document: &Value, request: &Value, now: &str) -> &'static str {
    evaluate_bound_human_decision(
        &registry(),
        &graph(graph_document),
        request,
        &response_to(request),
        observation(),
        now,
    )
    .code()
}

/// `request_for`, changed by `edit`, then resealed.
fn edited(graph_document: &Value, edit: impl FnOnce(&mut Value)) -> Value {
    let mut request = request_for(graph_document);
    edit(&mut request);
    reseal_decision_request(&mut request);
    request
}

#[test]
fn a_request_that_restates_its_step_policy_is_evaluated() {
    let graph_document = valid_graph_document();
    let request = request_for(&graph_document);
    assert_eq!(bound_code(&graph_document, &request, NOW), "decision-valid");
    let reversed = edited(&graph_document, |request| {
        request["choices"]
            .as_array_mut()
            .expect("choices")
            .reverse();
    });
    assert_eq!(
        bound_code(&graph_document, &reversed, NOW),
        "decision-valid",
        "choice order is irrelevant"
    );
}

#[test]
fn inverted_outcomes_pass_the_locked_evaluation_and_are_refused_bound() {
    let graph_document = valid_graph_document();
    let swapped = edited(&graph_document, |request| {
        request["choices"][0]["consequenceCode"] = json!("rejected");
        request["choices"][1]["consequenceCode"] = json!("approved");
    });
    // The defect: judged against its response only, the request applies.
    assert_eq!(
        evaluate_human_decision(
            &registry(),
            &swapped,
            &response_to(&swapped),
            observation(),
            NOW
        )
        .code(),
        "decision-valid"
    );
    assert_eq!(
        bound_code(&graph_document, &swapped, NOW),
        "decision-policy-mismatch"
    );
}

#[test]
fn every_policy_departure_is_a_policy_mismatch() {
    let graph_document = valid_graph_document();
    let cases: [(&str, Edit); 5] = [
        (
            "lowered role",
            Box::new(|request| request["requiredRole"] = json!("mission-viewer")),
        ),
        (
            "raised role",
            Box::new(|request| request["requiredRole"] = json!("mission-owner")),
        ),
        (
            "other no-response outcome",
            Box::new(|request| request["noResponseOutcomeCode"] = json!("approved")),
        ),
        (
            "extra choice",
            Box::new(|request| {
                request["choices"].as_array_mut().expect("choices").push(
                    json!({ "choiceId": "defer", "label": "Defer", "consequenceCode": "approved" }),
                );
            }),
        ),
        (
            "substituted choice",
            Box::new(|request| request["choices"][1]["choiceId"] = json!("approve-later")),
        ),
    ];
    for (name, edit) in cases {
        let request = edited(&graph_document, edit);
        assert_eq!(
            bound_code(&graph_document, &request, NOW),
            "decision-policy-mismatch",
            "{name}"
        );
    }

    // A pure removal: a three-choice policy against the two-choice request.
    let mut wider = valid_graph_document();
    wider["steps"][1]["decisionPolicy"]["choices"]
        .as_array_mut()
        .expect("policy choices")
        .push(json!({ "choiceId": "defer", "outcomeCode": "no-response" }));
    reseal_graph(&mut wider);
    assert_eq!(
        bound_code(&wider, &request_for(&wider), NOW),
        "decision-policy-mismatch"
    );
}

#[test]
fn graph_identity_and_step_kind_come_first() {
    let graph_document = valid_graph_document();
    let cases: [(&str, Edit, &str); 5] = [
        (
            "other graph",
            Box::new(|request| request["graphDigest"] = json!("c".repeat(64))),
            "graph-binding-mismatch",
        ),
        (
            "other organization",
            Box::new(|request| request["organizationId"] = json!("ten_abcdef1234567890")),
            "graph-binding-mismatch",
        ),
        (
            "unknown step",
            Box::new(|request| request["stepId"] = json!("urn:libre-ai:step:missing")),
            "step-not-decision",
        ),
        (
            "calculation step",
            Box::new(|request| request["stepId"] = json!("urn:libre-ai:step:calculate-1")),
            "step-not-decision",
        ),
        (
            "graph precedes policy",
            Box::new(|request| {
                request["graphDigest"] = json!("c".repeat(64));
                request["choices"][0]["consequenceCode"] = json!("rejected");
            }),
            "graph-binding-mismatch",
        ),
    ];
    for (name, edit, expected) in cases {
        let mut request = edited(&graph_document, edit);
        // The response follows the request, so only the binding can refuse.
        reseal_decision_request(&mut request);
        assert_eq!(
            bound_code(&graph_document, &request, NOW),
            expected,
            "{name}"
        );
    }
}

#[test]
fn the_binding_is_checked_before_the_response() {
    let graph_document = valid_graph_document();
    let swapped = edited(&graph_document, |request| {
        request["choices"][0]["consequenceCode"] = json!("rejected");
        request["choices"][1]["consequenceCode"] = json!("approved");
    });
    // An expired request that is also unbound is refused for the binding.
    assert_eq!(
        bound_code(&graph_document, &swapped, "2026-09-10T13:00:00Z"),
        "decision-policy-mismatch"
    );
    let bound = request_for(&graph_document);
    assert_eq!(
        bound_code(&graph_document, &bound, "2026-09-10T13:00:00Z"),
        "request-expired"
    );
}

#[test]
fn ambiguous_steps_and_repeated_choices_are_refused_at_the_boundary() {
    const BOUNDARY: &str = "orchestrator.authorized-execution.schema-invalid";
    for weak_first in [true, false] {
        let mut graph_document = valid_graph_document();
        let strong = graph_document["steps"][1].clone();
        let mut weak = strong.clone();
        weak["decisionPolicy"]["requiredRole"] = json!("mission-viewer");
        let steps = graph_document["steps"].as_array_mut().expect("steps");
        steps.insert(if weak_first { 1 } else { 2 }, weak);
        reseal_graph(&mut graph_document);
        let request = request_for(&graph_document);
        assert_eq!(
            bound_code(&graph_document, &request, NOW),
            BOUNDARY,
            "weak_first = {weak_first}"
        );
    }

    let graph_document = valid_graph_document();
    let repeated = edited(&graph_document, |request| {
        request["choices"][1]["choiceId"] = json!("approve");
    });
    assert_eq!(bound_code(&graph_document, &repeated, NOW), BOUNDARY);

    // The request is still schema-checked and sealed first.
    let mut forged = request_for(&graph_document);
    forged["requiredRole"] = json!("mission-viewer");
    assert_eq!(bound_code(&graph_document, &forged, NOW), BOUNDARY);
}
