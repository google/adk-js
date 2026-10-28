/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Spans and log records of a traced tool call
 * ../../docs/guides/telemetry/index.md
 *
 * One prompt produces an `invoke_workflow telemetry` span holding an
 * `invoke_agent telemetry` span, and inside that two
 * `generate_content gemini-flash-latest` spans with the
 * `execute_tool get_order_status` span between them. Each model call also
 * emits one `gen_ai.client.inference.operation.details` log record, printed by
 * the console log record processor below.
 *
 * `maybeSetOtelProviders` does not replace a provider that is already
 * registered globally. The `adk web` dev server registers one before it loads
 * this file, so the console exporters below print nothing there; read the
 * Trace view instead. Running the sample from the CLI prints the spans and the
 * log records.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/telemetry/agent.ts
 */

import {FunctionTool, LlmAgent, maybeSetOtelProviders} from '@google/adk';
import {
  ConsoleLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {z} from 'zod';

maybeSetOtelProviders([
  {
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
    logRecordProcessors: [
      new SimpleLogRecordProcessor({exporter: new ConsoleLogRecordExporter()}),
    ],
  },
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
