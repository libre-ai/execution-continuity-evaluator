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

<!-- libre-ai:project-status:begin -->
<!-- Section générée depuis project.v1.yaml — ne pas éditer à la main. -->

- Situation actuelle : Le noyau natif authorized-execution 0.2.0 de WP-G3-O02 est prouvé sur un commit immuable. Le run boundary, les effets réels et le déploiement restent bloqués et WP-G3-O01 n'est pas revendiqué.
- Maturité : usable
- Exposition : spec-published
- Confiance : medium
- Preuves vérifiées le : 2026-09-10
- Avancement : 100 % du périmètre actuellement déclaré

<!-- libre-ai:project-status:end -->

Source code and tests are available in this repository; no package is published to a registry.

Explore the [Libre AI project catalogue](https://github.com/libre-ai/.github/blob/main/profile/README.md).
