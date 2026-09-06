/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/core/app.
 *
 * Ported as literally as the two APIs allow: same app name, same agent name
 * and instruction, same counting plugin. Divergence in the transcript should
 * come from the runtimes, not from the agent definition.
 *
 * Two pieces of the Python `App` have no adk-js equivalent and are therefore
 * absent rather than approximated:
 *   - `events_compaction_config` / `context_cache_config`: adk-js `AppOptions`
 *     is only `{name, rootAgent, plugins, resumabilityConfig}`. Compaction in
 *     adk-js is per-agent (`LlmAgent.contextCompactors`) and there is no
 *     context-cache config at all.
 *   - `SaveFilesAsArtifactsPlugin`: not ported to adk-js.
 */
import type {BaseAgent, Context, LlmRequest} from '@google/adk';
import {App, BasePlugin, LlmAgent} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

/** A custom plugin that counts agent and LLM invocations. */
class CountInvocationPlugin extends BasePlugin {
  agentCount = 0;
  llmRequestCount = 0;

  constructor() {
    super('count_invocation');
  }

  /** Count agent runs. */
  override async beforeAgentCallback(_params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<undefined> {
    this.agentCount += 1;
    console.log(`[Plugin] Agent run count: ${this.agentCount}`);
    return undefined;
  }

  /** Count LLM requests. */
  override async beforeModelCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<undefined> {
    this.llmRequestCount += 1;
    console.log(`[Plugin] LLM request count: ${this.llmRequestCount}`);
    return undefined;
  }
}

export const rootAgent = new LlmAgent({
  name: 'greeter_agent',
  model: PARITY_MODEL,
  instruction: `You are a friendly and helpful concierge assistant. Greet the user and answer their questions.
`,
});

export const app = new App({
  name: 'app',
  rootAgent,
  plugins: [new CountInvocationPlugin()],
});
