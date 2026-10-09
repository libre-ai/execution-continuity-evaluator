//! Pure re-verification of `tool-invocation-observation.v1` streams
//! (`libre-ai/project-governance` ADR-0046, accepted 2026-10-09).
//!
//! The harness sees every tool call of a worker invocation, aggregates them
//! into overlapping windows of keyed digests and signs one document per
//! window. This module replays such a stream and renders exactly one closed
//! verdict, the first that applies in the order fixed by ADR-0046 decision 4:
//! `attestation-invalid`, `observation-replayed`, `observation-chain-broken`,
//! `observation-incomplete`, `tool-undeclared`, `no-progress`, `progress`.
//!
//! What it does not do, by construction:
//!
//! - **It blocks nothing.** The verdict is `operational` data (K2 of the loop
//!   security kernel: operational data is never authority). The harness holds
//!   the typed stop on its own sliding window (ADR-0046 decision 2, owner
//!   decision Q5); a disagreement between the harness reaction and this
//!   verdict is itself a finding for the caller (decision 4). Whatever a
//!   verdict triggers is declared by the authorized graph, never here (OBS-d).
//! - **It holds no key.** Argument and result digests are only compared,
//!   never computed: no HMAC key reaches this module (OBS-b). The harness
//!   Ed25519 signature is checked through a caller-supplied
//!   [`HarnessSignatureVerifier`], because the crate's capability boundary
//!   admits no signature dependency
//!   (`verification/agent-orchestrator/check-capabilities.ts`,
//!   `ALLOWED_DEPENDENCIES`), exactly as `effect-attestation.v1` is evaluated
//!   on its seal here without an Ed25519 verification of its own.
//! - **It corrects nothing.** A covered call count that differs from the
//!   `toolCalls` counter the orchestrator received is `observation-incomplete`
//!   (OBS-e), never an adjustment of either value.
//!
//! A document that fails the canonical schema is refused before evaluation
//! ([`ToolObservationRefusal::SchemaInvalid`]): the seven verdicts judge
//! well-formed streams only, so a structural red is never read as a semantic
//! one.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{self, Debug, Display, Formatter};

use libre_ai_contract_types::ContractRegistry;
use serde::Deserialize;
use serde_json::Value;

use crate::authorized_execution::{canonical_preimage, sha256_hex};

const TOOL_OBSERVATION_SCHEMA: &str = "tool-invocation-observation.v1.schema.json";
/// Fields outside the signed preimage (`SEMANTICS.md`, "Attestation").
const UNSIGNED_FIELDS: [&str; 2] = ["preimageDigest", "signature"];

/// Verifies one harness Ed25519 signature on behalf of the evaluator.
///
/// The caller binds `signing_key_id` to the public key that the run's harness
/// attestation names (the attestation whose digest every document carries as
/// `harnessAttestationDigest`). An unknown key id must return `false`.
pub trait HarnessSignatureVerifier {
    /// `true` only when `signature` (unpadded base64url, 64 bytes) is a valid
    /// Ed25519 signature by `signing_key_id` over `preimage`, the RFC 8785
    /// bytes of the document without `preimageDigest` and `signature`.
    fn verify(&self, signing_key_id: &str, preimage: &[u8], signature: &str) -> bool;
}

/// The closed verdict set of ADR-0046 decision 4, in priority order.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum ToolObservationVerdict {
    AttestationInvalid,
    ObservationReplayed,
    ObservationChainBroken,
    ObservationIncomplete,
    ToolUndeclared,
    NoProgress,
    Progress,
}

impl ToolObservationVerdict {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::AttestationInvalid => "attestation-invalid",
            Self::ObservationReplayed => "observation-replayed",
            Self::ObservationChainBroken => "observation-chain-broken",
            Self::ObservationIncomplete => "observation-incomplete",
            Self::ToolUndeclared => "tool-undeclared",
            Self::NoProgress => "no-progress",
            Self::Progress => "progress",
        }
    }
}

impl Display for ToolObservationVerdict {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

/// What the evaluator examined, printed with every verdict so that a
/// `progress` over zero documents is distinguishable from a real one.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ToolObservationCounters {
    /// Documents parsed from the stream.
    pub documents_read: u64,
    /// Entries summed over every document.
    pub entries_read: u64,
    /// Distinct call sequence numbers covered by the union of window spans.
    pub calls_covered: u64,
    /// Highest occurrence count of one couple inside one window.
    pub maximum_repetition: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolObservationEvaluation {
    verdict: ToolObservationVerdict,
    counters: ToolObservationCounters,
}

impl ToolObservationEvaluation {
    #[must_use]
    pub const fn verdict(&self) -> ToolObservationVerdict {
        self.verdict
    }

    #[must_use]
    pub const fn counters(&self) -> ToolObservationCounters {
        self.counters
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolObservationRefusal {
    /// A document is not a schema-valid `tool-invocation-observation.v1`.
    SchemaInvalid,
}

impl ToolObservationRefusal {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::SchemaInvalid => "orchestrator.tool-observation.schema-invalid",
        }
    }
}

impl Display for ToolObservationRefusal {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolObservationDecision {
    Evaluated(ToolObservationEvaluation),
    Refused(ToolObservationRefusal),
}

impl ToolObservationDecision {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Evaluated(evaluation) => evaluation.verdict.code(),
            Self::Refused(refusal) => refusal.code(),
        }
    }

    #[must_use]
    pub const fn evaluation(&self) -> Option<&ToolObservationEvaluation> {
        match self {
            Self::Evaluated(evaluation) => Some(evaluation),
            Self::Refused(_) => None,
        }
    }
}

impl Display for ToolObservationDecision {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

/// The caller-held facts one stream is judged against.
#[derive(Clone, Copy)]
pub struct ToolObservationInput<'a> {
    /// The documents of one worker invocation, in the order received.
    pub documents: &'a [Value],
    /// The plan's `tools[].name`.
    pub plan_tool_names: &'a [String],
    /// The `toolCalls` counter the orchestrator received for the invocation:
    /// the second instrument of OBS-e.
    pub observed_tool_calls: u64,
}

impl Debug for ToolObservationInput<'_> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolObservationInput")
            .field("document_count", &self.documents.len())
            .field("plan_tool_count", &self.plan_tool_names.len())
            .field("observed_tool_calls", &self.observed_tool_calls)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireObservation {
    organization_id: String,
    mission_id: String,
    plan_digest: String,
    graph_digest: String,
    run_id: String,
    generation: u64,
    step_id: String,
    attempt_id: String,
    worker_invocation_id: String,
    harness_attestation_digest: String,
    digest_key: WireDigestKey,
    window: WireWindow,
    previous_observation_digest: Option<String>,
    entries: Vec<WireEntry>,
    signing_key_id: String,
    preimage_digest: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDigestKey {
    key_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWindow {
    sequence: u64,
    window_size: u64,
    repeat_threshold: u64,
    first_call_sequence: u64,
    last_call_sequence: u64,
    #[serde(rename = "final")]
    is_final: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireEntry {
    tool_name: String,
    args_digest: String,
    result_digest: String,
    outcome: String,
    count: u64,
    first_call_sequence: u64,
    last_call_sequence: u64,
}

/// The binding every document of one invocation shares. Every field is fixed
/// for a run or narrower: ADR-0046 threat 5 names organization, run, plan,
/// graph, step, attempt and invocation; mission, generation, harness
/// attestation and digest key are run-scoped by the same contract, and a
/// digest under another run key is not comparable at all.
#[derive(Eq, PartialEq)]
struct Binding<'a> {
    organization_id: &'a str,
    mission_id: &'a str,
    plan_digest: &'a str,
    graph_digest: &'a str,
    run_id: &'a str,
    generation: u64,
    step_id: &'a str,
    attempt_id: &'a str,
    worker_invocation_id: &'a str,
    harness_attestation_digest: &'a str,
    digest_key_id: &'a str,
}

impl WireObservation {
    fn binding(&self) -> Binding<'_> {
        Binding {
            organization_id: &self.organization_id,
            mission_id: &self.mission_id,
            plan_digest: &self.plan_digest,
            graph_digest: &self.graph_digest,
            run_id: &self.run_id,
            generation: self.generation,
            step_id: &self.step_id,
            attempt_id: &self.attempt_id,
            worker_invocation_id: &self.worker_invocation_id,
            harness_attestation_digest: &self.harness_attestation_digest,
            digest_key_id: &self.digest_key.key_id,
        }
    }

    /// Occurrences per distinct couple inside this window. The contract lists
    /// each couple once; summing a couple listed twice keeps a split listing
    /// from hiding a repetition.
    fn couple_counts(&self) -> BTreeMap<(&str, &str, &str, &str), u64> {
        let mut counts = BTreeMap::new();
        for entry in &self.entries {
            let key = (
                entry.tool_name.as_str(),
                entry.args_digest.as_str(),
                entry.result_digest.as_str(),
                entry.outcome.as_str(),
            );
            let count = counts.entry(key).or_insert(0_u64);
            *count = count.saturating_add(entry.count);
        }
        counts
    }
}

/// Replays one invocation's observation stream and renders its verdict.
///
/// Pure: no state is owned, nothing is written, and the same input always
/// yields the same decision.
#[must_use]
pub fn evaluate_tool_observations(
    registry: &ContractRegistry,
    input: ToolObservationInput<'_>,
    verifier: &dyn HarnessSignatureVerifier,
) -> ToolObservationDecision {
    let mut stream = Vec::with_capacity(input.documents.len());
    for document in input.documents {
        if !matches!(
            registry.is_valid(TOOL_OBSERVATION_SCHEMA, document),
            Ok(true)
        ) {
            return ToolObservationDecision::Refused(ToolObservationRefusal::SchemaInvalid);
        }
        match serde_json::from_value::<WireObservation>(document.clone()) {
            Ok(observation) => stream.push(observation),
            Err(_) => {
                return ToolObservationDecision::Refused(ToolObservationRefusal::SchemaInvalid);
            }
        }
    }

    let counters = count(&stream);
    let verdict = if !attestations_hold(input.documents, &stream, verifier) {
        ToolObservationVerdict::AttestationInvalid
    } else if is_replayed(&stream) {
        ToolObservationVerdict::ObservationReplayed
    } else if is_chain_broken(&stream) {
        ToolObservationVerdict::ObservationChainBroken
    } else if is_incomplete(&stream, input.observed_tool_calls) {
        ToolObservationVerdict::ObservationIncomplete
    } else if has_undeclared_tool(&stream, input.plan_tool_names) {
        ToolObservationVerdict::ToolUndeclared
    } else if has_no_progress(&stream) {
        ToolObservationVerdict::NoProgress
    } else {
        ToolObservationVerdict::Progress
    };
    ToolObservationDecision::Evaluated(ToolObservationEvaluation { verdict, counters })
}

fn count(stream: &[WireObservation]) -> ToolObservationCounters {
    let mut spans: Vec<(u64, u64)> = stream
        .iter()
        .map(|observation| {
            (
                observation.window.first_call_sequence,
                observation.window.last_call_sequence,
            )
        })
        .filter(|(first, last)| first <= last)
        .collect();
    spans.sort_unstable();
    let mut calls_covered = 0_u64;
    let mut covered_until = 0_u64;
    for (first, last) in spans {
        let start = first.max(covered_until.saturating_add(1));
        if last >= start {
            calls_covered = calls_covered.saturating_add(last - start + 1);
            covered_until = last;
        }
    }
    ToolObservationCounters {
        documents_read: u64::try_from(stream.len()).unwrap_or(u64::MAX),
        entries_read: stream
            .iter()
            .map(|observation| u64::try_from(observation.entries.len()).unwrap_or(u64::MAX))
            .fold(0_u64, u64::saturating_add),
        calls_covered,
        maximum_repetition: stream
            .iter()
            .flat_map(|observation| observation.couple_counts().into_values())
            .max()
            .unwrap_or(0),
    }
}

/// OBS-c: the seal is recomputed from the content, and the harness signature
/// must verify over that same preimage.
fn attestations_hold(
    documents: &[Value],
    stream: &[WireObservation],
    verifier: &dyn HarnessSignatureVerifier,
) -> bool {
    documents.iter().zip(stream).all(|(document, observation)| {
        let Ok(preimage) = canonical_preimage(document, &UNSIGNED_FIELDS) else {
            return false;
        };
        let Ok(digest) = sha256_hex(&preimage) else {
            return false;
        };
        digest == observation.preimage_digest
            && verifier.verify(
                &observation.signing_key_id,
                &preimage,
                &observation.signature,
            )
    })
}

fn is_replayed(stream: &[WireObservation]) -> bool {
    let Some(head) = stream.first() else {
        return false;
    };
    let binding = head.binding();
    let mut sequences = BTreeSet::new();
    stream.iter().any(|observation| {
        observation.binding() != binding || !sequences.insert(observation.window.sequence)
    })
}

fn is_chain_broken(stream: &[WireObservation]) -> bool {
    let last_index = stream.len().saturating_sub(1);
    let mut previous: Option<&WireObservation> = None;
    for (index, observation) in stream.iter().enumerate() {
        let expected_sequence = u64::try_from(index).map_or(u64::MAX, |i| i.saturating_add(1));
        if observation.window.sequence != expected_sequence {
            return true;
        }
        let expected_previous = previous.map(|prior| prior.preimage_digest.as_str());
        if observation.previous_observation_digest.as_deref() != expected_previous {
            return true;
        }
        if observation.window.is_final && index != last_index {
            return true;
        }
        previous = Some(observation);
    }
    false
}

/// OBS-e and the window rules of `SEMANTICS.md` ("Evaluation").
fn is_incomplete(stream: &[WireObservation], observed_tool_calls: u64) -> bool {
    let (Some(head), Some(tail)) = (stream.first(), stream.last()) else {
        // No document at all: there is no `final` window.
        return true;
    };
    let window_size = head.window.window_size;
    let repeat_threshold = head.window.repeat_threshold;
    if head.window.first_call_sequence != 1 || !tail.window.is_final {
        return true;
    }
    if tail.window.last_call_sequence != observed_tool_calls {
        return true;
    }
    let mut previous_last: Option<u64> = None;
    for observation in stream {
        let window = &observation.window;
        if window.window_size != window_size
            || window.repeat_threshold != repeat_threshold
            || window.repeat_threshold > window.window_size
            || window.last_call_sequence < window.first_call_sequence
        {
            return true;
        }
        let span = window.last_call_sequence - window.first_call_sequence + 1;
        if span > window.window_size || (!window.is_final && span != window.window_size) {
            return true;
        }
        if let Some(last) = previous_last {
            // The k - 1 overlap of ADR-0046 decision 1:
            // firstCallSequence(n + 1) = lastCallSequence(n) - (k - 2).
            let expected_first = repeat_threshold
                .checked_sub(2)
                .and_then(|shift| last.checked_sub(shift));
            if expected_first != Some(window.first_call_sequence) {
                return true;
            }
        }
        if !entries_cover_span(observation, span) {
            return true;
        }
        previous_last = Some(window.last_call_sequence);
    }
    false
}

fn entries_cover_span(observation: &WireObservation, span: u64) -> bool {
    let window = &observation.window;
    let mut counted = 0_u64;
    for entry in &observation.entries {
        if entry.count == 0
            || entry.first_call_sequence > entry.last_call_sequence
            || entry.first_call_sequence < window.first_call_sequence
            || entry.last_call_sequence > window.last_call_sequence
            || entry.count > entry.last_call_sequence - entry.first_call_sequence + 1
        {
            return false;
        }
        counted = counted.saturating_add(entry.count);
    }
    counted == span
}

fn has_undeclared_tool(stream: &[WireObservation], plan_tool_names: &[String]) -> bool {
    let declared: BTreeSet<&str> = plan_tool_names.iter().map(String::as_str).collect();
    stream
        .iter()
        .flat_map(|observation| &observation.entries)
        .any(|entry| !declared.contains(entry.tool_name.as_str()))
}

fn has_no_progress(stream: &[WireObservation]) -> bool {
    stream.iter().any(|observation| {
        observation
            .couple_counts()
            .into_values()
            .any(|count| count >= observation.window.repeat_threshold)
    })
}
