# Execution Continuity Evaluator Agent Rules

## Authority

Agent orchestration decisions and their proof surface, couche 2 of the Libre
AI constellation: a pure Rust core that decides, never acts. Doctrine lives
upstream:
https://raw.githubusercontent.com/libre-ai/project-governance/HEAD/AGENTS.md
Contract vectors come from
https://github.com/libre-ai/schemas-and-contracts at a pinned revision.

## Boundaries

- The crate owns no process, file, socket, environment variable, secret,
  persistence, sandbox or provider adapter;
  `verification/agent-orchestrator/check-capabilities.ts` enforces it.
- Execution confinement lives in `libre-ai/execution-sandbox`; contract
  shapes are canonical in `libre-ai/schemas-and-contracts` (verified
  projections only here, never hand-edited).
- Specifications are under Specification Lock (`docs/apps/`); state and
  exit criteria live in `project.v1.yaml`, never restated here.

## Quality gates

Install through the shared local composition (`docs/development.md`), then
run `bun run check` (Bun and Rust gates, capabilities, specifications).
Never hide a red test.

## Agents

- Read actual state before editing.
- Stage files before running tree-walking gates.
- A breaking API change needs a version bump and `docs/compat/BREAKS.md`.
- Security > quality > performance > completeness.
