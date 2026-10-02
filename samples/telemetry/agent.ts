/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Span attributes on a traced tool call
 * ../../docs/guides/telemetry/index.md
 *
 * One prompt produces one `execute_tool get_order_status` span between two
 * `call_llm` spans. The tool span carries `gen_ai.system = "gcp.vertex.agent"`,
 * so a trace backend filtering on that key keeps the tool call as well as the
 * model calls, and `gcp.vertex.agent.invocation_id`, so every span of one turn
 * groups together.
 *
 * `maybeSetOtelProviders` does not replace a tracer provider that is already
 * registered globally. The `adk web` dev server registers one before it loads
 * this file, so the console exporter below prints nothing there; read the
 * Trace view instead. Running the sample from the CLI prints the spans.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/telemetry/agent.ts
 */

import {FunctionTool, LlmAgent, maybeSetOtelProviders} from '@google/adk';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {z} from 'zod';

maybeSetOtelProviders([
  {spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())]},
]);

const ORDER_STATUS: Record<string, string> = {
  'A-1042': 'shipped',
  'A-1043': 'awaiting payment',
};

const getOrderStatus = new FunctionTool({
  name: 'get_order_status',
  description: 'Looks up the delivery status of one order by its identifier.',
  parameters: z.object({
    orderId: z.string().describe('The order identifier, such as "A-1042".'),
  }),
  execute: ({orderId}) => ({
    orderId,
    status: ORDER_STATUS[orderId] ?? 'unknown',
  }),
});

export const rootAgent = new LlmAgent({
  name: 'telemetry',
  model: 'gemini-flash-latest',
  description: 'Answers order questions through one traced tool call.',
  instruction:
    'You answer questions about orders. Call get_order_status for every ' +
    'question that names an order, and report the status it returns.',
  tools: [getOrderStatus],
});
