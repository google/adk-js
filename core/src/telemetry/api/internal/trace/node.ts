/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Span} from '@opentelemetry/api';

import type {BaseNode} from '../../../../workflow/base_node.js';
import {GcpAttr, GenAiAttr} from '../common/attributes.js';
import {getTracer} from './tracer.js';

/**
 * The global-registry brands of `BaseAgent` and `Workflow`, the same symbols
 * `isBaseAgent` and `isWorkflow` match. Matched here rather than through those
 * guards because their modules import the instrumentation, and importing them
 * back would make the module graph circular.
 */
const SELF_TRACED_NODE_BRANDS: readonly symbol[] = [
  Symbol.for('google.adk.baseAgent'),
  Symbol.for('google.adk.workflow.workflow'),
];

/**
 * Whether a node is traced by a span of its own kind rather than by
 * `invoke_node`: an agent opens `invoke_agent` and a workflow
 * `invoke_workflow`.
 */
export function hasOwnInvocationSpan(node: BaseNode): boolean {
  return SELF_TRACED_NODE_BRANDS.some(
    (brand) => brand in node && Reflect.get(node, brand) === true,
  );
}

/** Parameters for {@link startNodeSpan}. */
export interface StartNodeSpanParams {
  readonly nodeName: string;
  readonly sessionId: string;
}

/** Starts an `invoke_node {nodeName}` span under the active context. */
export function startNodeSpan({
  nodeName,
  sessionId,
}: StartNodeSpanParams): Span {
  return getTracer().startSpan(`invoke_node ${nodeName}`, {
    attributes: {
      [GenAiAttr.OPERATION_NAME]: 'invoke_node',
      [GenAiAttr.CONVERSATION_ID]: sessionId,
    },
  });
}

/** Records the ids of the events a node emitted on its span, if it emitted any. */
export function setAssociatedEventIds(
  span: Span,
  eventIds: readonly string[],
): void {
  if (eventIds.length > 0) {
    span.setAttribute(GcpAttr.ASSOCIATED_EVENT_IDS, [...eventIds]);
  }
}
