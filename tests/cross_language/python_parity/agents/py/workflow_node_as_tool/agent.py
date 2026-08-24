# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
"""The runnable root for this sample is its `App`, not its `root_agent`.

`calculate_discount` pauses on a `RequestInput`, which only resumes when the
app is marked resumable. `load_sample` resolves `app` first — the same
precedence as ADK's own AgentLoader and the TS CLI — so this is just the
standard shim.
"""
from _parity import load_sample

app = load_sample('workflows/node_as_tool')
