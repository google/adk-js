/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {type Span, SpanStatusCode} from '@opentelemetry/api';

import type {BaseAgent} from '../../../../agents/base_agent.js';
import type {InvocationContext} from '../../../../agents/invocation_context.js';
import type {Event} from '../../../../events/event.js';
import type {LlmRequest} from '../../../../models/llm_request.js';
import type {LlmResponse} from '../../../../models/llm_response.js';
import type {BaseTool} from '../../../../tools/base_tool.js';
import {
  AdkAttr,
  ERROR_TYPE_ATTR,
  GcpAttr,
  GEN_AI_SYSTEM_VALUE,
  GenAiAttr,
} from '../common/attributes.js';
import {resolveErrorType} from '../common/error.js';
import {
  buildLlmRequestForTrace,
  safeJsonSerialize,
  shouldAddRequestResponseToSpans,
} from '../common/serialization.js';

/** Execution status recorded on a workflow node span. */
export type NodeExecutionStatus = 'completed' | 'waiting' | 'failed';

/** Parameters for recording agent invocation attributes on a span. */
export interface SetAgentInvocationAttributesParams {
  readonly agent: BaseAgent;
  readonly invocationContext: InvocationContext;
}

/**
 * Sets span attributes immediately available on agent invocation.
 */
export function setAgentInvocationAttributes(
  span: Span,
  {agent, invocationContext}: SetAgentInvocationAttributesParams,
): void {
  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'invoke_agent',
    [GenAiAttr.AGENT_DESCRIPTION]: agent.description,
    [GenAiAttr.AGENT_NAME]: agent.name,
    [GenAiAttr.CONVERSATION_ID]: invocationContext.session?.id,
  });
}

/** Parameters for recording workflow invocation attributes on a span. */
export interface SetWorkflowInvocationAttributesParams {
  readonly workflowName: string;
  readonly nodePath: string;
  readonly sessionId: string;
}

/**
 * Sets span attributes on a workflow invocation span.
 */
export function setWorkflowInvocationAttributes(
  span: Span,
  {workflowName, nodePath, sessionId}: SetWorkflowInvocationAttributesParams,
): void {
  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'invoke_workflow',
    [GenAiAttr.CONVERSATION_ID]: sessionId,
    [AdkAttr.WORKFLOW_NAME]: workflowName,
    [AdkAttr.NODE_PATH]: nodePath,
  });
}

/** Parameters for recording node execution attributes on a span. */
export interface SetNodeExecutionAttributesParams {
  readonly nodePath: string;
  readonly runId: string;
  readonly attempt: number;
  readonly status: NodeExecutionStatus;
  readonly interruptCount: number;
}

/**
 * Sets span attributes on a workflow node or node-attempt span.
 */
export function setNodeExecutionAttributes(
  span: Span,
  {
    nodePath,
    runId,
    attempt,
    status,
    interruptCount,
  }: SetNodeExecutionAttributesParams,
): void {
  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'execute_node',
    [AdkAttr.NODE_PATH]: nodePath,
    [AdkAttr.NODE_RUN_ID]: runId,
    [AdkAttr.NODE_ATTEMPT]: attempt,
    [AdkAttr.NODE_STATUS]: status,
    [AdkAttr.NODE_INTERRUPT_COUNT]: interruptCount,
  });
}

/** Parameters for recording tool execution attributes on a span. */
export interface SetToolCallAttributesParams {
  readonly tool: BaseTool;
  readonly args: Record<string, unknown>;
  readonly functionResponseEvent?: Event;
  /** The exception raised while executing the tool, if any. */
  readonly error?: unknown;
  /** An error type reported by a tool response instead of a thrown error. */
  readonly errorType?: string;
  readonly invocationContext: InvocationContext;
}

/**
 * Sets tool execution attributes and error status on a tool execution span.
 */
export function setToolCallAttributes(
  span: Span,
  params: SetToolCallAttributesParams,
): void {
  const {
    tool,
    args,
    functionResponseEvent,
    invocationContext,
    error,
    errorType,
  } = params;

  const hasError = Object.hasOwn(params, 'error');
  const failureType = hasError ? resolveErrorType(error) : errorType;

  if (hasError) {
    // Preserve useful stacks for Error instances without copying arbitrary
    // thrown strings or objects (which can contain user data) into telemetry.
    let exception: Error | string;
    try {
      exception = error instanceof Error ? error : resolveErrorType(error);
    } catch {
      exception = resolveErrorType(error);
    }
    span.recordException(exception);
  }
  if (failureType !== undefined) {
    span.setAttribute(ERROR_TYPE_ATTR, failureType);
    // Do not use an exception or tool response message here: those may contain
    // user data or credentials and are not covered by the content capture gate.
    span.setStatus({code: SpanStatusCode.ERROR, message: failureType});
  }

  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'execute_tool',
    [GenAiAttr.SYSTEM]: GEN_AI_SYSTEM_VALUE,
    [GenAiAttr.TOOL_DESCRIPTION]: tool.description || '',
    [GenAiAttr.TOOL_NAME]: tool.name,
    [GenAiAttr.TOOL_TYPE]: tool.constructor.name,
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    // Setting empty llm request and response (as UI expect these) while not
    // applicable for tool_response.
    [GcpAttr.LLM_REQUEST]: '{}',
    [GcpAttr.LLM_RESPONSE]: '{}',
    [GcpAttr.TOOL_CALL_ARGS]: shouldAddRequestResponseToSpans()
      ? safeJsonSerialize(args)
      : '{}',
  });

  let toolCallId = '<not specified>';
  let toolResponse: unknown = '<not specified>';

  if (functionResponseEvent?.content?.parts) {
    const responseParts = functionResponseEvent.content.parts;
    const functionResponse = responseParts[0]?.functionResponse;
    if (functionResponse?.id) {
      toolCallId = functionResponse.id;
    }
    if (functionResponse?.response) {
      toolResponse = functionResponse.response;
    }
  }
  if (typeof toolResponse !== 'object' || toolResponse === null) {
    toolResponse = {result: toolResponse};
  }

  span.setAttributes({
    [GenAiAttr.TOOL_CALL_ID]: toolCallId,
    ...(functionResponseEvent
      ? {[GcpAttr.EVENT_ID]: functionResponseEvent.id}
      : {}),
    [GcpAttr.TOOL_RESPONSE]: shouldAddRequestResponseToSpans()
      ? safeJsonSerialize(toolResponse)
      : '{}',
  });
}

/** Parameters for recording merged tool call attributes on a span. */
export interface SetMergedToolCallsAttributesParams {
  readonly responseEventId: string;
  readonly functionResponseEvent: Event;
  readonly invocationContext: InvocationContext;
}

/**
 * Sets merged tool call attributes on the active span.
 */
export function setMergedToolCallsAttributes(
  span: Span,
  {
    responseEventId,
    functionResponseEvent,
    invocationContext,
  }: SetMergedToolCallsAttributesParams,
): void {
  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'execute_tool',
    [GenAiAttr.SYSTEM]: GEN_AI_SYSTEM_VALUE,
    [GenAiAttr.TOOL_NAME]: '(merged tools)',
    [GenAiAttr.TOOL_DESCRIPTION]: '(merged tools)',
    [GenAiAttr.TOOL_CALL_ID]: responseEventId,
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    [GcpAttr.TOOL_CALL_ARGS]: 'N/A',
    [GcpAttr.EVENT_ID]: responseEventId,
    [GcpAttr.LLM_REQUEST]: '{}',
    [GcpAttr.LLM_RESPONSE]: '{}',
  });

  span.setAttribute(
    GcpAttr.TOOL_RESPONSE,
    shouldAddRequestResponseToSpans()
      ? safeJsonSerialize(functionResponseEvent)
      : '{}',
  );
}

/** Parameters for recording LLM call attributes on a span. */
export interface SetCallLlmAttributesParams {
  readonly invocationContext: InvocationContext;
  readonly eventId: string;
  readonly llmRequest: LlmRequest;
  readonly llmResponse: LlmResponse;
}

/**
 * Sets LLM request and response attributes on the given span.
 */
export function setCallLlmAttributes(
  span: Span,
  {
    invocationContext,
    eventId,
    llmRequest,
    llmResponse,
  }: SetCallLlmAttributesParams,
): void {
  span.setAttributes({
    [GenAiAttr.SYSTEM]: GEN_AI_SYSTEM_VALUE,
    [GenAiAttr.REQUEST_MODEL]: llmRequest.model,
    ...(invocationContext.agent?.name
      ? {[GenAiAttr.AGENT_NAME]: invocationContext.agent.name}
      : {}),
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    [GcpAttr.SESSION_ID]: invocationContext.session?.id,
    [GcpAttr.EVENT_ID]: eventId,
    [GcpAttr.LLM_REQUEST]: shouldAddRequestResponseToSpans()
      ? safeJsonSerialize(buildLlmRequestForTrace(llmRequest))
      : '{}',
  });

  if (llmRequest.config?.topP) {
    span.setAttribute(GenAiAttr.REQUEST_TOP_P, llmRequest.config.topP);
  }

  if (llmRequest.config?.maxOutputTokens !== undefined) {
    span.setAttribute(
      GenAiAttr.REQUEST_MAX_TOKENS,
      llmRequest.config.maxOutputTokens,
    );
  }

  span.setAttribute(
    GcpAttr.LLM_RESPONSE,
    shouldAddRequestResponseToSpans() ? safeJsonSerialize(llmResponse) : '{}',
  );

  if (llmResponse.usageMetadata) {
    span.setAttribute(
      GenAiAttr.USAGE_INPUT_TOKENS,
      llmResponse.usageMetadata.promptTokenCount || 0,
    );
  }

  if (llmResponse.usageMetadata?.candidatesTokenCount) {
    span.setAttribute(
      GenAiAttr.USAGE_OUTPUT_TOKENS,
      llmResponse.usageMetadata.candidatesTokenCount,
    );
  }

  if (llmResponse.finishReason) {
    const finishReasonValue =
      typeof llmResponse.finishReason === 'string'
        ? llmResponse.finishReason.toLowerCase()
        : String(llmResponse.finishReason).toLowerCase();
    span.setAttribute(GenAiAttr.RESPONSE_FINISH_REASONS, [finishReasonValue]);
  }
}

/** Parameters for recording live history `send_data` attributes on a span. */
export interface SetSendDataAttributesParams {
  /** The invocation context for the current agent run. */
  readonly invocationContext: InvocationContext;
  /** The ID of the event. */
  readonly eventId: string;
  /** A list of content objects. */
  readonly data: Content[];
}

/**
 * Sets `send_data` attributes on the given span.
 */
export function setSendDataAttributes(
  span: Span,
  {invocationContext, eventId, data}: SetSendDataAttributesParams,
): void {
  span.setAttributes({
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    [GcpAttr.EVENT_ID]: eventId,
  });

  span.setAttribute(
    GcpAttr.DATA,
    shouldAddRequestResponseToSpans() ? safeJsonSerialize(data) : '{}',
  );
}
