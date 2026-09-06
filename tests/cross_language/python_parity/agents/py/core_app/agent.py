# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
from _parity import load_sample

# `core/app` exports both `app` and `root_agent`. `load_sample` returns the
# `App`, matching ADK's own AgentLoader and the TS CLI, so the plugins attached
# to the App are exercised on both sides.
app = load_sample('core/app')
