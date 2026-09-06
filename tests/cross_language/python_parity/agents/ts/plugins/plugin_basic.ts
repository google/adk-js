/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/plugins/plugin_basic.
 *
 * The sample has no `agent.py`: `__init__.py` re-exports `root_agent` from
 * `main.py`, and `CountInvocationPlugin` is attached to an ad-hoc
 * `InMemoryRunner` *inside* `main()`. Nothing loads `main()` under `adk run`,
 * so the Python side of this case runs the bare agent with no plugin — and
 * this port mirrors exactly that, otherwise the TS side would carry a plugin
 * the Python side never installs.
 *
 * The plugin itself is ported and exercised by the `core_app` case, which is
 * the same `CountInvocationPlugin` attached to an `App` (adk-js
 * `beforeAgentCallback` / `beforeModelCallback` on `BasePlugin`).
 *
 * What this case therefore measures is the sample's odd little tool:
 * `hello_world` prints and returns nothing, so it compares how the two
 * runtimes encode a void tool result in the function response.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const helloWorld = new FunctionTool({
  name: 'hello_world',
  description: '',
  parameters: z.object({
    query: z.string(),
  }),
  execute: ({query}) => {
    console.log(`Hello world: query is [${query}]`);
  },
});

export const rootAgent = new LlmAgent({
  name: 'hello_world',
  model: PARITY_MODEL,
  description: 'Prints hello world with user query.',
  instruction: `Use hello_world tool to print hello world and user query.
    `,
  tools: [helloWorld],
});
