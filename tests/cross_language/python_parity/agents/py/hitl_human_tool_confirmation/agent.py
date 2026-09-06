# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
import sys

from _parity import load_sample

# `hitl/human_tool_confirmation` exports both `root_agent` and `app`, and
# `load_sample` returns the first of the two it finds — `root_agent` — which
# would drop the `App` wrapper and with it the `ResumabilityConfig` the sample
# exists to demonstrate. The call still imports and model-pins the sample
# module, so the configured `App` is taken from it afterwards. `adk run`
# prefers `app` over `root_agent`, which is also how the TS counterpart loads.
load_sample('hitl/human_tool_confirmation')
app = sys.modules['human_tool_confirmation.agent'].app
