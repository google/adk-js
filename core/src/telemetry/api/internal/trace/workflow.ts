/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, type Context, type Span} from '@opentelemetry/api';

import {GenAiAttr, SUPPORT_ID_ATTR} from '../common/attributes.js';
import {getTracer} from './tracer.js';

/** Parameters for {@link startWorkflowSpan}. */
export interface StartWorkflowSpanParams {
  readonly workflowName: string;
  readonly sessionId: string;
  readonly nested: boolean;
  readonly parentContext?: Context;
  readonly supportId?: string;
}

/**
 * Starts an `invoke_workflow {workflowName}` span.
 *
 * A workflow started inside another workflow is marked
 * `gen_ai.workflow.nested`; the outermost one carries no such attribute.
 */
export function startWorkflowSpan({
  workflowName,
  sessionId,
  nested,
  parentContext = context.active(),
  supportId,
}: StartWorkflowSpanParams): Span {
  return getTracer().startSpan(
    workflowName ? `invoke_workflow ${workflowName}` : 'invoke_workflow',
    {
      attributes: {
        [GenAiAttr.OPERATION_NAME]: 'invoke_workflow',
        [GenAiAttr.CONVERSATION_ID]: sessionId,
        ...(nested ? {[GenAiAttr.WORKFLOW_NESTED]: true} : {}),
        ...(workflowName ? {[GenAiAttr.WORKFLOW_NAME]: workflowName} : {}),
        ...(!nested && supportId ? {[SUPPORT_ID_ATTR]: supportId} : {}),
      },
    },
    parentContext,
  );
}
