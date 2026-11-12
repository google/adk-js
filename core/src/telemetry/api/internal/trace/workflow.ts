/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  context,
  createContextKey,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';

import {GenAiAttr, SUPPORT_ID_ATTR} from '../common/attributes.js';
import {getTracer} from './tracer.js';

/**
 * Context key holding the support id that `runWithAgentEngineContext` stores.
 * `createContextKey` uses `Symbol.for`, so this resolves to the same key.
 */
const SUPPORT_ID_KEY = createContextKey('google.adk.agent_engine.support_id');

/** Parameters for {@link startWorkflowSpan}. */
export interface StartWorkflowSpanParams {
  readonly workflowName: string;
  readonly sessionId: string;
  readonly nested: boolean;
  readonly parentContext?: Context;
}

/**
 * Returns the support id to record on a workflow span, only when that span is
 * the top span of its trace: not nested and with no local parent span.
 */
function getSupportId(
  parentContext: Context,
  nested: boolean,
): string | undefined {
  // Defensive guard: a nested workflow normally has a local parent, which the
  // parent check below already catches.
  if (nested) {
    return undefined;
  }
  const parentSpanContext = trace.getSpanContext(parentContext);
  if (parentSpanContext && !parentSpanContext.isRemote) {
    return undefined;
  }
  const supportId = parentContext.getValue(SUPPORT_ID_KEY);
  return typeof supportId === 'string' ? supportId : undefined;
}

/**
 * Starts an `invoke_workflow {workflowName}` span.
 *
 * A workflow started inside another workflow is marked
 * `gen_ai.workflow.nested`; the outermost one carries no such attribute. The
 * top span of a trace also carries `supportID` when the request supplied one.
 */
export function startWorkflowSpan({
  workflowName,
  sessionId,
  nested,
  parentContext = context.active(),
}: StartWorkflowSpanParams): Span {
  const supportId = getSupportId(parentContext, nested);
  return getTracer().startSpan(
    workflowName ? `invoke_workflow ${workflowName}` : 'invoke_workflow',
    {
      attributes: {
        [GenAiAttr.OPERATION_NAME]: 'invoke_workflow',
        [GenAiAttr.CONVERSATION_ID]: sessionId,
        ...(nested ? {[GenAiAttr.WORKFLOW_NESTED]: true} : {}),
        ...(workflowName ? {[GenAiAttr.WORKFLOW_NAME]: workflowName} : {}),
        ...(supportId ? {[SUPPORT_ID_ATTR]: supportId} : {}),
      },
    },
    parentContext,
  );
}
