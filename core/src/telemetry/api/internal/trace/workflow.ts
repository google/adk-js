/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Span} from '@opentelemetry/api';

import {GenAiAttr} from '../common/attributes.js';
import {getTracer} from './tracer.js';

/** Parameters for {@link startWorkflowSpan}. */
export interface StartWorkflowSpanParams {
  readonly workflowName: string;
  readonly sessionId: string;
  /** Whether the workflow runs inside another workflow. */
  readonly nested: boolean;
}

/**
 * Starts an `invoke_workflow {workflowName}` span under the active context.
 *
 * A nested workflow is marked `gen_ai.workflow.nested`; the outermost one
 * carries no such attribute.
 */
export function startWorkflowSpan({
  workflowName,
  sessionId,
  nested,
}: StartWorkflowSpanParams): Span {
  return getTracer().startSpan(
    workflowName ? `invoke_workflow ${workflowName}` : 'invoke_workflow',
    {
      attributes: {
        [GenAiAttr.OPERATION_NAME]: 'invoke_workflow',
        [GenAiAttr.CONVERSATION_ID]: sessionId,
        ...(nested ? {[GenAiAttr.WORKFLOW_NESTED]: true} : {}),
        ...(workflowName ? {[GenAiAttr.WORKFLOW_NAME]: workflowName} : {}),
      },
    },
  );
}
