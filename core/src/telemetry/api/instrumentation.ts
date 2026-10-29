/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, GenerateContentResponseUsageMetadata} from '@google/genai';
import {
  type Attributes,
  context,
  type Context,
  createContextKey,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type {AnyValueMap} from '@opentelemetry/api-logs';

import type {BaseAgent} from '../../agents/base_agent.js';
import type {InvocationContext} from '../../agents/invocation_context.js';
import type {Event} from '../../events/event.js';
import type {LlmRequest} from '../../models/llm_request.js';
import type {LlmResponse} from '../../models/llm_response.js';
import type {ContextCompactionTrigger} from '../../plugins/base_plugin.js';
import type {Skill} from '../../skills/skill.js';
import type {BaseTool} from '../../tools/base_tool.js';
import {logger} from '../../utils/logger.js';
import type {BaseNode} from '../../workflow/base_node.js';

import {
  captureAccumulators,
  claimEntrypointWorkflowFrame,
  openAgentFrame,
  openWorkflowFrame,
} from './internal/common/accumulators.js';
import {
  GcpAttr,
  GenAiAttr,
  USER_ID_ATTR,
} from './internal/common/attributes.js';
import {
  readTelemetryConfig,
  shouldAddContentToLogs,
  type TelemetryConfig,
} from './internal/common/config.js';
import {
  getToolResponseErrorType,
  resolveErrorType,
} from './internal/common/error.js';
import {isReportedFinishReason} from './internal/common/finish_reason.js';
import {
  buildOutputMessage,
  buildRequestOperationDetails,
  type OperationDetails,
  withoutContent,
} from './internal/common/genai_messages.js';
import {resolveProviderName} from './internal/common/provider_name.js';
import {TokenUsage} from './internal/common/token_usage.js';
import {emitInferenceOperationDetails} from './internal/logs/inference.js';
import {recordAgentMetrics} from './internal/metrics/agent.js';
import {
  recordSkillLoad,
  recordSkillScriptExecution,
  recordToolMetrics,
} from './internal/metrics/tool.js';
import {recordWorkflowMetrics} from './internal/metrics/workflow.js';
import {buildAgentInvocationAttributes} from './internal/trace/agent.js';
import {
  buildCompactionResultAttributes,
  startCompactionSpan,
} from './internal/trace/compaction.js';
import {
  buildResponseAttributes,
  setInferenceOperationDetails,
  setInferenceResponseAttributes,
  startInferenceSpan,
} from './internal/trace/inference.js';
import {setSendDataAttributes} from './internal/trace/live.js';
import {
  hasOwnInvocationSpan,
  setAssociatedEventIds,
  startNodeSpan,
} from './internal/trace/node.js';
import {
  buildMergedToolCallsAttributes,
  buildToolCallAttributes,
  setSkillSpanAttributes,
  type SkillReport,
  type ToolCallOutcome,
} from './internal/trace/tool.js';
import {
  bindOtelContextToAsyncGenerator,
  getTracer,
  setSpanError,
} from './internal/trace/tracer.js';
import {startWorkflowSpan} from './internal/trace/workflow.js';

/** Returns the seconds elapsed since `startTime`, a `performance.now()`. */
function secondsSince(startTime: number): number {
  return (performance.now() - startTime) / 1000;
}

/**
 * Records metrics without letting a failure to record them fail the run, or
 * replace the error the run is already failing with.
 */
function recordMetricsSafely(record: () => void): void {
  try {
    record();
  } catch (error: unknown) {
    logger.warn(`Failed to record ADK metrics: ${resolveErrorType(error)}`);
  }
}

/** Wraps `end` so that only its first call has an effect. */
function once(end: (error?: unknown) => void): (error?: unknown) => void {
  let ended = false;
  return (error?: unknown): void => {
    if (ended) {
      return;
    }
    ended = true;
    end(error);
  };
}

/** A started scope whose work runs under `context`. */
interface StartedScope {
  readonly context: Context;
  /**
   * Ends the scope, as failed when `error` is given. Only the first call
   * counts.
   */
  end(error?: unknown): void;
}

/**
 * Drives a generator under a scope that `start` opens on the first pull, with
 * the scope's context bound to every step. The scope ends when the generator
 * finishes, with the error that escapes it, if any.
 */
function streamInScope<T>(
  start: () => StartedScope,
  createGenerator: () => AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  return (async function* () {
    const scope = start();
    try {
      yield* bindOtelContextToAsyncGenerator(
        scope.context,
        context.with(scope.context, createGenerator),
      );
    } catch (error: unknown) {
      scope.end(error);
      throw error;
    } finally {
      scope.end();
    }
  })();
}

/** Parameters for {@link startWorkflowScope}. */
interface StartWorkflowScopeParams {
  readonly workflowName: string;
  readonly sessionId: string;
  /** The runner's entrypoint, when the scope is opened for it. */
  readonly entrypoint?: object;
}

/**
 * Opens an `invoke_workflow` span and the workflow frame that model, tool and
 * skill calls inside it count against. Ending it records the workflow's
 * duration and inclusive totals.
 */
function startWorkflowScope({
  workflowName,
  sessionId,
  entrypoint,
}: StartWorkflowScopeParams): StartedScope {
  const startTime = performance.now();
  const {frame, context: frameContext} = openWorkflowFrame(context.active(), {
    workflowName,
    config: readTelemetryConfig(),
    entrypoint,
  });
  const nested = frame.parent !== undefined;
  const span = startWorkflowSpan({workflowName, sessionId, nested});
  return {
    context: trace.setSpan(frameContext, span),
    end: once((error?: unknown): void => {
      if (error !== undefined) {
        setSpanError(span, error);
      }
      span.end();
      recordMetricsSafely(() =>
        recordWorkflowMetrics({
          workflowName,
          rootAgentName: frame.rootAgentName,
          nested,
          elapsedSeconds: secondsSince(startTime),
          errorType: error === undefined ? undefined : resolveErrorType(error),
          totals: frame.totals,
          config: frame.config,
        }),
      );
    }),
  };
}

/** Parameters for starting an invocation with {@link recordInvocation}. */
export interface RecordInvocationParams {
  /** The runner's root agent or workflow. */
  readonly entrypoint: BaseNode;
  /** The session the invocation runs in. */
  readonly sessionId: string;
}

/**
 * Wraps a runner invocation in its root `invoke_workflow {entrypoint}` span.
 *
 * Every workflow started inside the invocation is nested below this span. A
 * workflow entrypoint runs inside it rather than opening a second one.
 */
export function recordInvocation<T>(
  {entrypoint, sessionId}: RecordInvocationParams,
  createGenerator: () => AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  return streamInScope(
    () =>
      startWorkflowScope({
        workflowName: entrypoint.name,
        sessionId,
        entrypoint,
      }),
    createGenerator,
  );
}

/** Parameters for starting an `invoke_agent` instrumentation scope. */
export interface RecordAgentInvocationParams {
  readonly agent: BaseAgent;
  /** The context the agent was invoked with. */
  readonly invocationContext: InvocationContext;
}

/**
 * Wraps an agent invocation in an `invoke_agent {agent.name}` span.
 */
export function recordAgentInvocation<T>(
  {agent, invocationContext}: RecordAgentInvocationParams,
  createGenerator: () => AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  return streamInScope(() => {
    const config = readTelemetryConfig();
    const startTime = performance.now();
    const span = getTracer().startSpan(`invoke_agent ${agent.name}`, {
      attributes: buildAgentInvocationAttributes({
        agent,
        // Read defensively: telemetry must not fail a run whose context was
        // assembled without a session.
        sessionId: invocationContext.session?.id,
      }),
    });
    const {frame, context: frameContext} = openAgentFrame(
      trace.setSpan(context.active(), span),
    );
    return {
      context: frameContext,
      end: once((error?: unknown): void => {
        if (error !== undefined) {
          setSpanError(span, error);
        }
        span.end();
        recordMetricsSafely(() =>
          recordAgentMetrics({
            agentName: agent.name,
            elapsedSeconds: secondsSince(startTime),
            errorType:
              error === undefined ? undefined : resolveErrorType(error),
            totals: frame.totals,
            config,
          }),
        );
      }),
    };
  }, createGenerator);
}

/** Parameters for recording one model call with {@link recordInference}. */
export interface RecordInferenceParams {
  readonly invocationContext: InvocationContext;
  readonly llmRequest: LlmRequest;
  /** The event the model's responses are merged into. */
  readonly modelResponseEvent: Event;
}

/** The state of one model call while its stream is being consumed. */
interface Inference {
  /** The context carrying the `generate_content` span. */
  readonly context: Context;
  /**
   * Records a response; ends the span when it reports a finish reason. Every
   * response counts towards the call's token usage, including those after it.
   */
  record(llmResponse: LlmResponse): void;
  /**
   * Finishes the call, once: ends the span if it is still open, then counts
   * the call and its newest token usage against its agent and workflows.
   */
  finish(failure?: {error: unknown}): void;
}

function startInference({
  invocationContext,
  llmRequest,
  modelResponseEvent,
}: RecordInferenceParams): Inference {
  const config = readTelemetryConfig();
  const accumulators = captureAccumulators(context.active());
  const agentName = invocationContext.agent?.name;
  const commonAttributes: Attributes = {
    ...(agentName ? {[GenAiAttr.AGENT_NAME]: agentName} : {}),
    [GenAiAttr.CONVERSATION_ID]: invocationContext.session?.id,
    [GcpAttr.EVENT_ID]: modelResponseEvent.id,
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    [GenAiAttr.PROVIDER_NAME]: resolveProviderName(llmRequest.model),
  };
  const span = startInferenceSpan({llmRequest, commonAttributes});
  const requestDetails = buildRequestOperationDetails(llmRequest);
  const outputMessages: AnyValueMap[] = [];
  let responseAttributes: Attributes = {};
  let ended = false;
  let finished = false;
  let newestUsage: GenerateContentResponseUsageMetadata | undefined;

  const end = (failure?: {error: unknown}): void => {
    if (ended) {
      return;
    }
    ended = true;
    if (failure) {
      setSpanError(span, failure.error);
    }
    const details: OperationDetails =
      outputMessages.length > 0
        ? {...requestDetails, [GenAiAttr.OUTPUT_MESSAGES]: outputMessages}
        : requestDetails;
    const captureContent = shouldAddContentToLogs(config);
    emitInferenceOperationDetails(span, {
      ...commonAttributes,
      ...(captureContent
        ? {[USER_ID_ATTR]: invocationContext.session?.userId}
        : {}),
      ...responseAttributes,
      ...(captureContent ? details : withoutContent(details)),
    });
    setInferenceOperationDetails(span, details, config);
    span.end();
  };

  return {
    context: trace.setSpan(context.active(), span),
    record(llmResponse: LlmResponse): void {
      // Usage reports are cumulative, so the newest one is the whole figure.
      newestUsage = llmResponse.usageMetadata ?? newestUsage;
      if (ended) {
        return;
      }
      setInferenceResponseAttributes(span, llmResponse, config);
      responseAttributes = {
        ...responseAttributes,
        ...buildResponseAttributes(llmResponse),
      };
      const outputMessage = buildOutputMessage(llmResponse);
      if (outputMessage) {
        outputMessages.push(outputMessage);
      }
      // The call ends at the response that says why generation stopped, which
      // the model sets on its last response. Ending here, before the response
      // reaches the caller, keeps what the caller does with it (such as
      // running the tool the model asked for) outside the span.
      if (isReportedFinishReason(llmResponse.finishReason)) {
        end();
      }
    },
    finish(failure?: {error: unknown}): void {
      if (finished) {
        return;
      }
      finished = true;
      end(failure);
      accumulators.addInferenceCall();
      if (newestUsage !== undefined) {
        const usage = new TokenUsage(newestUsage);
        if (usage.input !== undefined || usage.output !== undefined) {
          accumulators.addTokens(usage);
        }
      }
    },
  };
}

/**
 * Wraps one model call in a `generate_content {model}` span and its
 * `gen_ai.client.inference.operation.details` log record.
 *
 * Returns the model's responses unchanged. The span is current only while the
 * model stream is being pulled, never while the caller handles a response, and
 * it ends at the first response that reports a finish reason, before that
 * response is returned. If the stream ends, fails or is closed before one
 * arrives, the span ends then. Each call emits exactly one log record, while
 * the span is still open.
 */
export function recordInference(
  params: RecordInferenceParams,
  createStream: () => AsyncGenerator<LlmResponse, void, void>,
): AsyncGenerator<LlmResponse, void, void> {
  return (async function* () {
    const inference = startInference(params);
    try {
      for await (const llmResponse of bindOtelContextToAsyncGenerator(
        inference.context,
        context.with(inference.context, createStream),
      )) {
        inference.record(llmResponse);
        yield llmResponse;
      }
    } catch (error: unknown) {
      inference.finish({error});
      throw error;
    } finally {
      inference.finish();
    }
  })();
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

const TOOL_SCOPE_KEY = createContextKey('adk_tool_scope');

/** What a skill tool reported, and the skill it resolved, if any. */
interface SkillActivityReport {
  readonly activity: SkillActivity;
  readonly skill?: Skill;
}

/** What a running tool reports back to its `execute_tool` scope. */
interface ToolScopeState {
  skillActivity: SkillActivityReport | undefined;
}

function isToolScopeState(value: unknown): value is ToolScopeState {
  return (
    typeof value === 'object' && value !== null && 'skillActivity' in value
  );
}

/** Parameters for {@link recordSkillMetrics}. */
interface RecordSkillMetricsParams {
  readonly report: SkillActivityReport;
  readonly agentName: string;
  readonly errorType: string | undefined;
  readonly config: TelemetryConfig;
}

/** Records the skill load and script execution counters. */
function recordSkillMetrics({
  report: {activity, skill},
  agentName,
  errorType,
  config,
}: RecordSkillMetricsParams): void {
  switch (activity.kind) {
    case 'load':
      recordSkillLoad({config, agentName, skill, errorType});
      return;
    case 'script':
      recordSkillScriptExecution({
        config,
        agentName,
        skill,
        scriptPath: activity.scriptPath,
      });
      return;
    case 'resource':
      return;
    default: {
      const exhaustive: never = activity;
      throw new Error(`Unknown skill activity: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Parameters for starting an `execute_tool` instrumentation scope. */
export interface RecordToolExecutionParams {
  readonly tool: BaseTool;
  readonly args: Record<string, unknown>;
  readonly invocationContext: InvocationContext;
}

/** Parameters for recording a completed tool execution on its scope. */
export interface ToolExecutionSuccessParams {
  readonly functionResponseEvent?: Event;
  /**
   * The raw value returned by the tool before normalization into a
   * `functionResponse` event, used to inspect any response-reported error type.
   */
  readonly rawResult: unknown;
}

/** Scope handle passed to the body of {@link recordToolExecution}. */
export interface ToolExecutionScope {
  /**
   * Records the tool's response, including an error the tool reported in it
   * rather than throwing.
   */
  recordSuccess(params: ToolExecutionSuccessParams): void;
}

/**
 * Wraps a single tool call in an `execute_tool {tool.name}` span.
 *
 * An error that escapes `fn` is recorded on the span as `error.type` and an
 * ERROR status, as is an error the tool reports in its response. Skill tools
 * running inside report to the span through {@link recordSkillActivity}.
 */
export async function recordToolExecution<T>(
  {tool, args, invocationContext}: RecordToolExecutionParams,
  fn: (scope: ToolExecutionScope) => Promise<T>,
): Promise<T> {
  const config = readTelemetryConfig();
  const accumulators = captureAccumulators(context.active());
  const startTime = performance.now();
  const toolScope: ToolScopeState = {skillActivity: undefined};
  return getTracer().startActiveSpan(
    `execute_tool ${tool.name}`,
    {},
    context.active().setValue(TOOL_SCOPE_KEY, toolScope),
    async (span) => {
      let outcome: ToolCallOutcome = {kind: 'response'};
      try {
        return await fn({
          recordSuccess({functionResponseEvent, rawResult}): void {
            outcome = {
              kind: 'response',
              functionResponseEvent,
              errorType: getToolResponseErrorType(rawResult),
            };
          },
        });
      } catch (error: unknown) {
        outcome = {kind: 'error', errorType: resolveErrorType(error)};
        setSpanError(span, error);
        throw error;
      } finally {
        span.setAttributes(
          buildToolCallAttributes({
            tool,
            args,
            agentName: invocationContext.agent?.name,
            outcome,
            config,
          }),
        );
        if (outcome.kind === 'response' && outcome.errorType !== undefined) {
          // Without an explicit status the span reads as successful. The
          // message repeats the type rather than the tool's error text, which
          // the content capture setting does not gate.
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: outcome.errorType,
          });
        }
        const {skillActivity} = toolScope;
        if (skillActivity) {
          setSkillSpanAttributes(
            span,
            tool.name,
            toSkillReport(skillActivity.activity, skillActivity.skill),
          );
        }
        span.end();
        accumulators.addToolCall();
        if (skillActivity?.activity.kind === 'load') {
          accumulators.addSkillLoad();
        }
        const agentName = invocationContext.agent?.name;
        recordMetricsSafely(() => {
          if (agentName !== undefined) {
            recordToolMetrics({
              agentName,
              toolName: tool.name,
              toolType: tool.constructor.name,
              elapsedSeconds: secondsSince(startTime),
              errorType: outcome.errorType,
            });
          }
          if (skillActivity && agentName !== undefined) {
            recordSkillMetrics({
              report: skillActivity,
              agentName,
              errorType: outcome.errorType,
              config,
            });
          }
        });
      }
    },
  );
}

/** What a skill tool is doing, reported with {@link recordSkillActivity}. */
export type SkillActivity =
  | {readonly kind: 'load'; readonly skillName: string}
  | {
      readonly kind: 'resource';
      readonly skillName: string;
      readonly resourcePath: string;
    }
  | {
      readonly kind: 'script';
      readonly skillName: string;
      readonly scriptPath: string;
    };

/** Handle returned by {@link recordSkillActivity}. */
export interface SkillActivityScope {
  /** Records the skill the tool resolved. */
  recordSkill(skill: Skill): void;
}

const NO_OP_SKILL_ACTIVITY_SCOPE: SkillActivityScope = Object.freeze({
  recordSkill(): void {},
});

function toSkillReport(activity: SkillActivity, skill?: Skill): SkillReport {
  switch (activity.kind) {
    case 'load':
      return {skillName: activity.skillName, isSkillLoad: true, skill};
    case 'resource':
      return {
        skillName: activity.skillName,
        resourceName: activity.resourcePath,
        isSkillLoad: false,
        skill,
      };
    case 'script':
      return {
        skillName: activity.skillName,
        resourceName: activity.scriptPath,
        isSkillLoad: false,
        skill,
      };
    default: {
      const exhaustive: never = activity;
      throw new Error(`Unknown skill activity: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Reports what a skill tool is doing to the `execute_tool` span it runs
 * under, which is renamed after the skill and records its attributes when the
 * tool call ends.
 *
 * Does nothing outside a tool call. A second report in the same tool call
 * replaces the first.
 */
export function recordSkillActivity(
  activity: SkillActivity,
): SkillActivityScope {
  const toolScope = context.active().getValue(TOOL_SCOPE_KEY);
  if (!isToolScopeState(toolScope)) {
    return NO_OP_SKILL_ACTIVITY_SCOPE;
  }
  const report: SkillActivityReport = {activity};
  toolScope.skillActivity = report;
  return {
    recordSkill(skill: Skill): void {
      toolScope.skillActivity = {...report, skill};
    },
  };
}

/** Parameters for recording a merged tool calls span. */
export interface RecordMergedToolCallsParams {
  /** The id of the event that merges the parallel tool responses. */
  readonly responseEventId: string;
}

/**
 * Starts and immediately ends an `execute_tool (merged)` span for parallel
 * tool calls whose responses were merged into one event.
 */
export function recordMergedToolCalls({
  responseEventId,
}: RecordMergedToolCallsParams): void {
  getTracer()
    .startSpan('execute_tool (merged)', {
      attributes: buildMergedToolCallsAttributes(responseEventId),
    })
    .end();
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
  /**
   * Ends the span, with an ERROR status when `error` is given. Safe to call
   * more than once; only the first call counts.
   */
  end(error?: unknown): void;
}

const PASS_THROUGH_SCOPE: SyncStartedScope = Object.freeze({
  run: <T>(fn: () => T): T => fn(),
  end(): void {},
});

function startSyncScope(
  span: Span,
  ctx: Context,
  onSuccess?: () => void,
): SyncStartedScope {
  let ended = false;
  return {
    run: (fn) => context.with(ctx, fn),
    end(error?: unknown): void {
      if (ended) {
        return;
      }
      ended = true;
      if (error === undefined) {
        onSuccess?.();
      } else {
        setSpanError(span, error);
      }
      span.end();
    },
  };
}

/** Parameters for starting an `invoke_workflow` instrumentation scope. */
export interface RecordWorkflowInvocationParams {
  readonly workflow: BaseNode;
  readonly sessionId: string;
}

/**
 * Starts the `invoke_workflow {workflow.name}` scope of a workflow run,
 * synchronously.
 *
 * The workflow the runner was entered at runs in the runner's span instead,
 * so its scope opens nothing. A workflow started inside another workflow is
 * marked nested. The caller runs the orchestration through `scope.run` and
 * calls `scope.end()` once it settles.
 */
export function recordWorkflowInvocation({
  workflow,
  sessionId,
}: RecordWorkflowInvocationParams): SyncStartedScope {
  const parentContext = context.active();
  if (claimEntrypointWorkflowFrame(parentContext, workflow)) {
    // The runner's invocation scope records this workflow when it ends.
    return {run: (fn) => context.with(parentContext, fn), end(): void {}};
  }
  const scope = startWorkflowScope({workflowName: workflow.name, sessionId});
  return {run: (fn) => context.with(scope.context, fn), end: scope.end};
}

/** Parameters for starting a workflow node's instrumentation scope. */
export interface RecordNodeInvocationParams {
  readonly node: BaseNode;
  /** The name the node runs under, which may differ from `node.name`. */
  readonly nodeName: string;
  readonly sessionId: string;
}

/** Scope handle returned by {@link recordNodeInvocation}. */
export interface NodeInvocationScope extends SyncStartedScope {
  /** Records an event the node emitted. */
  recordEvent(event: Event): void;
}

const PASS_THROUGH_NODE_SCOPE: NodeInvocationScope = Object.freeze({
  ...PASS_THROUGH_SCOPE,
  recordEvent(): void {},
});

/**
 * Starts the scope of one workflow node run, synchronously.
 *
 * A plain node runs in an `invoke_node {nodeName}` span that records the ids
 * of the events it emitted. An agent or workflow node opens no node span: its
 * own `invoke_agent` or `invoke_workflow` span stands for it.
 *
 * The span's parent is the span active at the call, so call this when the node
 * is scheduled. The caller runs the node body through `scope.run` and calls
 * `scope.end()` when the node work finishes.
 */
export function recordNodeInvocation({
  node,
  nodeName,
  sessionId,
}: RecordNodeInvocationParams): NodeInvocationScope {
  if (hasOwnInvocationSpan(node)) {
    return PASS_THROUGH_NODE_SCOPE;
  }
  const span = startNodeSpan({nodeName, sessionId});
  const eventIds: string[] = [];
  return {
    ...startSyncScope(span, trace.setSpan(context.active(), span), () =>
      setAssociatedEventIds(span, eventIds),
    ),
    recordEvent(event: Event): void {
      eventIds.push(event.id);
    },
  };
}

/** Parameters for recording a context compaction. */
export interface RecordCompactionParams {
  readonly invocationContext: InvocationContext;
  readonly trigger: ContextCompactionTrigger;
}

/**
 * Wraps a context compaction in a `compact_events {trigger}` span, recording
 * the summary event it added to the session.
 */
export async function recordCompaction<T>(
  {invocationContext, trigger}: RecordCompactionParams,
  fn: () => Promise<T>,
): Promise<T> {
  const {session} = invocationContext;
  const eventsBefore = [...session.events];
  const accumulators = captureAccumulators(context.active());
  const span = startCompactionSpan({sessionId: session.id, trigger});
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      const resultAttributes = buildCompactionResultAttributes(
        eventsBefore,
        session.events,
      );
      span.setAttributes(resultAttributes);
      if (GenAiAttr.COMPACTION_RESULT_EVENT_ID in resultAttributes) {
        accumulators.addCompaction();
      }
      return result;
    } catch (error: unknown) {
      setSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
