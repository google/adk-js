#!/usr/bin/env bash
#
# Provisions the Python half of the parity harness: an adk-python checkout and
# a virtualenv with it installed. Idempotent — safe to re-run.
#
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Pin so a parity result is reproducible. Bump deliberately, and re-record the
# report when you do: an unpinned checkout silently changes what "Python does"
# means between runs.
ADK_PYTHON_REF="${ADK_PYTHON_REF:-1d89e0ff8dd00ce499e194089903ca183495ed44}"
PYTHON_BIN="${PYTHON_BIN:-python3.12}"

if [[ ! -d adk-python ]]; then
  echo "==> Cloning adk-python"
  git clone https://github.com/google/adk-python.git adk-python
fi

echo "==> Checking out $ADK_PYTHON_REF"
git -C adk-python fetch --quiet origin "$ADK_PYTHON_REF" 2>/dev/null || git -C adk-python fetch --quiet origin
git -C adk-python checkout --quiet "$ADK_PYTHON_REF"

if [[ ! -d .venv ]]; then
  echo "==> Creating virtualenv ($PYTHON_BIN)"
  "$PYTHON_BIN" -m venv .venv
fi

echo "==> Installing adk-python"
./.venv/bin/python -m pip install --upgrade pip --quiet
./.venv/bin/python -m pip install -e ./adk-python --quiet

echo
echo "adk-python: $(./.venv/bin/adk --version)"
echo "adk-js:     $(node "$HERE/../../../dev/dist/esm/cli_entrypoint.js" --version)"
echo
echo "Ready. Run the suite with:  npm run test:cross-language"
