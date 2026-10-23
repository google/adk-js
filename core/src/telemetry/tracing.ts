/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTelemetry tracing and GenAI inference logging for ADK.
 *
 * Records framework spans (`invocation`, `invoke_agent`, `call_llm`,
 * `generate_content`, `execute_tool`, `send_data`, workflow/node spans) and
 * emits OpenTelemetry GenAI inference log records into the application's
 * registered `LoggerProvider`.
 */

import {
  ApiError,
  Content,
  ContentUnion,
  FinishReason,
  GenerateContentResponseUsageMetadata,
  HttpOptions,
  Part,
  PartUnion,
  Tool,
} from '@google/genai';
import {
  context,
  Context,
  createContextKey,
  Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  type AnyValue,
  type AnyValueMap,
  type LogAttributes,
  type LogRecord,
  logs,
} from '@opentelemetry/api-logs';

import type {BaseAgent} from '../agents/base_agent.js';
import type {InvocationContext} from '../agents/invocation_context.js';
import type {Event} from '../events/event.js';
import {isBaseLlm} from '../models/base_llm.js';
import type {LlmRequest} from '../models/llm_request.js';
import type {LlmResponse} from '../models/llm_response.js';
import type {BaseTool} from '../tools/base_tool.js';
import {isEnterpriseModeEnabled} from '../utils/env_aware_utils.js';
import {extractModelName, isGeminiModel} from '../utils/model_name.js';
import {version} from '../version.js';

import {readEnvVar} from './env.js';
import {
  effectiveRunTelemetryConfig,
  type RunTelemetryConfig,
} from './telemetry_context.js';

/** OpenTelemetry GenAI semantic-convention span and log attribute keys. */
enum GenAiAttr {
  AGENT_DESCRIPTION = 'gen_ai.agent.description',
  AGENT_NAME = 'gen_ai.agent.name',
  CONVERSATION_ID = 'gen_ai.conversation.id',
  OPERATION_NAME = 'gen_ai.operation.name',
  PROVIDER_NAME = 'gen_ai.provider.name',
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
  USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens',
  USAGE_REASONING_OUTPUT_TOKENS = 'gen_ai.usage.reasoning.output_tokens',
  RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons',
  INPUT_MESSAGES = 'gen_ai.input.messages',
  OUTPUT_MESSAGES = 'gen_ai.output.messages',
  SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions',
  TOOL_DEFINITIONS = 'gen_ai.tool.definitions',
  USER_ID = 'user.id',
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

/** OpenTelemetry semantic-convention schema URL used for ADK log records. */
const OTEL_SEMCONV_SCHEMA_URL = 'https://opentelemetry.io/schemas/1.36.0';

/** Stable OpenTelemetry GenAI event names. */
const GEN_AI_SYSTEM_MESSAGE_EVENT = 'gen_ai.system.message';
const GEN_AI_USER_MESSAGE_EVENT = 'gen_ai.user.message';
const GEN_AI_CHOICE_EVENT = 'gen_ai.choice';

/** Experimental OpenTelemetry GenAI completion-details event name. */
const COMPLETION_DETAILS_EVENT_NAME =
  'gen_ai.client.inference.operation.details';

/** Placeholder emitted when message content capture is disabled. */
export const USER_CONTENT_ELIDED = '<elided>';

export const tracer = trace.getTracer(GEN_AI_SYSTEM_VALUE, version);
export const otelLogger = logs.getLogger(GEN_AI_SYSTEM_VALUE, version, {
  schemaUrl: OTEL_SEMCONV_SCHEMA_URL,
});

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

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

/**
 * Converts a JavaScript value into a compact JSON string without extra whitespace.
 *
 * @param obj The value to serialize.
 * @returns Compact JSON string or `'<not serializable>'` when serialization fails.
 */
function safeJsonSerializeNoWhitespaces(obj: unknown): string {
  try {
    const serialized = JSON.stringify(obj, (_key, value: unknown) => {
      if (value instanceof Uint8Array) {
        return uint8ArrayToBase64(value);
      }
      return value;
    });
    return serialized ?? '<not serializable>';
  } catch {
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
  functionResponseEvent?: Event;
  /** The exception raised while executing the tool, if any. */
  error?: unknown;
  /** An error type reported by a tool response instead of a thrown error. */
  errorType?: string;
  /** The tool execution span. Defaults to the active span when omitted. */
  span?: Span;
  invocationContext: InvocationContext;
}

/**
 * Resolves a stable error classification suitable for the OpenTelemetry
 * `error.type` attribute without using the potentially sensitive error message.
 *
 * @param error The thrown value.
 * @returns The explicit ADK error type, GenAI API status, or error class name.
 */
export function resolveErrorType(error: unknown): string {
  if (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function')
  ) {
    try {
      const errorObject = error as {
        errorType?: unknown;
        error_type?: unknown;
        constructor?: {name?: unknown};
      };
      const customErrorType = errorObject.errorType ?? errorObject.error_type;
      if (
        typeof customErrorType === 'string' ||
        typeof customErrorType === 'number'
      ) {
        return String(customErrorType);
      }
      if (error instanceof ApiError) {
        return String(error.status);
      }
      const constructorName = errorObject.constructor?.name;
      if (typeof constructorName === 'string' && constructorName.length > 0) {
        return constructorName;
      }
    } catch {
      // A hostile thrown object (for example, a Proxy with throwing getters)
      // must not replace the original tool error with a telemetry error.
    }
  }

  return typeof error;
}

/**
 * Traces tool call.
 *
 * @param params The parameters object containing tool, args, and function response event.
 */
export function traceToolCall(params: TraceToolCallParams): void {
  const {
    tool,
    args,
    functionResponseEvent,
    invocationContext,
    error,
    errorType,
  } = params;
  const span = params.span ?? trace.getActiveSpan();
  if (!span) return;

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
    span.setAttribute('error.type', failureType);
    // Do not use an exception or tool response message here: those may contain
    // user data or credentials and are not covered by the content capture gate.
    span.setStatus({code: SpanStatusCode.ERROR, message: failureType});
  }

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
  const envValue = readEnvVar('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS') || 'true';
  return envValue === 'true' || envValue === '1';
}

const ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN =
  'ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN';
const OTEL_SEMCONV_STABILITY_OPT_IN = 'OTEL_SEMCONV_STABILITY_OPT_IN';
const GEN_AI_LATEST_EXPERIMENTAL = 'gen_ai_latest_experimental';
const OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';

/** Controls where GenAI message content is captured in telemetry. */
export enum ContentCapturingMode {
  NO_CONTENT = 'NO_CONTENT',
  EVENT_ONLY = 'EVENT_ONLY',
  SPAN_ONLY = 'SPAN_ONLY',
  SPAN_AND_EVENT = 'SPAN_AND_EVENT',
}

/**
 * Resolves the active ADK telemetry schema version from the environment.
 *
 * Schema v2 (experimental GenAI semconv) is the default. Setting
 * `ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN` to `'1'` or `'otel_semconv_1_36'`
 * selects schema v1 (stable GenAI semconv).
 */
export function resolveSchemaVersion(): number {
  const raw = readEnvVar(ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN)
    ?.trim()
    .toLowerCase();
  if (raw === '1' || raw === 'otel_semconv_1_36') {
    return 1;
  }
  return 2;
}

/**
 * Returns true when experimental GenAI semantic conventions are active.
 *
 * Experimental semconv is used when `OTEL_SEMCONV_STABILITY_OPT_IN` includes
 * `gen_ai_latest_experimental` or when `resolveSchemaVersion()` is at least 2.
 */
export function shouldUseExperimentalGenAiSemconv(): boolean {
  const optIn = readEnvVar(OTEL_SEMCONV_STABILITY_OPT_IN) ?? '';
  const entries = optIn
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.includes(GEN_AI_LATEST_EXPERIMENTAL)) {
    return true;
  }
  return resolveSchemaVersion() >= 2;
}

/**
 * Resolves the `ContentCapturingMode` from
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
 */
export function getContentCapturingMode(): ContentCapturingMode {
  const raw = readEnvVar(
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT,
  )?.trim();
  if (!raw) {
    return ContentCapturingMode.NO_CONTENT;
  }
  const normalized = raw.toUpperCase();
  if (normalized === 'TRUE' || normalized === '1') {
    return ContentCapturingMode.EVENT_ONLY;
  }
  switch (normalized) {
    case ContentCapturingMode.NO_CONTENT:
      return ContentCapturingMode.NO_CONTENT;
    case ContentCapturingMode.EVENT_ONLY:
      return ContentCapturingMode.EVENT_ONLY;
    case ContentCapturingMode.SPAN_ONLY:
      return ContentCapturingMode.SPAN_ONLY;
    case ContentCapturingMode.SPAN_AND_EVENT:
      return ContentCapturingMode.SPAN_AND_EVENT;
    default:
      return ContentCapturingMode.NO_CONTENT;
  }
}

/** Resolved per-call telemetry configuration. */
export interface TelemetryConfig {
  readonly schemaVersion: number;
  readonly shouldUseExperimentalGenAiSemconv: boolean;
  readonly captureMessageContent: ContentCapturingMode;
  readonly shouldAddContentToLogs: boolean;
  readonly shouldAddContentToExperimentalSpans: boolean;
}

/**
 * Builds a `TelemetryConfig` snapshot from the current environment and the
 * optional per-run overrides.
 *
 * For the semantic-convention and content-capture decisions the admin lock
 * `ADK_TELEMETRY_IGNORE_RUN_CONFIG` wins first, then the per-run value, then
 * the environment. The schema version always comes from the environment.
 *
 * @param overrides The per-run overrides, usually `RunConfig.telemetry`.
 */
export function getTelemetryConfig(
  overrides?: RunTelemetryConfig,
): TelemetryConfig {
  const runOverrides = effectiveRunTelemetryConfig(overrides);
  const schemaVersion = resolveSchemaVersion();
  const semconvOptIn = runOverrides?.genaiSemconvStabilityOptIn;
  const experimental =
    semconvOptIn === undefined
      ? shouldUseExperimentalGenAiSemconv()
      : semconvOptIn === 'experimental';
  const captureMessageContent =
    runOverrides?.captureMessageContent ?? getContentCapturingMode();
  return {
    schemaVersion,
    shouldUseExperimentalGenAiSemconv: experimental,
    captureMessageContent,
    shouldAddContentToLogs:
      captureMessageContent === ContentCapturingMode.EVENT_ONLY ||
      captureMessageContent === ContentCapturingMode.SPAN_AND_EVENT,
    shouldAddContentToExperimentalSpans:
      captureMessageContent === ContentCapturingMode.SPAN_ONLY ||
      captureMessageContent === ContentCapturingMode.SPAN_AND_EVENT,
  };
}

const RESOURCE_COLLECTION_SEGMENTS = new Set([
  'endpoints',
  'locations',
  'models',
  'projects',
  'publishers',
  'tunedmodels',
]);

const PROVIDER_NAME_BY_SYSTEM_NAME: Readonly<Record<string, string>> = {
  gemini: 'gcp.gemini',
  vertex_ai: 'gcp.vertex_ai',
};

/**
 * Returns the default Gemini deployment system name (`'vertex_ai'` when
 * enterprise/Vertex mode is enabled, otherwise `'gemini'`).
 */
export function guessGeminiSystemName(): string {
  if (typeof process === 'undefined' || !process.env) {
    return 'gemini';
  }
  return isEnterpriseModeEnabled() ? 'vertex_ai' : 'gemini';
}

/**
 * Resolves the OpenTelemetry `gen_ai.system` value for a model identifier.
 *
 * @param model The model identifier being served, if known.
 */
export function resolveGenAiSystemName(model?: string): string {
  if (!model || isGeminiModel(model)) {
    return guessGeminiSystemName();
  }

  const modelName = extractModelName(model);
  if (/^claude[-.]/i.test(modelName)) {
    return 'anthropic';
  }

  const slashIndex = modelName.indexOf('/');
  if (slashIndex !== -1) {
    const provider = modelName.slice(0, slashIndex).toLowerCase();
    if (provider && !RESOURCE_COLLECTION_SEGMENTS.has(provider)) {
      return provider;
    }
  }

  return guessGeminiSystemName();
}

/**
 * Resolves the OpenTelemetry `gen_ai.provider.name` value for a model identifier.
 *
 * @param model The model identifier being served, if known.
 */
export function resolveGenAiProviderName(model?: string): string {
  const system = resolveGenAiSystemName(model);
  return PROVIDER_NAME_BY_SYSTEM_NAME[system] ?? system;
}

function extractAgentModelString(
  agent: BaseAgent | undefined,
): string | undefined {
  let current: BaseAgent | undefined = agent;
  while (current) {
    if ('model' in current) {
      const candidateModel = (current as {model?: unknown}).model;
      if (typeof candidateModel === 'string' && candidateModel) {
        return candidateModel;
      }
      if (isBaseLlm(candidateModel) && candidateModel.model) {
        return candidateModel.model;
      }
    }
    current = current.parentAgent;
  }
  return undefined;
}

/**
 * Resolves the `gen_ai.system` name for an inference response, preferring
 * `llmResponse.modelVersion` and falling back to the agent's configured model.
 */
export function resolveInferenceSystemName(
  invocationContext: InvocationContext | undefined,
  llmResponse: LlmResponse,
): string {
  const model =
    llmResponse.modelVersion ||
    extractAgentModelString(invocationContext?.agent);
  return resolveGenAiSystemName(model);
}

/**
 * Returns true when `finishReason` is a non-empty, specified finish reason.
 */
export function isReportedFinishReason(
  finishReason?: FinishReason | string,
): finishReason is FinishReason {
  return Boolean(
    finishReason && finishReason !== FinishReason.FINISH_REASON_UNSPECIFIED,
  );
}

/**
 * Computes OpenTelemetry token usage attributes from `usageMetadata`.
 */
function computeUsageAttributes(
  usageMetadata?: GenerateContentResponseUsageMetadata,
): Record<string, number> {
  if (!usageMetadata) {
    return {};
  }
  const attributes: Record<string, number> = {};
  const promptTokens = usageMetadata.promptTokenCount;
  const toolUseTokens = usageMetadata.toolUsePromptTokenCount;
  if (promptTokens !== undefined || toolUseTokens !== undefined) {
    attributes[GenAiAttr.USAGE_INPUT_TOKENS] =
      (promptTokens ?? 0) + (toolUseTokens ?? 0);
  }

  const candidatesTokens = usageMetadata.candidatesTokenCount;
  const thoughtsTokens = usageMetadata.thoughtsTokenCount;
  if (candidatesTokens !== undefined || thoughtsTokens !== undefined) {
    attributes[GenAiAttr.USAGE_OUTPUT_TOKENS] =
      (candidatesTokens ?? 0) + (thoughtsTokens ?? 0);
  }

  if (usageMetadata.cachedContentTokenCount !== undefined) {
    attributes[GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS] =
      usageMetadata.cachedContentTokenCount;
  }

  if (thoughtsTokens !== undefined) {
    attributes[GenAiAttr.USAGE_REASONING_OUTPUT_TOKENS] = thoughtsTokens;
  }

  return attributes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function camelToSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toAnyValue(value: unknown, seen = new Set<unknown>()): AnyValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value !== 'object') {
    return '<not serializable>';
  }
  if (seen.has(value)) {
    return '<not serializable>';
  }
  const nextSeen = new Set(seen);
  nextSeen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => toAnyValue(item, nextSeen));
  }
  if (isPlainObject(value)) {
    const out: AnyValueMap = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) {
        out[k] = toAnyValue(v, nextSeen);
      }
    }
    return out;
  }
  return '<not serializable>';
}

function toOptionalMapping(value: unknown): AnyValueMap | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = toAnyValue(value);
  if (isPlainObject(normalized)) {
    return normalized as AnyValueMap;
  }
  return {value: normalized};
}

function convertPartSubObject(
  obj: Record<string, unknown>,
  preserveNestedKeys: ReadonlySet<string> = new Set(),
): AnyValueMap {
  const result: AnyValueMap = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) {
      continue;
    }
    const snakeKey = camelToSnakeCase(key);
    if (preserveNestedKeys.has(key)) {
      result[snakeKey] = toAnyValue(val);
    } else if (isPlainObject(val)) {
      result[snakeKey] = convertPartSubObject(val);
    } else {
      result[snakeKey] = toAnyValue(val);
    }
  }
  return result;
}

/**
 * Serializes a single `@google/genai` `Part` into a plain telemetry dictionary
 * with snake_case keys matching the GenAI schema.
 */
function dumpPartForTelemetry(part: Part): AnyValueMap {
  const dumped: AnyValueMap = {};
  for (const [key, val] of Object.entries(part as Record<string, unknown>)) {
    if (val === undefined || val === null) {
      continue;
    }
    const snakeKey = camelToSnakeCase(key);
    if (key === 'functionCall' && isPlainObject(val)) {
      dumped[snakeKey] = convertPartSubObject(val, new Set(['args']));
    } else if (key === 'functionResponse' && isPlainObject(val)) {
      dumped[snakeKey] = convertPartSubObject(val, new Set(['response']));
    } else if (isPlainObject(val)) {
      dumped[snakeKey] = convertPartSubObject(val);
    } else {
      dumped[snakeKey] = toAnyValue(val);
    }
  }
  return dumped;
}

/**
 * Serializes a `@google/genai` `Content` into a plain telemetry dictionary.
 */
function dumpContentForTelemetry(content: Content): AnyValueMap {
  const dumped: AnyValueMap = {};
  if (content.role !== undefined && content.role !== null) {
    dumped.role = content.role;
  }
  if (content.parts !== undefined && content.parts !== null) {
    dumped.parts = content.parts.map((part) => dumpPartForTelemetry(part));
  }
  return dumped;
}

function normalizeToParts(value: ContentUnion): Part[] {
  if (typeof value === 'string') {
    return [{text: value}];
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'string' ? {text: item} : item,
    );
  }
  if (isPlainObject(value) && 'parts' in value) {
    const content = value as Content;
    return content.parts ?? [];
  }
  return [value as Part];
}

function serializeContent(content: ContentUnion | undefined | null): AnyValue {
  if (content === undefined || content === null) {
    return null;
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => serializeContent(item));
  }
  if (isPlainObject(content)) {
    if ('parts' in content || 'role' in content) {
      return dumpContentForTelemetry(content as Content);
    }
    return dumpPartForTelemetry(content as Part);
  }
  return safeJsonSerialize(content);
}

function serializeContentWithOptionalElision(
  content: ContentUnion | undefined | null,
  captureContent: boolean,
): AnyValue {
  if (!captureContent) {
    return USER_CONTENT_ELIDED;
  }
  if (content === undefined || content === null) {
    return null;
  }
  return serializeContent(content);
}

/**
 * Builds the log body for a stable `gen_ai.system.message` event.
 */
export function systemMessageBody(
  llmRequest: LlmRequest,
  telemetryConfig: TelemetryConfig = getTelemetryConfig(),
): AnyValueMap {
  return {
    content: serializeContentWithOptionalElision(
      llmRequest.config?.systemInstruction,
      telemetryConfig.shouldAddContentToLogs,
    ),
  };
}

/**
 * Builds the log body for a stable `gen_ai.user.message` event.
 */
export function userMessageBody(
  content: ContentUnion | undefined | null,
  telemetryConfig: TelemetryConfig = getTelemetryConfig(),
): AnyValueMap {
  return {
    content: serializeContentWithOptionalElision(
      content,
      telemetryConfig.shouldAddContentToLogs,
    ),
  };
}

/**
 * Builds the log body for a stable `gen_ai.choice` event.
 */
export function choiceBody(
  llmResponse: LlmResponse | undefined | null,
  telemetryConfig: TelemetryConfig = getTelemetryConfig(),
): AnyValueMap {
  if (!llmResponse) {
    return {content: null, index: 0};
  }
  const body: AnyValueMap = {
    content: serializeContentWithOptionalElision(
      llmResponse.content,
      telemetryConfig.shouldAddContentToLogs,
    ),
    index: 0,
  };
  if (isReportedFinishReason(llmResponse.finishReason)) {
    body.finish_reason = llmResponse.finishReason;
  }
  return body;
}

/**
 * Maps a `@google/genai` `FinishReason` to its experimental GenAI semconv string.
 */
export function toFinishReason(finishReason?: FinishReason | string): string {
  if (!isReportedFinishReason(finishReason)) {
    return '';
  }
  if (finishReason === FinishReason.OTHER) {
    return 'error';
  }
  if (finishReason === FinishReason.STOP) {
    return 'stop';
  }
  if (finishReason === FinishReason.MAX_TOKENS) {
    return 'length';
  }
  return String(finishReason).toLowerCase();
}

function fallbackToolCallId(name: string | undefined, idx: number): string {
  if (name) {
    return `${name}_${idx}`;
  }
  return `${idx}`;
}

/**
 * Converts a `@google/genai` `Part` into its experimental GenAI semconv part
 * representation.
 */
export function toPart(
  part: Part | undefined | null,
  idx = 0,
): AnyValueMap | undefined {
  if (!part) {
    return undefined;
  }

  if (part.text !== undefined && part.text !== null) {
    return {
      content: part.text,
      type: 'text',
    };
  }

  if (part.inlineData) {
    return {
      mime_type: part.inlineData.mimeType ?? '',
      data: part.inlineData.data ?? '',
      type: 'blob',
    };
  }

  if (part.fileData) {
    return {
      mime_type: part.fileData.mimeType ?? '',
      uri: part.fileData.fileUri ?? '',
      type: 'file_data',
    };
  }

  if (part.functionCall) {
    const call = part.functionCall;
    return {
      id: call.id ? call.id : fallbackToolCallId(call.name, idx),
      name: call.name ?? '',
      arguments: toOptionalMapping(call.args),
      type: 'tool_call',
    };
  }

  if (part.functionResponse) {
    const response = part.functionResponse;
    return {
      id: response.id ? response.id : fallbackToolCallId(response.name, idx),
      response: toOptionalMapping(response.response),
      type: 'tool_call_response',
    };
  }

  return undefined;
}

function toRole(role?: string | null): string {
  if (role === 'user') {
    return 'user';
  }
  if (role === 'model') {
    return 'assistant';
  }
  return '';
}

/**
 * Converts `systemInstruction` into an array of experimental GenAI semconv parts.
 */
export function toSystemInstructions(
  systemInstruction: ContentUnion | undefined,
): AnyValueMap[] {
  if (systemInstruction === undefined || systemInstruction === null) {
    return [];
  }
  const rawParts: PartUnion[] = normalizeToParts(systemInstruction);
  const converted: AnyValueMap[] = [];
  for (let idx = 0; idx < rawParts.length; idx++) {
    const rawPart = rawParts[idx];
    const partObj: Part =
      typeof rawPart === 'string' ? {text: rawPart} : rawPart;
    const mapped = toPart(partObj, idx);
    if (mapped) {
      converted.push(mapped);
    }
  }
  return converted;
}

/**
 * Converts a `@google/genai` `Content` entry into an experimental GenAI semconv
 * input message.
 */
export function toInputMessage(content: Content): AnyValueMap {
  const rawParts = content.parts ?? [];
  const parts: AnyValueMap[] = [];
  for (let idx = 0; idx < rawParts.length; idx++) {
    const mapped = toPart(rawParts[idx], idx);
    if (mapped) {
      parts.push(mapped);
    }
  }
  return {
    role: toRole(content.role),
    parts,
  };
}

/**
 * Converts an `LlmResponse` into an experimental GenAI semconv output message,
 * or `undefined` when the response carries no `content`.
 */
export function toOutputMessage(
  llmResponse: LlmResponse,
): AnyValueMap | undefined {
  if (!llmResponse.content) {
    return undefined;
  }
  const message = toInputMessage(llmResponse.content);
  return {
    role: message.role,
    parts: message.parts,
    finish_reason: toFinishReason(llmResponse.finishReason),
  };
}

const NON_FUNCTION_TOOL_KEYS = [
  'googleSearch',
  'google_search',
  'googleSearchRetrieval',
  'google_search_retrieval',
  'retrieval',
  'codeExecution',
  'code_execution',
  'enterpriseWebSearch',
  'enterprise_web_search',
  'googleMaps',
  'google_maps',
  'urlContext',
  'url_context',
  'computerUse',
  'computer_use',
  'fileSearch',
  'file_search',
] as const;

function cleanParameters(params: unknown): AnyValueMap | null {
  if (params === undefined || params === null) {
    return null;
  }
  const normalized = toAnyValue(params);
  if (isPlainObject(normalized)) {
    return normalized as AnyValueMap;
  }
  return {
    type: 'object',
    properties: {
      serialization_error: {
        type: 'string',
        description: `Expected a mapping for parameters, got ${typeof params}`,
      },
    },
  };
}

/**
 * Extracts experimental GenAI semconv tool definitions from `llmRequest.config.tools`.
 */
export function extractToolDefinitions(
  llmRequest: LlmRequest,
  shouldCaptureContent = true,
): AnyValueMap[] {
  const tools = llmRequest.config?.tools;
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const definitions: AnyValueMap[] = [];
  for (const toolEntry of tools) {
    if (!isPlainObject(toolEntry)) {
      continue;
    }
    const tool = toolEntry as Tool & Record<string, unknown>;
    if (Array.isArray(tool.functionDeclarations)) {
      for (const fd of tool.functionDeclarations) {
        if (!fd) {
          continue;
        }
        const rawParams = fd.parameters ?? fd.parametersJsonSchema;
        const definition: AnyValueMap = {
          type: 'function',
          name: fd.name ? fd.name : 'FunctionDeclaration',
          description:
            typeof fd.description === 'string' ? fd.description : null,
          parameters: shouldCaptureContent ? cleanParameters(rawParams) : null,
        };
        definitions.push(definition);
      }
    }

    const seenToolTypes = new Set<string>();
    for (const key of NON_FUNCTION_TOOL_KEYS) {
      if (tool[key] !== undefined && tool[key] !== null) {
        const snakeType = camelToSnakeCase(key);
        if (!seenToolTypes.has(snakeType)) {
          seenToolTypes.add(snakeType);
          definitions.push({
            name: snakeType,
            type: snakeType,
          });
        }
      }
    }
  }
  return definitions;
}

function operationDetailsAttributesNoContent(
  operationDetailsAttributes: Record<string, AnyValue>,
): Record<string, AnyValue> {
  const toolDefs = operationDetailsAttributes[GenAiAttr.TOOL_DEFINITIONS];
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) {
    return {};
  }
  const redacted: AnyValue[] = [];
  for (const def of toolDefs) {
    if (!isPlainObject(def)) {
      continue;
    }
    const name = def.name;
    const toolType = def.type;
    if (typeof name !== 'string' || typeof toolType !== 'string') {
      continue;
    }
    if ('parameters' in def) {
      redacted.push({
        name,
        description:
          typeof def.description === 'string' ? def.description : null,
        parameters: null,
        type: 'function',
      });
    } else {
      redacted.push({
        name,
        type: toolType,
      });
    }
  }
  if (redacted.length === 0) {
    return {};
  }
  return {
    [GenAiAttr.TOOL_DEFINITIONS]: redacted,
  };
}

/**
 * Populates request-derived experimental operation-details attributes.
 */
export function setOperationDetailsRequestAttributes(
  operationDetailsAttributes: Record<string, AnyValue>,
  llmRequest: LlmRequest,
  shouldCaptureContent = true,
): void {
  const inputMessages: AnyValueMap[] = [];
  for (const content of llmRequest.contents ?? []) {
    inputMessages.push(toInputMessage(content));
  }
  operationDetailsAttributes[GenAiAttr.INPUT_MESSAGES] = inputMessages;
  operationDetailsAttributes[GenAiAttr.SYSTEM_INSTRUCTIONS] =
    toSystemInstructions(llmRequest.config?.systemInstruction);
  operationDetailsAttributes[GenAiAttr.TOOL_DEFINITIONS] =
    extractToolDefinitions(llmRequest, shouldCaptureContent);
}

/**
 * Populates response-derived experimental operation-details attributes,
 * concatenating output messages across streamed chunks.
 */
export function setOperationDetailsResponseAttributes(
  llmResponse: LlmResponse,
  operationDetailsAttributes: Record<string, AnyValue>,
  operationDetailsCommonAttributes: Record<string, AnyValue>,
  _telemetryConfig?: TelemetryConfig,
): void {
  const finishReason = toFinishReason(llmResponse.finishReason);
  if (finishReason) {
    operationDetailsCommonAttributes[GenAiAttr.RESPONSE_FINISH_REASONS] = [
      finishReason,
    ];
  }
  const usageAttrs = computeUsageAttributes(llmResponse.usageMetadata);
  for (const [key, value] of Object.entries(usageAttrs)) {
    operationDetailsCommonAttributes[key] = value;
  }

  const outputMessage = toOutputMessage(llmResponse);
  if (outputMessage) {
    const existing = operationDetailsAttributes[GenAiAttr.OUTPUT_MESSAGES];
    if (Array.isArray(existing)) {
      operationDetailsAttributes[GenAiAttr.OUTPUT_MESSAGES] = [
        ...existing,
        outputMessage,
      ];
    } else {
      operationDetailsAttributes[GenAiAttr.OUTPUT_MESSAGES] = [outputMessage];
    }
  }
}

/**
 * Builds the log record attribute map for `gen_ai.client.inference.operation.details`.
 */
export function buildCompletionLogAttributes(
  telemetryConfig: TelemetryConfig,
  operationDetailsAttributes: Record<string, AnyValue>,
  operationDetailsCommonAttributes: Record<string, AnyValue>,
): LogAttributes {
  const common: LogAttributes = {...operationDetailsCommonAttributes};
  if (!telemetryConfig.shouldAddContentToLogs) {
    delete common[GenAiAttr.USER_ID];
    return {
      ...common,
      ...operationDetailsAttributesNoContent(operationDetailsAttributes),
    };
  }
  return {
    ...common,
    ...operationDetailsAttributes,
  };
}

/**
 * Builds the pre-serialized span attribute map for `generate_content` under
 * experimental semconv.
 */
export function buildCompletionSpanAttributes(
  telemetryConfig: TelemetryConfig,
  operationDetailsAttributes: Record<string, AnyValue>,
): Record<string, AnyValue> {
  if (telemetryConfig.shouldAddContentToExperimentalSpans) {
    return {...operationDetailsAttributes};
  }
  return operationDetailsAttributesNoContent(operationDetailsAttributes);
}

function emitLogRecord(record: LogRecord): void {
  try {
    otelLogger.emit(record);
  } catch {
    // A throwing exporter or log processor must never break an agent run.
  }
}

/**
 * Context key under which the completion-details log record carries its
 * {@link InferenceScope}. Keys are `Symbol.for` based, so two copies of the
 * package share it.
 */
export const INFERENCE_SCOPE_KEY = createContextKey('adk_inference_scope');

/**
 * What one model call collected, published on the context the
 * completion-details record is emitted under.
 *
 * It holds the message content whether or not content capture is on for
 * export, so a local consumer such as the dev server trace view can show it
 * without the exported record carrying it.
 */
export interface InferenceScope {
  /** Operation-details attributes with full content, keyed by attribute. */
  readonly contentAttributes: Readonly<Record<string, AnyValue>>;
  /** The user the model call ran for, if known. */
  readonly userId?: string;
}

/** Returns true when `value` has the shape of an {@link InferenceScope}. */
export function isInferenceScope(value: unknown): value is InferenceScope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (
    !('contentAttributes' in value) ||
    !isPlainObject(value.contentAttributes)
  ) {
    return false;
  }
  return (
    !('userId' in value) ||
    value.userId === undefined ||
    typeof value.userId === 'string'
  );
}

/** Returns the {@link InferenceScope} published on `otelContext`, if any. */
export function getInferenceScope(
  otelContext: Context | undefined,
): InferenceScope | undefined {
  const value = otelContext?.getValue(INFERENCE_SCOPE_KEY);
  return isInferenceScope(value) ? value : undefined;
}

/**
 * Holds state for an open `generate_content {model}` span and its accumulated
 * experimental semantic-convention attributes.
 */
export class GenerateContentSpan {
  readonly operationDetailsAttributes: Record<string, AnyValue> = {};
  readonly operationDetailsCommonAttributes: Record<string, AnyValue> = {};
  ended = false;

  constructor(readonly span: Span) {}
}

export interface StartInferenceSpanParams {
  llmRequest: LlmRequest;
  invocationContext: InvocationContext;
  modelResponseEvent?: Event;
}

/**
 * Opens a `generate_content {model}` span and records initial request
 * telemetry according to the active semantic-convention mode.
 */
export function startInferenceSpan({
  llmRequest,
  invocationContext,
  modelResponseEvent,
}: StartInferenceSpanParams): GenerateContentSpan {
  const modelName = llmRequest.model ?? '';
  const spanName = `generate_content ${modelName}`.trim();
  const span = tracer.startSpan(spanName);
  const gcSpan = new GenerateContentSpan(span);

  try {
    const spanContext = trace.setSpan(context.active(), span);
    const isSpanRecording = span.isRecording();
    const isLoggerEnabled = otelLogger.enabled({context: spanContext});
    if (!isSpanRecording && !isLoggerEnabled) {
      return gcSpan;
    }

    const telemetryConfig = getTelemetryConfig(
      invocationContext.runConfig?.telemetry,
    );
    const commonAttributes: Record<string, string> = {};
    if (invocationContext.agent?.name) {
      commonAttributes[GenAiAttr.AGENT_NAME] = invocationContext.agent.name;
    }
    if (invocationContext.session?.id) {
      commonAttributes[GenAiAttr.CONVERSATION_ID] =
        invocationContext.session.id;
    }
    if (modelResponseEvent?.id) {
      commonAttributes[GcpAttr.EVENT_ID] = modelResponseEvent.id;
    }
    if (invocationContext.invocationId) {
      commonAttributes[GcpAttr.INVOCATION_ID] = invocationContext.invocationId;
    }

    if (
      telemetryConfig.shouldUseExperimentalGenAiSemconv &&
      telemetryConfig.schemaVersion >= 2
    ) {
      commonAttributes[GenAiAttr.PROVIDER_NAME] = resolveGenAiProviderName(
        llmRequest.model,
      );
    }

    if (isSpanRecording) {
      if (!telemetryConfig.shouldUseExperimentalGenAiSemconv) {
        span.setAttribute(
          GenAiAttr.SYSTEM,
          resolveGenAiSystemName(llmRequest.model),
        );
      }

      span.setAttribute(GenAiAttr.OPERATION_NAME, 'generate_content');
      span.setAttribute(GenAiAttr.REQUEST_MODEL, modelName);
      if (
        llmRequest.config?.topP !== undefined &&
        llmRequest.config?.topP !== null
      ) {
        span.setAttribute(GenAiAttr.REQUEST_TOP_P, llmRequest.config.topP);
      }
      if (
        llmRequest.config?.maxOutputTokens !== undefined &&
        llmRequest.config?.maxOutputTokens !== null
      ) {
        span.setAttribute(
          GenAiAttr.REQUEST_MAX_TOKENS,
          llmRequest.config.maxOutputTokens,
        );
      }
      span.setAttributes(commonAttributes);
    }

    const userId = invocationContext.session?.userId;
    if (telemetryConfig.shouldUseExperimentalGenAiSemconv) {
      Object.assign(gcSpan.operationDetailsCommonAttributes, commonAttributes);
      if (telemetryConfig.shouldAddContentToLogs && userId) {
        gcSpan.operationDetailsCommonAttributes[GenAiAttr.USER_ID] = userId;
      }
      setOperationDetailsRequestAttributes(
        gcSpan.operationDetailsAttributes,
        llmRequest,
        true,
      );
    } else if (isLoggerEnabled) {
      const systemName = resolveGenAiSystemName(llmRequest.model);
      emitLogRecord({
        eventName: GEN_AI_SYSTEM_MESSAGE_EVENT,
        body: systemMessageBody(llmRequest, telemetryConfig),
        attributes: {[GenAiAttr.SYSTEM]: systemName},
        context: spanContext,
      });

      const userMessageAttributes: LogAttributes = {
        [GenAiAttr.SYSTEM]: systemName,
      };
      if (telemetryConfig.shouldAddContentToLogs && userId) {
        userMessageAttributes[GenAiAttr.USER_ID] = userId;
      }

      for (const content of llmRequest.contents ?? []) {
        emitLogRecord({
          eventName: GEN_AI_USER_MESSAGE_EVENT,
          body: userMessageBody(content, telemetryConfig),
          attributes: {...userMessageAttributes},
          context: spanContext,
        });
      }
    }
  } catch {
    // Telemetry errors must never break an agent run.
  }

  return gcSpan;
}

export interface TraceInferenceResultParams {
  invocationContext?: InvocationContext;
  generateContentSpan?: GenerateContentSpan;
  llmResponse: LlmResponse;
}

/**
 * Records a single model response on the open `generate_content` span and
 * either accumulates experimental operation details or emits a stable
 * `gen_ai.choice` log record.
 */
export function traceInferenceResult({
  invocationContext,
  generateContentSpan,
  llmResponse,
}: TraceInferenceResultParams): void {
  if (!generateContentSpan || generateContentSpan.ended) {
    return;
  }

  try {
    const {span} = generateContentSpan;
    const spanContext = trace.setSpan(context.active(), span);
    const isSpanRecording = span.isRecording();
    const isLoggerEnabled = otelLogger.enabled({context: spanContext});
    if (!isSpanRecording && !isLoggerEnabled) {
      return;
    }

    const telemetryConfig = getTelemetryConfig(
      invocationContext?.runConfig?.telemetry,
    );
    if (isSpanRecording) {
      if (isReportedFinishReason(llmResponse.finishReason)) {
        span.setAttribute(GenAiAttr.RESPONSE_FINISH_REASONS, [
          String(llmResponse.finishReason).toLowerCase(),
        ]);
      }

      const usageAttrs = computeUsageAttributes(llmResponse.usageMetadata);
      if (Object.keys(usageAttrs).length > 0) {
        span.setAttributes(usageAttrs);
      }
    }

    if (telemetryConfig.shouldUseExperimentalGenAiSemconv) {
      setOperationDetailsResponseAttributes(
        llmResponse,
        generateContentSpan.operationDetailsAttributes,
        generateContentSpan.operationDetailsCommonAttributes,
        telemetryConfig,
      );
    } else if (isLoggerEnabled) {
      emitLogRecord({
        eventName: GEN_AI_CHOICE_EVENT,
        body: choiceBody(llmResponse, telemetryConfig),
        attributes: {
          [GenAiAttr.SYSTEM]: resolveInferenceSystemName(
            invocationContext,
            llmResponse,
          ),
        },
        context: spanContext,
      });
    }
  } catch {
    // Telemetry errors must never break an agent run.
  }
}

export interface FinishInferenceSpanParams {
  generateContentSpan?: GenerateContentSpan;
  invocationContext?: InvocationContext;
  error?: unknown;
}

/**
 * Finalizes an open `generate_content` span, emitting the experimental
 * `gen_ai.client.inference.operation.details` log record while the span is
 * still open, recording any thrown error, and ending the span.
 */
export function finishInferenceSpan(params: FinishInferenceSpanParams): void {
  const {generateContentSpan, invocationContext, error} = params;
  if (!generateContentSpan || generateContentSpan.ended) {
    return;
  }
  generateContentSpan.ended = true;

  const {span} = generateContentSpan;

  try {
    const spanContext = trace.setSpan(context.active(), span);
    const isSpanRecording = span.isRecording();
    const isLoggerEnabled = otelLogger.enabled({context: spanContext});
    if (!isSpanRecording && !isLoggerEnabled) {
      return;
    }

    const telemetryConfig = getTelemetryConfig(
      invocationContext?.runConfig?.telemetry,
    );
    const hasError = Object.hasOwn(params, 'error') && error !== undefined;
    if (hasError && isSpanRecording) {
      const failureType = resolveErrorType(error);
      let exception: Error | string;
      try {
        exception = error instanceof Error ? error : failureType;
      } catch {
        exception = failureType;
      }
      span.recordException(exception);
      span.setAttribute('error.type', failureType);
      span.setStatus({code: SpanStatusCode.ERROR, message: failureType});
    }

    if (telemetryConfig.shouldUseExperimentalGenAiSemconv) {
      if (isSpanRecording) {
        const spanAttributes = buildCompletionSpanAttributes(
          telemetryConfig,
          generateContentSpan.operationDetailsAttributes,
        );
        for (const [key, value] of Object.entries(spanAttributes)) {
          span.setAttribute(key, safeJsonSerializeNoWhitespaces(value));
        }
      }

      if (isLoggerEnabled) {
        const userId = invocationContext?.session?.userId;
        if (telemetryConfig.shouldAddContentToLogs && userId) {
          generateContentSpan.operationDetailsCommonAttributes[
            GenAiAttr.USER_ID
          ] = userId;
        } else {
          delete generateContentSpan.operationDetailsCommonAttributes[
            GenAiAttr.USER_ID
          ];
        }

        const logAttributes = buildCompletionLogAttributes(
          telemetryConfig,
          generateContentSpan.operationDetailsAttributes,
          generateContentSpan.operationDetailsCommonAttributes,
        );
        const scope: InferenceScope = {
          contentAttributes: {
            ...generateContentSpan.operationDetailsAttributes,
          },
          userId,
        };
        emitLogRecord({
          eventName: COMPLETION_DETAILS_EVENT_NAME,
          attributes: logAttributes,
          context: spanContext.setValue(INFERENCE_SCOPE_KEY, scope),
        });
      }
    }
  } catch {
    // Telemetry errors must never break an agent run.
  } finally {
    span.end();
  }
}
