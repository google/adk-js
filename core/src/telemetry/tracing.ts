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

import {Content, HttpOptions} from '@google/genai';
import {context, Context, trace} from '@opentelemetry/api';

import {BaseAgent} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BaseTool} from '../tools/base_tool.js';
import {version} from '../version.js';

/** OpenTelemetry GenAI semantic-convention span attribute keys. */
enum GenAiAttr {
  AGENT_DESCRIPTION = 'gen_ai.agent.description',
  AGENT_NAME = 'gen_ai.agent.name',
  CONVERSATION_ID = 'gen_ai.conversation.id',
  OPERATION_NAME = 'gen_ai.operation.name',
  SYSTEM = 'gen_ai.system',
  TOOL_CALL_ID = 'gen_ai.tool.call.id',
  TOOL_DESCRIPTION = 'gen_ai.tool.description',
  TOOL_NAME = 'gen_ai.tool.name',
  TOOL_TYPE = 'gen_ai.tool.type',
  REQUEST_MODEL = 'gen_ai.request.model',
  REQUEST_TOP_P = 'gen_ai.request.top_p',
  REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens',
  USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens',
  RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons',
}

/** ADK-specific workflow and node span attribute keys. */
enum AdkAttr {
  WORKFLOW_NAME = 'adk.workflow.name',
  NODE_PATH = 'adk.node.path',
  NODE_RUN_ID = 'adk.node.run_id',
  NODE_ATTEMPT = 'adk.node.attempt',
  NODE_STATUS = 'adk.node.status',
  NODE_INTERRUPT_COUNT = 'adk.node.interrupt_count',
}

/** GCP Vertex agent span attribute keys, consumed by the Vertex trace UI. */
enum GcpAttr {
  INVOCATION_ID = 'gcp.vertex.agent.invocation_id',
  SESSION_ID = 'gcp.vertex.agent.session_id',
  EVENT_ID = 'gcp.vertex.agent.event_id',
  LLM_REQUEST = 'gcp.vertex.agent.llm_request',
  LLM_RESPONSE = 'gcp.vertex.agent.llm_response',
  TOOL_CALL_ARGS = 'gcp.vertex.agent.tool_call_args',
  TOOL_RESPONSE = 'gcp.vertex.agent.tool_response',
  DATA = 'gcp.vertex.agent.data',
}

/** `gen_ai.system` value identifying the ADK on Vertex as the emitter. */
const GEN_AI_SYSTEM_VALUE = 'gcp.vertex.agent';

export const tracer = trace.getTracer(GEN_AI_SYSTEM_VALUE, version);

/**
 * Convert any JavaScript object to a JSON-serializable string.
 *
 * @param obj The object to serialize.
 * @returns The JSON-serialized object string or '<not serializable>' if the object cannot be serialized.
 */
function safeJsonSerialize(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch (_e: unknown) {
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
    [GenAiAttr.OPERATION_NAME]: 'invoke_agent',
    // Conditionally Required
    [GenAiAttr.AGENT_DESCRIPTION]: agent.description,
    [GenAiAttr.AGENT_NAME]: agent.name,
    [GenAiAttr.CONVERSATION_ID]: invocationContext.session.id,
  });
}

export interface TraceWorkflowInvocationParams {
  workflowName: string;
  nodePath: string;
  sessionId: string;
}

export function traceWorkflowInvocation({
  workflowName,
  nodePath,
  sessionId,
}: TraceWorkflowInvocationParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'invoke_workflow',
    [GenAiAttr.CONVERSATION_ID]: sessionId,
    [AdkAttr.WORKFLOW_NAME]: workflowName,
    [AdkAttr.NODE_PATH]: nodePath,
  });
}

export type NodeExecutionStatus = 'completed' | 'waiting' | 'failed';

export interface TraceNodeExecutionParams {
  nodePath: string;
  runId: string;
  attempt: number;
  status: NodeExecutionStatus;
  interruptCount: number;
}

export function traceNodeExecution({
  nodePath,
  runId,
  attempt,
  status,
  interruptCount,
}: TraceNodeExecutionParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'execute_node',
    [AdkAttr.NODE_PATH]: nodePath,
    [AdkAttr.NODE_RUN_ID]: runId,
    [AdkAttr.NODE_ATTEMPT]: attempt,
    [AdkAttr.NODE_STATUS]: status,
    [AdkAttr.NODE_INTERRUPT_COUNT]: interruptCount,
  });
}

export interface TraceToolCallParams {
  tool: BaseTool;
  args: Record<string, unknown>;
  functionResponseEvent: Event;
  invocationContext: InvocationContext;
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
  invocationContext,
}: TraceToolCallParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'execute_tool',
    [GenAiAttr.SYSTEM]: GEN_AI_SYSTEM_VALUE,
    [GenAiAttr.TOOL_DESCRIPTION]: tool.description || '',
    [GenAiAttr.TOOL_NAME]: tool.name,
    // e.g. FunctionTool
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
    toolResponse = {result: toolResponse};
  }

  span.setAttributes({
    [GenAiAttr.TOOL_CALL_ID]: toolCallId,
    [GcpAttr.EVENT_ID]: functionResponseEvent.id,
    [GcpAttr.TOOL_RESPONSE]: shouldAddRequestResponseToSpans()
      ? safeJsonSerialize(toolResponse)
      : '{}',
  });
}

export interface TraceMergedToolCallsParams {
  responseEventId: string;
  functionResponseEvent: Event;
  invocationContext: InvocationContext;
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
  invocationContext,
}: TraceMergedToolCallsParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  span.setAttributes({
    [GenAiAttr.OPERATION_NAME]: 'execute_tool',
    [GenAiAttr.SYSTEM]: GEN_AI_SYSTEM_VALUE,
    [GenAiAttr.TOOL_NAME]: '(merged tools)',
    [GenAiAttr.TOOL_DESCRIPTION]: '(merged tools)',
    [GenAiAttr.TOOL_CALL_ID]: responseEventId,
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    [GcpAttr.TOOL_CALL_ARGS]: 'N/A',
    [GcpAttr.EVENT_ID]: responseEventId,
    // Setting empty llm request and response (as UI expect these) while not
    // applicable for tool_response.
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
    [GenAiAttr.SYSTEM]: GEN_AI_SYSTEM_VALUE,
    [GenAiAttr.REQUEST_MODEL]: llmRequest.model,
    ...(invocationContext.agent?.name
      ? {[GenAiAttr.AGENT_NAME]: invocationContext.agent.name}
      : {}),
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    [GcpAttr.SESSION_ID]: invocationContext.session.id,
    [GcpAttr.EVENT_ID]: eventId,
    // Consider removing once GenAI SDK provides a way to record this info.
    [GcpAttr.LLM_REQUEST]: shouldAddRequestResponseToSpans()
      ? safeJsonSerialize(buildLlmRequestForTrace(llmRequest))
      : '{}',
  });

  // Consider removing once GenAI SDK provides a way to record this info.
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
    // Convert enum to lowercase string array
    const finishReasonValue =
      typeof llmResponse.finishReason === 'string'
        ? llmResponse.finishReason.toLowerCase()
        : String(llmResponse.finishReason).toLowerCase();
    span.setAttribute(GenAiAttr.RESPONSE_FINISH_REASONS, [finishReasonValue]);
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
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    [GcpAttr.EVENT_ID]: eventId,
  });

  // Once instrumentation is added to the GenAI SDK, consider whether this
  // information still needs to be recorded by the Agent Development Kit.

  span.setAttribute(
    GcpAttr.DATA,
    shouldAddRequestResponseToSpans() ? safeJsonSerialize(data) : '{}',
  );
}

/**
 * Returns a copy of the HTTP options without the caller-supplied fields that
 * can carry credentials.
 *
 * `headers` commonly holds an Authorization bearer token and `extraBody` is a
 * free-form request-body passthrough, so neither may reach an exported span
 * attribute. The remaining fields are useful for debugging and stay.
 *
 * @param httpOptions The HTTP options taken from the request config.
 * @returns A new HttpOptions object without `headers` and `extraBody`.
 */
function redactHttpOptions(httpOptions: HttpOptions): HttpOptions {
  const redacted: HttpOptions = {...httpOptions};
  delete redacted.headers;
  delete redacted.extraBody;
  return redacted;
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
function buildLlmRequestForTrace(
  llmRequest: LlmRequest,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model: llmRequest.model,
    contents: [],
  };

  if (llmRequest.config) {
    // Create a clean config object, pruning responseSchema to reduce noise size
    const {responseSchema: _responseSchema, ...cleanConfig} = llmRequest.config;
    if (cleanConfig.httpOptions) {
      cleanConfig.httpOptions = redactHttpOptions(cleanConfig.httpOptions);
    }
    result.config = cleanConfig;
  }

  // We do not want to send bytes data to the trace.
  result.contents = llmRequest.contents.map((content) => ({
    role: content.role,
    parts: content.parts?.filter((part) => !part.inlineData) || [],
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
function bindOtelContextToAsyncGenerator<T>(
  ctx: Context,
  generator: AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  return {
    // Bind the next() method to execute within the provided context
    next: context.bind(ctx, generator.next.bind(generator)),

    // Bind the return() method to execute within the provided context
    return: context.bind(ctx, generator.return.bind(generator)),

    // Bind the throw() method to execute within the provided context
    throw: context.bind(ctx, generator.throw.bind(generator)),

    // Ensure the async iterator symbol also returns a context-bound generator
    [Symbol.asyncIterator]() {
      return bindOtelContextToAsyncGenerator(
        ctx,
        generator[Symbol.asyncIterator](),
      );
    },
  };
}

/**
 * Runs an async generator function with both OTEL context and JavaScript 'this' context.
 *
 * @param otelContext - The OpenTelemetry context to bind the generator to
 * @param generatorFnContext - The 'this' context to bind to the generator function
 * @param generatorFn - The generator function to execute
 *
 * @returns A new async generator that executes within both contexts
 */
export function runAsyncGeneratorWithOtelContext<TThis, T>(
  otelContext: Context,
  generatorFnContext: TThis,
  generatorFn: (this: TThis) => AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  const generator = generatorFn.call(generatorFnContext);
  return bindOtelContextToAsyncGenerator(otelContext, generator);
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
