/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/context_management/memory.
 *
 * Ported as literally as the two APIs allow: same agent name and description,
 * same instruction text (including the `{_time}` state placeholder, which both
 * runtimes resolve the same way), and the same two memory tools.
 *
 * adk-js ships the same two singletons Python does — `load_memory_tool` /
 * `preload_memory_tool` are `LOAD_MEMORY` / `PRELOAD_MEMORY` here — and both
 * CLIs default to an in-memory memory service, so the wiring is identical.
 * What no replay file can express is the sample's second half: `main.py`
 * builds one session, calls `add_session_to_memory`, then opens a *second*
 * session to recall from it. A single replayed session leaves the memory
 * service empty on both sides.
 */
import {LlmAgent, LOAD_MEMORY, PRELOAD_MEMORY} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

export const rootAgent = new LlmAgent({
  name: 'memory_agent',
  model: PARITY_MODEL,
  description: 'agent that have access to memory tools.',
  beforeAgentCallback: (callbackContext) => {
    callbackContext.state.set('_time', new Date().toISOString());
    return undefined;
  },
  instruction: `You are an agent that help user answer questions.

Current time: {_time}
`,
  tools: [LOAD_MEMORY, PRELOAD_MEMORY],
});
