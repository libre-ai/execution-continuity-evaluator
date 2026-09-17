#!/bin/sh
# SPDX-FileCopyrightText: 2026 Libre AI contributors
# SPDX-License-Identifier: EUPL-1.2
set -eu
# Preserve the reviewed version and Linux archive identity; installation is separate.
CARGO_LLVM_COV_VERSION="0.9.1"
CARGO_LLVM_COV_LINUX_ARCHIVE_SHA256="3fca950394a3c49457657c158b1619cec8dfd2647ae5b48746734c0ab969a522"
export CARGO_LLVM_COV_LINUX_ARCHIVE_SHA256
test "$(cargo llvm-cov --version)" = "cargo-llvm-cov ${CARGO_LLVM_COV_VERSION}"
# Install with rustup component add llvm-tools-preview before invoking this recipe.
mkdir -p coverage
cargo llvm-cov --locked --all-features --lcov \
  --output-path coverage/lcov.info \
  --fail-under-lines 87 \
  --fail-under-functions 90
cargo llvm-cov report --summary-only
