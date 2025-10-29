/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * NOTE:
 *
 *    We expect that the underlying GenAI SDK will provide a certain
 *    level of tracing and logging telemetry aligned with Open Telemetry
 *    Semantic Conventions (such as logging prompts, responses,
 *    request properties, etc.) and so the information that is recorded by the
 *    Agent Development Kit should be focused on the higher-level
 *    constructs of the framework that are not observable by the SDK.
 */

import {Content} from '@google/genai';
import {trace, context, Context} from '@opentelemetry/api';

import {BaseAgent} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BaseTool} from '../tools/base_tool.js';
import {version} from '../version.js';

const GEN_AI_AGENT_DESCRIPTION = 'gen_ai.agent.description';
const GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
const GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';
const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
const GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';
const GEN_AI_TOOL_DESCRIPTION = 'gen_ai.tool.description';
const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
const GEN_AI_TOOL_TYPE = 'gen_ai.tool.type';

export const tracer = trace.getTracer(
  'gcp.vertex.agent',
  version,
);

/**
 * Convert any JavaScript object to a JSON-serializable string.
 *
 * @param obj The object to serialize.
 * @returns The JSON-serialized object string or '<not serializable>' if the object cannot be serialized.
 */
function safeJsonSerialize(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch (error) {
    return '<not serializable>';
  }
}

export interface TraceAgentInvocationParams {
  agent: BaseAgent;
  invocationContext: InvocationContext;
}

/**
 * Sets span attributes immediately available on agent invocation according to OTEL semconv version 1.37.
 *
 * @param params The parameters object containing agent and invocation context.
 *
 * Inference related fields are not set, due to their planned removal from invoke_agent span:
 * https://github.com/open-telemetry/semantic-conventions/issues/2632
 *
 * `gen_ai.agent.id` is not set because currently it's unclear what attributes this field should have, specifically:
 * - In which scope should it be unique (globally, given project, given agentic flow, given deployment).
 * - Should it be unchanging between deployments, and how this should this be achieved.
 *
 * `gen_ai.data_source.id` is not set because it's not available.
 * Closest type which could contain this information is types.GroundingMetadata, which does not have an ID.
 *
 * `server.*` attributes are not set pending confirmation from aabmass.
 */
export function traceAgentInvocation({
  agent,
  invocationContext,
}: TraceAgentInvocationParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  
  // Required
  span.setAttributes({
    [GEN_AI_OPERATION_NAME]: 'invoke_agent',
    // Conditionally Required
    [GEN_AI_AGENT_DESCRIPTION]: agent.description,
    [GEN_AI_AGENT_NAME]: agent.name,
    [GEN_AI_CONVERSATION_ID]: invocationContext.session.id,
  });
}

export interface TraceToolCallParams {
  tool: BaseTool;
  args: Record<string, unknown>;
  functionResponseEvent: Event;
}

/**
 * Traces tool call.
 *
 * @param params The parameters object containing tool, args, and function response event.
 */
export function traceToolCall({
  tool,
  args,
  functionResponseEvent,
}: TraceToolCallParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  
  span.setAttributes({
    [GEN_AI_OPERATION_NAME]: 'execute_tool',
    [GEN_AI_TOOL_DESCRIPTION]: tool.description || '',
    [GEN_AI_TOOL_NAME]: tool.name,
    // e.g. FunctionTool
    [GEN_AI_TOOL_TYPE]: tool.constructor.name,
    // Setting empty llm request and response (as UI expect these) while not
    // applicable for tool_response.
    'gcp.vertex.agent.llm_request': '{}',
    'gcp.vertex.agent.llm_response': '{}',
    'gcp.vertex.agent.tool_call_args': shouldAddRequestResponseToSpans() 
      ? safeJsonSerialize(args)
      : '{}'
  });

  // Tracing tool response
  let toolCallId = '<not specified>';
  let toolResponse: unknown = '<not specified>';
  
  if (functionResponseEvent.content?.parts) {
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
    toolResponse = { result: toolResponse };
  }

  span.setAttributes({
    [GEN_AI_TOOL_CALL_ID]: toolCallId,
    'gcp.vertex.agent.event_id': functionResponseEvent.id,
    'gcp.vertex.agent.tool_response': shouldAddRequestResponseToSpans()
      ? safeJsonSerialize(toolResponse)
      : '{}'
  });
}

export interface TraceMergedToolCallsParams {
  responseEventId: string;
  functionResponseEvent: Event;
}

/**
 * Traces merged tool call events.
 *
 * Calling this function is not needed for telemetry purposes. This is provided
 * for preventing /debug/trace requests (typically sent by web UI).
 *
 * @param params The parameters object containing response event ID and function response event.
 */
export function traceMergedToolCalls({
  responseEventId,
  functionResponseEvent,
}: TraceMergedToolCallsParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  span.setAttributes({
    [GEN_AI_OPERATION_NAME]: 'execute_tool',
    [GEN_AI_TOOL_NAME]: '(merged tools)',
    [GEN_AI_TOOL_DESCRIPTION]: '(merged tools)',
    [GEN_AI_TOOL_CALL_ID]: responseEventId,
    'gcp.vertex.agent.tool_call_args': 'N/A',
    'gcp.vertex.agent.event_id': responseEventId,
    // Setting empty llm request and response (as UI expect these) while not
    // applicable for tool_response.
    'gcp.vertex.agent.llm_request': '{}',
    'gcp.vertex.agent.llm_response': '{}',
  });

  span.setAttribute('gcp.vertex.agent.tool_response', shouldAddRequestResponseToSpans()
    ? safeJsonSerialize(functionResponseEvent)
    : '{}');
}

export interface TraceCallLlmParams {
  invocationContext: InvocationContext;
  eventId: string;
  llmRequest: LlmRequest;
  llmResponse: LlmResponse;
}

/**
 * Traces a call to the LLM.
 *
 * This function records details about the LLM request and response as
 * attributes on the current OpenTelemetry span.
 *
 * @param params The parameters object containing invocationContext, eventId, llmRequest, and llmResponse.
 */
export function traceCallLlm({
  invocationContext,
  eventId,
  llmRequest,
  llmResponse,
}: TraceCallLlmParams): void {
  // Special standard Open Telemetry GenAI attributes that indicate
  // that this is a span related to a Generative AI system.
  const span = trace.getActiveSpan();
  if (!span) return;
  
  span.setAttributes({
    'gen_ai.system': 'gcp.vertex.agent',
    'gen_ai.request.model': llmRequest.model,
    'gcp.vertex.agent.invocation_id': invocationContext.invocationId,
    'gcp.vertex.agent.session_id': invocationContext.session.id,
    'gcp.vertex.agent.event_id': eventId,
    // Consider removing once GenAI SDK provides a way to record this info.
    'gcp.vertex.agent.llm_request': shouldAddRequestResponseToSpans()
      ? safeJsonSerialize(buildLlmRequestForTrace(llmRequest))
      : '{}',
  });

  // Consider removing once GenAI SDK provides a way to record this info.
  if (llmRequest.config?.topP) {
      span.setAttribute('gen_ai.request.top_p', llmRequest.config.topP);
  }

  if (llmRequest.config?.maxOutputTokens !== undefined) {
    span.setAttribute('gen_ai.request.max_tokens', llmRequest.config.maxOutputTokens);
  }

  span.setAttribute('gcp.vertex.agent.llm_response', shouldAddRequestResponseToSpans()
    ? safeJsonSerialize(llmResponse)
    : '{}');

  if (llmResponse.usageMetadata) {
    span.setAttribute('gen_ai.usage.input_tokens', llmResponse.usageMetadata.promptTokenCount || 0);
  }
  
  if (llmResponse.usageMetadata?.candidatesTokenCount) {
    span.setAttribute('gen_ai.usage.output_tokens', llmResponse.usageMetadata.candidatesTokenCount);
  }

  if (llmResponse.finishReason) {
    // Convert enum to lowercase string array
    const finishReasonValue = typeof llmResponse.finishReason === 'string' 
      ? llmResponse.finishReason.toLowerCase()
      : String(llmResponse.finishReason).toLowerCase();
    span.setAttribute('gen_ai.response.finish_reasons', [finishReasonValue]);
  }
}

export interface TraceSendDataParams {
  /** The invocation context for the current agent run. */
  invocationContext: InvocationContext;
  /** The ID of the event. */
  eventId: string;
  /** A list of content objects. */
  data: Content[];
}

/**
 * Traces the sending of data to the agent.
 *
 * This function records details about the data sent to the agent as
 * attributes on the current OpenTelemetry span.
 *
 * @param params The parameters object containing invocationContext, eventId, and data.
 */
export function traceSendData({
  invocationContext,
  eventId,
  data,
}: TraceSendDataParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  
  span.setAttributes({
    'gcp.vertex.agent.invocation_id': invocationContext.invocationId,
    'gcp.vertex.agent.event_id': eventId,
  });

  // Once instrumentation is added to the GenAI SDK, consider whether this
  // information still needs to be recorded by the Agent Development Kit.

  span.setAttribute('gcp.vertex.agent.data', shouldAddRequestResponseToSpans()
    ? safeJsonSerialize(data)
    : '{}');
}

/**
 * Builds a dictionary representation of the LLM request for tracing.
 *
 * This function prepares a dictionary representation of the LlmRequest
 * object, suitable for inclusion in a trace. It excludes fields that cannot
 * be serialized (e.g., function pointers) and avoids sending bytes data.
 *
 * @param llmRequest The LlmRequest object.
 * @returns A dictionary representation of the LLM request.
 */
function buildLlmRequestForTrace(llmRequest: LlmRequest): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model: llmRequest.model,
    contents: [],
  };

  if (llmRequest.config) {
    // Create a clean config object, pruning responseSchema to reduce noise size
    const { responseSchema, ...cleanConfig } = llmRequest.config;
    result.config = cleanConfig;
  }

  // We do not want to send bytes data to the trace.
  result.contents = llmRequest.contents.map(content => ({
    role: content.role,
    parts: content.parts?.filter(part => !part.inlineData) || [],
  }));

  return result;
}

/**
 * Binds an async generator to OpenTelemetry context for trace propagation.
 * This is a temporary solution.	
 * @param ctx - The OpenTelemetry context to bind the generator to
 * @param generator - The async generator to be bound to the context
 * 
 * @returns A new async generator that executes all operations within the provided context
 */
export function bindAsyncGenerator<T = unknown, TReturn = any, TNext = unknown>(
  ctx: Context,
  generator: AsyncGenerator<T, TReturn, TNext>,
): AsyncGenerator<T, TReturn, TNext> {
  return {
    // Bind the next() method to execute within the provided context
    next: context.bind(ctx, generator.next.bind(generator)),
    
    // Bind the return() method to execute within the provided context
    return: context.bind(ctx, generator.return.bind(generator)),
    
    // Bind the throw() method to execute within the provided context
    throw: context.bind(ctx, generator.throw.bind(generator)),

    // Ensure the async iterator symbol also returns a context-bound generator
    [Symbol.asyncIterator]() {
      return bindAsyncGenerator(ctx, generator[Symbol.asyncIterator]());
    },
  };
}

/**
 * Determines whether to add request/response content to spans.
 * 
 * Defaults to true for now to preserve backward compatibility.
 * Once prompt and response logging is well established in ADK, we might start
 * a deprecation of request/response content in spans by switching the default
 * to false.
 * 
 * @returns false only when ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS is explicitly set to 'false' or '0'
 */
function shouldAddRequestResponseToSpans(): boolean {
  const envValue = process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS || 'true';
  return envValue === 'true' || envValue === '1';
}