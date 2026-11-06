/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  context,
  type Context,
  createContextKey,
  type Span,
  trace,
} from '@opentelemetry/api';

import {GenAiAttr} from '../common/attributes.js';
import {getTracer} from './tracer.js';

const WORKFLOW_SCOPE_KEY = createContextKey('adk_workflow_scope');

/**
 * One `invoke_workflow` span, published on the context the workflow runs
 * under. Its presence is what makes a workflow started below it nested.
 */
interface WorkflowScope {
  /**
   * The runner's workflow entrypoint, which runs inside this span instead of
   * opening its own. Cleared once that workflow has claimed it.
   */
  entrypoint: object | undefined;
}

function isWorkflowScope(value: unknown): value is WorkflowScope {
  return typeof value === 'object' && value !== null && 'entrypoint' in value;
}

function getWorkflowScope(ctx: Context): WorkflowScope | undefined {
  const value = ctx.getValue(WORKFLOW_SCOPE_KEY);
  return isWorkflowScope(value) ? value : undefined;
}

/** Parameters for {@link startWorkflowSpan}. */
export interface StartWorkflowSpanParams {
  readonly workflowName: string;
  readonly sessionId: string;
  /**
   * The runner's entrypoint, when it is the workflow this span stands for. The
   * workflow claims the span with {@link claimEntrypointWorkflowSpan}.
   */
  readonly entrypoint?: object;
}

/** An `invoke_workflow` span and the context to run the workflow under. */
export interface WorkflowSpan {
  readonly span: Span;
  readonly context: Context;
}

/**
 * Starts an `invoke_workflow {workflowName}` span under the active context.
 *
 * A workflow started inside another workflow's span is marked
 * `gen_ai.workflow.nested`; the outermost one carries no such attribute.
 */
export function startWorkflowSpan({
  workflowName,
  sessionId,
  entrypoint,
}: StartWorkflowSpanParams): WorkflowSpan {
  const parentContext = context.active();
  const nested = getWorkflowScope(parentContext) !== undefined;
  const span = getTracer().startSpan(
    workflowName ? `invoke_workflow ${workflowName}` : 'invoke_workflow',
    {
      attributes: {
        [GenAiAttr.OPERATION_NAME]: 'invoke_workflow',
        [GenAiAttr.CONVERSATION_ID]: sessionId,
        ...(nested ? {[GenAiAttr.WORKFLOW_NESTED]: true} : {}),
        ...(workflowName ? {[GenAiAttr.WORKFLOW_NAME]: workflowName} : {}),
      },
    },
    parentContext,
  );
  const scope: WorkflowScope = {entrypoint};
  return {
    span,
    context: trace
      .setSpan(parentContext, span)
      .setValue(WORKFLOW_SCOPE_KEY, scope),
  };
}

/**
 * Hands the runner's span to the workflow it was opened for, once.
 *
 * @returns The context to run the workflow under, or `undefined` when
 *     `workflow` is not the unclaimed entrypoint of the enclosing span.
 */
export function claimEntrypointWorkflowSpan(
  workflow: object,
): Context | undefined {
  const scope = getWorkflowScope(context.active());
  if (scope === undefined || scope.entrypoint !== workflow) {
    return undefined;
  }
  scope.entrypoint = undefined;
  return context.active();
}
