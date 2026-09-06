# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
import sys

from _parity import load_sample

# Deliberately the bare `root_agent`, not the sample's `app`.
#
# The sample's App exists only to attach `ContextCacheConfig`, and adk-js has
# no equivalent (no ContextCacheConfig, no cachedContent, nothing on
# AppOptions). Running Python with the cache and TS without it would compare
# two different setups, so both sides run the uncached agent, and the missing
# feature is recorded as a note on the case rather than buried in a diff.
load_sample('context_management/cache_analysis')
root_agent = sys.modules['cache_analysis.agent'].root_agent
