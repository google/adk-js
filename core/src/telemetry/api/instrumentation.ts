/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {context, type Span, SpanStatusCode, trace} from '@opentelemetry/api';

import type {BaseAgent} from '../../agents/base_agent.js';
import type {InvocationContext} from '../../agents/invocation_context.js';
import type {Event} from '../../events/event.js';
import type {LlmRequest} from '../../models/llm_request.js';
import type {LlmResponse} from '../../models/llm_response.js';
import type {BaseTool} from '../../tools/base_tool.js';
import {formatError} from '../../utils/error_utils.js';

import {getToolResponseErrorType} from './internal/common/error.js';
import {
  setAgentInvocationAttributes,
  setCallLlmAttributes,
  setMergedToolCallsAttributes,
  setNodeExecutionAttributes,
  setSendDataAttributes,
  setToolCallAttributes,
  setWorkflowInvocationAttributes,
} from './internal/trace/span_attributes.js';
import {
  bindOtelContextToAsyncGenerator,
  getTracer,
} from './internal/trace/tracer.js';

/**
 * Wraps a top-level runner invocation async generator inside the `invocation`
 * span and binds the active OpenTelemetry context to every step of the
 * generator.
 */
export function recordInvocation<T>(
  createGenerator: () => AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  return (async function* () {
    const span = getTracer().startSpan('invocation');
    try {
      const ctx = trace.setSpan(context.active(), span);
      yield* bindOtelContextToAsyncGenerator(
        ctx,
        context.with(ctx, createGenerator),
      );
    } finally {
      span.end();
    }
  })();
}

/** Parameters for starting an `invoke_agent` instrumentation scope. */
export interface RecordAgentInvocationParams {
  readonly agent: BaseAgent;
}

/** Scope handle passed to the body of {@link recordAgentInvocation}. */
export interface AgentInvocationScope {
  /** Records agent invocation attributes once the context is available. */
  recordInvocation(invocationContext: InvocationContext): void;
}

/**
 * Wraps an agent invocation async generator inside an
 * `invoke_agent ${agent.name}` span and binds the active OpenTelemetry context
 * to every step of the generator.
 */
export function recordAgentInvocation<T>(
  {agent}: RecordAgentInvocationParams,
  createGenerator: (
    scope: AgentInvocationScope,
  ) => AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  return (async function* () {
    const span = getTracer().startSpan(`invoke_agent ${agent.name}`);
    const scope: AgentInvocationScope = {
      recordInvocation(invocationContext: InvocationContext): void {
        setAgentInvocationAttributes(span, {agent, invocationContext});
      },
    };
    try {
      const ctx = trace.setSpan(context.active(), span);
      yield* bindOtelContextToAsyncGenerator(
        ctx,
        context.with(ctx, () => createGenerator(scope)),
      );
    } finally {
      span.end();
    }
  })();
}

/** Parameters for recording an LLM response on an active `call_llm` span. */
export interface RecordCallLlmResponseParams {
  readonly invocationContext: InvocationContext;
  readonly eventId: string;
  readonly llmRequest: LlmRequest;
  readonly llmResponse: LlmResponse;
}

/**
 * Wraps an LLM call async generator inside a `call_llm` span and binds the
 * active OpenTelemetry context to every step of the generator.
 *
 * Code running inside the generator records each model response on this span
 * with {@link recordCallLlmResponse}.
 */
export function recordCallLlm<T>(
  createGenerator: () => AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  return (async function* () {
    const span = getTracer().startSpan('call_llm');
    try {
      const ctx = trace.setSpan(context.active(), span);
      yield* bindOtelContextToAsyncGenerator(
        ctx,
        context.with(ctx, createGenerator),
      );
    } finally {
      span.end();
    }
  })();
}

/**
 * Records LLM request and response attributes on the active `call_llm` span
 * started by {@link recordCallLlm}. Does nothing when no span is active.
 */
export function recordCallLlmResponse(
  params: RecordCallLlmResponseParams,
): void {
  const span = trace.getActiveSpan();
  if (!span) {
    return;
  }
  setCallLlmAttributes(span, params);
}

/** Parameters for recording a live `send_data` span. */
export interface RecordSendDataParams {
  readonly invocationContext: InvocationContext;
  readonly eventId: string;
  readonly data: Content[];
}

/**
 * Wraps an async operation in a `send_data` span and records the live data
 * payload attributes when the operation completes.
 */
export async function recordSendData<T>(
  params: RecordSendDataParams,
  fn: () => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan('send_data', async (span) => {
    try {
      const result = await fn();
      setSendDataAttributes(span, params);
      return result;
    } finally {
      span.end();
    }
  });
}

/** Parameters for starting an `execute_tool` instrumentation scope. */
export interface RecordToolExecutionParams {
  readonly toolName: string;
  readonly invocationContext: InvocationContext;
}

/** Parameters for recording a completed tool execution on its scope. */
export interface ToolExecutionSuccessParams {
  readonly tool: BaseTool;
  readonly args: Record<string, unknown>;
  readonly functionResponseEvent?: Event;
  /**
   * The raw value returned by the tool before normalization into a
   * `functionResponse` event, used to inspect any response-reported error type.
   */
  readonly rawResult: unknown;
}

/** Parameters for recording a failed tool execution on its scope. */
export interface ToolExecutionErrorParams {
  readonly tool: BaseTool;
  readonly args: Record<string, unknown>;
  readonly error: unknown;
}

/** Scope handle passed to the body of {@link recordToolExecution}. */
export interface ToolExecutionScope {
  /**
   * Records tool execution attributes for a returned tool response, extracting
   * any response-reported error type automatically.
   */
  recordSuccess(params: ToolExecutionSuccessParams): void;
  /**
   * Records tool execution attributes and exception details when a tool or hook
   * throws.
   */
  recordError(params: ToolExecutionErrorParams): void;
}

/**
 * Wraps a single tool call inside an `execute_tool ${toolName}` active span.
 */
export async function recordToolExecution<T>(
  {toolName, invocationContext}: RecordToolExecutionParams,
  fn: (scope: ToolExecutionScope) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(
    `execute_tool ${toolName}`,
    async (span) => {
      const scope: ToolExecutionScope = {
        recordSuccess({
          tool,
          args,
          functionResponseEvent,
          rawResult,
        }: ToolExecutionSuccessParams): void {
          setToolCallAttributes(span, {
            tool,
            args,
            functionResponseEvent,
            errorType: getToolResponseErrorType(rawResult),
            invocationContext,
          });
        },
        recordError({tool, args, error}: ToolExecutionErrorParams): void {
          setToolCallAttributes(span, {
            tool,
            args,
            error,
            invocationContext,
          });
        },
      };
      try {
        return await fn(scope);
      } finally {
        span.end();
      }
    },
  );
}

/** Parameters for recording a merged tool calls span. */
export interface RecordMergedToolCallsParams {
  readonly responseEventId: string;
  readonly functionResponseEvent: Event;
  readonly invocationContext: InvocationContext;
}

/**
 * Starts and immediately ends an `execute_tool (merged)` span with merged
 * tool response attributes.
 */
export function recordMergedToolCalls(
  params: RecordMergedToolCallsParams,
): void {
  getTracer().startActiveSpan('execute_tool (merged)', (span) => {
    try {
      setMergedToolCallsAttributes(span, params);
    } finally {
      span.end();
    }
  });
}

/** Parameters for starting an `invoke_workflow` instrumentation scope. */
export interface RecordWorkflowInvocationParams {
  readonly workflowName: string;
  readonly nodePath: string;
  readonly sessionId: string;
}

/**
 * A synchronously started span scope for workflow orchestration.
 *
 * Workflow and node scopes return this handle instead of wrapping a callback.
 * Their spans must start at the moment the work is scheduled, and the scope
 * must hand the caller's promise back unchanged: an `async` wrapper adds
 * promise ticks, which changes how concurrently scheduled nodes interleave.
 */
export interface SyncStartedScope {
  /**
   * Runs `fn` with this scope's span as the active span and returns its result
   * as is, without awaiting it.
   */
  run<T>(fn: () => T): T;
  /** Ends the span. Safe to call more than once. */
  end(): void;
}

function startSyncScope(span: Span): SyncStartedScope {
  const ctx = trace.setSpan(context.active(), span);
  let ended = false;
  return {
    run: (fn) => context.with(ctx, fn),
    end(): void {
      if (!ended) {
        ended = true;
        span.end();
      }
    },
  };
}

/**
 * Starts an `invoke_workflow ${workflowName}` span synchronously and records
 * its attributes.
 *
 * The caller runs the orchestration through `scope.run` and calls
 * `scope.end()` in a `finally` block once the orchestration settles.
 */
export function recordWorkflowInvocation(
  params: RecordWorkflowInvocationParams,
): SyncStartedScope {
  const span = getTracer().startSpan(`invoke_workflow ${params.workflowName}`);
  setWorkflowInvocationAttributes(span, params);
  return startSyncScope(span);
}

/** Parameters for starting an `execute_node` instrumentation scope. */
export interface RecordNodeInvocationParams {
  readonly nodeName: string;
}

/** Details recorded when a workflow node completes or pauses for input. */
export interface NodeExecutionCompletionDetails {
  readonly nodePath: string;
  readonly runId: string;
  readonly attempt: number;
  readonly status: 'completed' | 'waiting';
  readonly interruptCount: number;
}

/** Details recorded when a workflow node fails with an exception. */
export interface NodeExecutionFailureDetails {
  readonly nodePath: string;
  readonly runId: string;
  readonly attempt: number;
  readonly interruptCount: number;
  readonly error: unknown;
}

/** Scope handle returned by {@link recordNodeInvocation}. */
export interface NodeInvocationScope extends SyncStartedScope {
  /** Records node completion or waiting status on the node span. */
  recordCompletion(details: NodeExecutionCompletionDetails): void;
  /** Records node failure, exception, and error status on the node span. */
  recordFailure(details: NodeExecutionFailureDetails): void;
}

function recordNodeSpanException(span: Span, error: unknown): void {
  span.setStatus({code: SpanStatusCode.ERROR, message: formatError(error)});
}

/**
 * Starts an `execute_node ${nodeName}` span synchronously.
 *
 * The span's parent is the span active at the call, so call this when the node
 * is scheduled. The caller runs the node body through `scope.run` and calls
 * `scope.end()` in a `finally` block when the node work finishes.
 */
export function recordNodeInvocation({
  nodeName,
}: RecordNodeInvocationParams): NodeInvocationScope {
  const span = getTracer().startSpan(`execute_node ${nodeName}`);
  return {
    ...startSyncScope(span),
    recordCompletion({
      nodePath,
      runId,
      attempt,
      status,
      interruptCount,
    }: NodeExecutionCompletionDetails): void {
      setNodeExecutionAttributes(span, {
        nodePath,
        runId,
        attempt,
        status,
        interruptCount,
      });
    },
    recordFailure({
      nodePath,
      runId,
      attempt,
      interruptCount,
      error,
    }: NodeExecutionFailureDetails): void {
      setNodeExecutionAttributes(span, {
        nodePath,
        runId,
        attempt,
        status: 'failed',
        interruptCount,
      });
      recordNodeSpanException(span, error);
    },
  };
}

/** Parameters for recording a retryable workflow node attempt. */
export interface RecordNodeAttemptParams {
  readonly enabled: boolean;
  readonly nodeName: string;
  readonly nodePath: string;
  readonly runId: string;
  readonly attempt: number;
  readonly getStatus: () => 'completed' | 'waiting';
  readonly getInterruptCount: () => number;
}

/**
 * Executes a single workflow node attempt. When `enabled` is true (retry is
 * configured on the node), wraps the attempt in an
 * `execute_node_attempt ${nodeName}` span.
 */
export function recordNodeAttempt<T>(
  {
    enabled,
    nodeName,
    nodePath,
    runId,
    attempt,
    getStatus,
    getInterruptCount,
  }: RecordNodeAttemptParams,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) {
    return fn();
  }

  return getTracer().startActiveSpan(
    `execute_node_attempt ${nodeName}`,
    async (attemptSpan) => {
      try {
        const result = await fn();
        setNodeExecutionAttributes(attemptSpan, {
          nodePath,
          runId,
          attempt,
          status: getStatus(),
          interruptCount: getInterruptCount(),
        });
        return result;
      } catch (e) {
        setNodeExecutionAttributes(attemptSpan, {
          nodePath,
          runId,
          attempt,
          status: 'failed',
          interruptCount: getInterruptCount(),
        });
        recordNodeSpanException(attemptSpan, e);
        throw e;
      } finally {
        attemptSpan.end();
      }
    },
  );
}
