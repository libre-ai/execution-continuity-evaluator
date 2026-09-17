<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Written for the retained Libre AI portfolio on 2026-09-14; earlier source documents and revisions retain their original licensing. -->

# Libre AI Execution Continuity Evaluator

[Français](README.fr.md)

After an interruption, automated workflows need to distinguish what was attempted from what actually happened. This project explores an evaluator for developers building resumable workflows. It relates recorded work state to available observations, making it easier to identify the next justified transition or a decision that remains unresolved.

## Intended uses

- Assess whether an interrupted task can continue from its recorded state.
- Identify missing or conflicting observations about the outcome of an operation.
- Examine repeated input before deciding whether work should be attempted again.

## Availability

Source code and tests are available in this repository; no package is published to a registry.

Explore the [Libre AI project catalogue](https://github.com/libre-ai/.github/blob/main/profile/README.md).
