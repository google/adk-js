/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node output: passing structured data
 * https://adk.dev/graphs/data-handling/#node-output-passing-structured-data
 *
 * `output` is not limited to text — any serializable value flows to the next
 * node, which receives it as a typed object. Attaching an `outputSchema` to the
 * producing node (and/or an `inputSchema` to the consumer) makes the contract
 * explicit and validates it at runtime.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/data_handling/structured_output/agent.ts
 */

import {createEvent, node, NodeContext, WorkflowAgent} from '@google/adk';
import {z} from 'zod';

const cityInfoSchema = z.object({
  cityName: z.string(),
  cityTime: z.string(),
});
type CityInfo = z.infer<typeof cityInfoSchema>;

const emitStructuredOutput = node(
  async function* () {
    yield createEvent({
      output: {cityName: 'Paris', cityTime: '10:10 AM'} satisfies CityInfo,
    });
  },
  {name: 'emit_structured_output', outputSchema: cityInfoSchema},
);

// The successor receives the object itself — no JSON parsing, no state reads.
const consumeStructuredOutput = node(
  (_ctx: NodeContext, cityInfo: CityInfo) =>
    `It is ${cityInfo.cityTime} in ${cityInfo.cityName} right now.`,
  {name: 'consume_structured_output', inputSchema: cityInfoSchema},
);

export const rootAgent = new WorkflowAgent({
  name: 'structured_output_workflow',
  edges: [['START', emitStructuredOutput, consumeStructuredOutput]],
});
