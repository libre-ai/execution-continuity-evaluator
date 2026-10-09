use std::fmt::{self, Debug, Display, Formatter};

use chrono::DateTime;
use libre_ai_contract_types::ContractRegistry;
use serde::Deserialize;
use serde_json::Value;

use super::AuthorizedExecutionRefusal;
use super::document::{AuthorizedGraph, StepKind, require_seal, require_valid};

const DECISION_REQUEST_SCHEMA: &str = "human-decision-request.v1.schema.json";
const DECISION_RESPONSE_SCHEMA: &str = "human-decision-response.v1.schema.json";

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum DecisionObservation<'a> {
    Unavailable,
    Authoritative {
        request_replaced: bool,
        request_consumed: bool,
        actor_roles: &'a [&'a str],
        revision: u64,
        prior_response: Option<(&'a str, &'a str)>,
    },
}

impl<'a> DecisionObservation<'a> {
    pub const fn unavailable() -> Self {
        Self::Unavailable
    }

    pub const fn authoritative(
        request_replaced: bool,
        request_consumed: bool,
        actor_roles: &'a [&'a str],
        revision: u64,
        prior_response: Option<(&'a str, &'a str)>,
    ) -> Self {
        Self::Authoritative {
            request_replaced,
            request_consumed,
            actor_roles,
            revision,
            prior_response,
        }
    }
}

impl Debug for DecisionObservation<'_> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "DecisionObservation::Unavailable",
            Self::Authoritative { .. } => "DecisionObservation::Authoritative(<redacted>)",
        })
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct DecisionApplication {
    request_digest: String,
    outcome_code: String,
    expected_revision: u64,
}

impl DecisionApplication {
    pub fn request_digest(&self) -> &str {
        &self.request_digest
    }

    pub fn outcome_code(&self) -> &str {
        &self.outcome_code
    }

    pub const fn expected_revision(&self) -> u64 {
        self.expected_revision
    }
}

impl Debug for DecisionApplication {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DecisionApplication")
            .field("code", &"decision-valid")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecisionRefusal {
    OrganizationMismatch,
    AttemptMismatch,
    RequestReplaced,
    DuplicateDivergent,
    RequestExpired,
    RequestConsumed,
    ChoiceUnknown,
    ActorUnauthorized,
    RevisionStale,
    GraphBindingMismatch,
    StepNotDecision,
    DecisionPolicyMismatch,
}

impl DecisionRefusal {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::OrganizationMismatch => "organization-mismatch",
            Self::AttemptMismatch => "attempt-mismatch",
            Self::RequestReplaced => "request-replaced",
            Self::DuplicateDivergent => "duplicate-divergent",
            Self::RequestExpired => "request-expired",
            Self::RequestConsumed => "request-consumed",
            Self::ChoiceUnknown => "choice-unknown",
            Self::ActorUnauthorized => "actor-unauthorized",
            Self::RevisionStale => "revision-stale",
            Self::GraphBindingMismatch => "graph-binding-mismatch",
            Self::StepNotDecision => "step-not-decision",
            Self::DecisionPolicyMismatch => "decision-policy-mismatch",
        }
    }
}

impl Display for DecisionRefusal {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DecisionDecision {
    Apply(DecisionApplication),
    Idempotent,
    Refused(DecisionRefusal),
    BoundaryRefused(AuthorizedExecutionRefusal),
}

impl DecisionDecision {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Apply(_) => "decision-valid",
            Self::Idempotent => "idempotent-duplicate",
            Self::Refused(refusal) => refusal.code(),
            Self::BoundaryRefused(refusal) => refusal.code(),
        }
    }

    pub const fn application(&self) -> Option<&DecisionApplication> {
        match self {
            Self::Apply(application) => Some(application),
            Self::Idempotent | Self::Refused(_) | Self::BoundaryRefused(_) => None,
        }
    }
}

impl Display for DecisionDecision {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDecisionRequest {
    id: String,
    organization_id: String,
    mission_id: String,
    run_id: String,
    step_id: String,
    attempt_id: String,
    graph_digest: String,
    choices: Vec<WireDecisionChoice>,
    required_role: String,
    no_response_outcome_code: String,
    expected_revision: u64,
    expires_at: String,
    request_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDecisionChoice {
    choice_id: String,
    consequence_code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDecisionResponse {
    id: String,
    organization_id: String,
    mission_id: String,
    run_id: String,
    step_id: String,
    attempt_id: String,
    request_id: String,
    request_digest: String,
    choice_id: String,
    actor_authorization: WireActorAuthorization,
    expected_revision: u64,
    response_digest: String,
}

#[derive(Deserialize)]
struct WireActorAuthorization {
    role: String,
}

/// Evaluates a human decision whose request must first be bound to its step's
/// policy in `graph` (candidate contract `decision-binding-vectors.v1`,
/// `docs/reviews/decision-binding-v1-review.md` in `schemas-and-contracts`).
///
/// The locked `evaluate_human_decision` judges a response against its request
/// only, so a request could invert the outcomes of its choices or lower the
/// approver's role and still apply. Here the request must name `graph` by
/// digest and organization, name a human-decision step of it, and restate that
/// step's policy exactly — choice to outcome map, no-response outcome, required
/// role — before the decision is evaluated at all.
///
/// `graph` must be the authorized one, parsed by [`super::parse_authorized_graph`]
/// (which recomputes its seal). A step identifier carried by two steps is a
/// boundary refusal, never resolved by array order.
pub fn evaluate_bound_human_decision(
    registry: &ContractRegistry,
    graph: &AuthorizedGraph,
    request_document: &Value,
    response_document: &Value,
    observation: DecisionObservation<'_>,
    evaluation_time: &str,
) -> DecisionDecision {
    if require_valid(registry, DECISION_REQUEST_SCHEMA, request_document).is_err()
        || require_seal(request_document, "requestDigest", &["requestDigest"]).is_err()
    {
        return boundary(AuthorizedExecutionRefusal::SchemaInvalid);
    }
    let request: WireDecisionRequest = match serde_json::from_value(request_document.clone()) {
        Ok(request) => request,
        Err(_) => return boundary(AuthorizedExecutionRefusal::SchemaInvalid),
    };
    match bind_request(graph, &request) {
        Ok(()) => evaluate_human_decision(
            registry,
            request_document,
            response_document,
            observation,
            evaluation_time,
        ),
        Err(decision) => decision,
    }
}

fn bind_request(
    graph: &AuthorizedGraph,
    request: &WireDecisionRequest,
) -> Result<(), DecisionDecision> {
    if request.graph_digest != graph.graph_digest
        || request.organization_id != graph.organization_id
    {
        return Err(refused(DecisionRefusal::GraphBindingMismatch));
    }
    let mut named = graph
        .steps
        .iter()
        .filter(|step| step.step_id == request.step_id);
    let step = named.next();
    if named.next().is_some() {
        return Err(boundary(AuthorizedExecutionRefusal::SchemaInvalid));
    }
    let Some(policy) = step
        .filter(|step| step.kind == StepKind::HumanDecision)
        .and_then(|step| step.decision_policy.as_ref())
    else {
        return Err(refused(DecisionRefusal::StepNotDecision));
    };
    // `uniqueItems` compares whole choice objects, not identifiers: a repeated
    // `choiceId` passes the schema, so it is refused here, on both sides. With
    // unique identifiers, equal lengths plus every request choice found with
    // the same outcome is an exact map equality.
    let repeats = |ids: Vec<&str>| {
        let mut seen = std::collections::BTreeSet::new();
        ids.into_iter().any(|id| !seen.insert(id))
    };
    if repeats(
        request
            .choices
            .iter()
            .map(|c| c.choice_id.as_str())
            .collect(),
    ) || repeats(
        policy
            .choices
            .iter()
            .map(|c| c.choice_id.as_str())
            .collect(),
    ) {
        return Err(boundary(AuthorizedExecutionRefusal::SchemaInvalid));
    }
    let same_choices = request.choices.len() == policy.choices.len()
        && request.choices.iter().all(|offered| {
            policy.choices.iter().any(|allowed| {
                allowed.choice_id == offered.choice_id
                    && allowed.outcome_code == offered.consequence_code
            })
        });
    if !same_choices
        || request.no_response_outcome_code != policy.no_response_outcome_code
        || request.required_role != policy.required_role
    {
        return Err(refused(DecisionRefusal::DecisionPolicyMismatch));
    }
    Ok(())
}

pub fn evaluate_human_decision(
    registry: &ContractRegistry,
    request_document: &Value,
    response_document: &Value,
    observation: DecisionObservation<'_>,
    evaluation_time: &str,
) -> DecisionDecision {
    if require_valid(registry, DECISION_REQUEST_SCHEMA, request_document).is_err()
        || require_valid(registry, DECISION_RESPONSE_SCHEMA, response_document).is_err()
        || require_seal(request_document, "requestDigest", &["requestDigest"]).is_err()
        || require_seal(response_document, "responseDigest", &["responseDigest"]).is_err()
    {
        return boundary(AuthorizedExecutionRefusal::SchemaInvalid);
    }
    let request: WireDecisionRequest = match serde_json::from_value(request_document.clone()) {
        Ok(request) => request,
        Err(_) => return boundary(AuthorizedExecutionRefusal::SchemaInvalid),
    };
    let response: WireDecisionResponse = match serde_json::from_value(response_document.clone()) {
        Ok(response) => response,
        Err(_) => return boundary(AuthorizedExecutionRefusal::SchemaInvalid),
    };
    let now = match DateTime::parse_from_rfc3339(evaluation_time) {
        Ok(now) => now,
        Err(_) => return boundary(AuthorizedExecutionRefusal::SchemaInvalid),
    };
    let expires_at = match DateTime::parse_from_rfc3339(&request.expires_at) {
        Ok(expires_at) => expires_at,
        Err(_) => return boundary(AuthorizedExecutionRefusal::SchemaInvalid),
    };
    let DecisionObservation::Authoritative {
        request_replaced,
        request_consumed,
        actor_roles,
        revision,
        prior_response,
    } = observation
    else {
        return boundary(AuthorizedExecutionRefusal::StoreUnavailable);
    };

    if request.organization_id != response.organization_id {
        return refused(DecisionRefusal::OrganizationMismatch);
    }
    if request.mission_id != response.mission_id
        || request.run_id != response.run_id
        || request.step_id != response.step_id
        || request.attempt_id != response.attempt_id
    {
        return refused(DecisionRefusal::AttemptMismatch);
    }
    if request_replaced
        || request.id != response.request_id
        || request.request_digest != response.request_digest
    {
        return refused(DecisionRefusal::RequestReplaced);
    }
    if let Some((prior_id, prior_digest)) = prior_response {
        if prior_id == response.id && prior_digest == response.response_digest {
            return DecisionDecision::Idempotent;
        }
        return refused(DecisionRefusal::DuplicateDivergent);
    }
    if now >= expires_at {
        return refused(DecisionRefusal::RequestExpired);
    }
    if request_consumed {
        return refused(DecisionRefusal::RequestConsumed);
    }
    let Some(choice) = request
        .choices
        .iter()
        .find(|choice| choice.choice_id == response.choice_id)
    else {
        return refused(DecisionRefusal::ChoiceUnknown);
    };
    if response.actor_authorization.role != request.required_role
        || !actor_roles.contains(&request.required_role.as_str())
    {
        return refused(DecisionRefusal::ActorUnauthorized);
    }
    if request.expected_revision != revision || response.expected_revision != revision {
        return refused(DecisionRefusal::RevisionStale);
    }

    DecisionDecision::Apply(DecisionApplication {
        request_digest: request.request_digest,
        outcome_code: choice.consequence_code.clone(),
        expected_revision: revision,
    })
}

const fn refused(refusal: DecisionRefusal) -> DecisionDecision {
    DecisionDecision::Refused(refusal)
}

const fn boundary(refusal: AuthorizedExecutionRefusal) -> DecisionDecision {
    DecisionDecision::BoundaryRefused(refusal)
}
