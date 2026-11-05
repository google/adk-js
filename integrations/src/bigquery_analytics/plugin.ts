/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type BigQuery} from '@google-cloud/bigquery';
import {type managedwriter} from '@google-cloud/bigquery-storage';
import {type Storage} from '@google-cloud/storage';
import {
  type BaseAgent,
  BasePlugin,
  type BaseTool,
  type Context,
  type Event,
  getFunctionCalls,
  getFunctionResponses,
  type InvocationContext,
  isCompactedEvent,
  isFinalResponse,
  type LlmRequest,
  type LlmResponse,
  logger,
} from '@google/adk';
import {type Content} from '@google/genai';
import {
  classifyToolResultError,
  isDurableNodeError,
  markToolErrorRecorded,
  popToolErrorRecorded,
} from './callback_helpers.js';
import {
  contextOf,
  errorName,
  errorText,
  errorTraceback,
  functionPartEvents,
  HITL_EVENT_MAP,
  LLM_CONFIG_FIELDS,
  resolveModelName,
  snakeCaseSchema,
  staticInstructionText,
  toolOriginContext,
  WorkflowObservations,
} from './callback_support.js';
import {
  type BigQueryLoggerConfig,
  resolveLoggerConfig,
  validateRuntimeConfig,
} from './config.js';
import {type ContentKind, formatContent} from './content_parser.js';
import {
  buildEventRow,
  type EventData,
  isolateToolCall,
  parseContent,
  prepareContent,
  resolveIds,
  type RowSettings,
  scopeOf,
} from './event_row.js';
import {recursiveSmartTruncate, safeGet} from './sanitize.js';
import {
  parseCustomMetadataAllowlist,
  validatePayloadColumnDenylist,
} from './schema.js';
import {extractToolDeclarations, getToolOrigin} from './tool_origin.js';
import {newSpanId, type SpanKind, TraceManager} from './trace_manager.js';
import {type DropStats, type JsonValue} from './types.js';
import {validateEvalViewConfig, validateViewIdentifiers} from './views.js';
import {WriterLifecycle} from './writer_lifecycle.js';

interface LogEventParams {
  eventType: string;
  context: Context;
  rawContent?: unknown;
  isTruncated?: boolean;
  eventData?: EventData;
  /**
   * Set when `rawContent` is SDK content, which is parsed into content parts;
   * anything else is logged as generic JSON.
   */
  contentKind?: ContentKind;
}

/** Row ids and latency of a span a callback closes. */
interface ClosedSpan {
  latencyMs: number | null;
  spanIdOverride: string;
  parentSpanIdOverride: string | null;
}

export interface BigQueryAgentAnalyticsPluginOptions {
  projectId: string;
  datasetId: string;
  /** Overrides `config.tableId`. */
  tableId?: string;
  config?: Partial<BigQueryLoggerConfig>;
  /**
   * BigQuery location for view DDL jobs; when unset, BigQuery infers it from
   * the dataset.
   */
  location?: string;
  /**
   * Clients to use instead of ones built from Application Default Credentials.
   */
  bigQuery?: BigQuery;
  storage?: Storage;
  /**
   * Write client to use instead of one built from Application Default
   * Credentials. The plugin never closes a supplied client, so the SDK keeps
   * every stream connection the plugin opened on it, including ones abandoned
   * with an unacknowledged request and its encoded rows, until the caller
   * closes the client.
   */
  writeClient?: managedwriter.WriterClient;
}

function secondsOrNull(milliseconds: unknown): number | null {
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
    ? milliseconds / 1000
    : null;
}

/**
 * Logs agent events (LLM requests, tool calls, agent lifecycle, HITL) to
 * BigQuery through the Storage Write API. Port of adk-python
 * `BigQueryAgentAnalyticsPlugin`; rows are written to the same table schema, so
 * Python and TypeScript agents can share one table and its views.
 *
 * Register this plugin before plugins that answer or re-raise tool callbacks,
 * such as `ReflectAndRetryToolPlugin`: the plugin manager stops at the first
 * plugin that returns a value.
 *
 * Example:
 * ```typescript
 * const plugin = new BigQueryAgentAnalyticsPlugin({
 *   projectId: 'my-project',
 *   datasetId: 'agent_analytics',
 * });
 * const runner = new InMemoryRunner({agent, plugins: [plugin]});
 * // ...
 * await plugin.shutdown();
 * ```
 */
export class BigQueryAgentAnalyticsPlugin extends BasePlugin {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly location: string | undefined;
  readonly config: BigQueryLoggerConfig;

  private readonly traces = new TraceManager();
  private readonly workflowObservations: WorkflowObservations;
  private readonly lifecycle: WriterLifecycle;
  private readonly rowSettings: RowSettings;

  constructor(options: BigQueryAgentAnalyticsPluginOptions) {
    super('bigquery_agent_analytics');
    this.projectId = options.projectId;
    this.datasetId = options.datasetId;
    this.config = resolveLoggerConfig(options.config);
    if (!this.config.viewPrefix) {
      throw new RangeError('viewPrefix must be a non-empty string.');
    }
    const customMetadata = parseCustomMetadataAllowlist(
      this.config.customMetadataAllowlist,
    );
    const deniedColumns = validatePayloadColumnDenylist(
      this.config.payloadColumnDenylist,
    );
    if (
      deniedColumns.has('attributes') &&
      (customMetadata.exact.size > 0 || customMetadata.prefixes.length > 0)
    ) {
      throw new RangeError(
        "customMetadataAllowlist captures into the 'attributes' column, but 'attributes' is in " +
          'payloadColumnDenylist -- the captured metadata would be dropped. Remove ' +
          "'attributes' from payloadColumnDenylist or clear customMetadataAllowlist.",
      );
    }
    if (this.config.createEvalViews) {
      validateEvalViewConfig({
        config: this.config,
        denied: deniedColumns,
        fromInit: true,
      });
    }
    this.tableId = options.tableId ?? this.config.tableId;
    this.location = options.location;
    validateViewIdentifiers({
      projectId: this.projectId,
      datasetId: this.datasetId,
      tableId: this.tableId,
      viewPrefix: this.config.viewPrefix,
    });
    validateRuntimeConfig(this.config);
    this.workflowObservations = new WorkflowObservations(
      this.config.maxObservationSummariesPerSegment,
    );
    this.rowSettings = {
      config: this.config,
      deniedColumns,
      customMetadata,
      traces: this.traces,
    };
    this.lifecycle = new WriterLifecycle({
      projectId: this.projectId,
      datasetId: this.datasetId,
      tableId: this.tableId,
      location: this.location,
      config: this.config,
      deniedColumns,
      bigQuery: options.bigQuery ?? null,
      storage: options.storage ?? null,
      writeClient: options.writeClient ?? null,
    });
  }

  /**
   * Dropped-row counts by reason. `formatter_failed` and `content_parse_failed`
   * mean the row was written with a sentinel in place of its content; every
   * other reason means it was never written.
   */
  getDropStats(): DropStats {
    return this.lifecycle.getDropStats();
  }

  async flush(): Promise<void> {
    await this.lifecycle.flush();
  }

  /** Creates or refreshes the per-event-type views on demand. */
  async createAnalyticsViews(): Promise<void> {
    await this.lifecycle.createAnalyticsViews();
  }

  /**
   * Creates or refreshes the `{viewPrefix}_eval_session` and
   * `{viewPrefix}_eval_turn` views on demand.
   */
  async createEvalViews(): Promise<void> {
    await this.lifecycle.createEvalViews();
  }

  /**
   * Drains queued rows and releases the write transport. Concurrent callers
   * share one teardown.
   */
  async shutdown(params: {timeoutSeconds?: number} = {}): Promise<void> {
    await this.lifecycle.shutdown({
      timeoutSeconds: params.timeoutSeconds,
      onReleased: () => {
        this.traces.clear();
        this.workflowObservations.clear();
      },
    });
  }

  async close(): Promise<void> {
    await this.shutdown();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  private formatContentSafely(content: Content | undefined): {
    text: string;
    isTruncated: boolean;
  } {
    if (content === undefined) {
      return {text: 'None', isTruncated: false};
    }
    try {
      return formatContent({content, maxLen: this.config.maxContentLength});
    } catch (error) {
      logger.warn('Content formatter failed:', error);
      return {text: '[FORMATTING FAILED]', isTruncated: true};
    }
  }

  /**
   * Whether an event of this type is logged at all, starting the plugin on
   * first use.
   */
  private observing(): boolean {
    return this.config.enabled && !this.lifecycle.isShuttingDown;
  }

  private eventTypeFiltered(eventType: string): boolean {
    if (this.config.eventDenylist?.includes(eventType)) {
      return true;
    }
    return (
      this.config.eventAllowlist !== null &&
      this.config.eventAllowlist.length > 0 &&
      !this.config.eventAllowlist.includes(eventType)
    );
  }

  private async admit(eventType: string): Promise<boolean> {
    if (!this.observing() || this.eventTypeFiltered(eventType)) {
      return false;
    }
    if (this.lifecycle.started) {
      return true;
    }
    const outcome = await this.lifecycle.ensureStarted();
    if (outcome === 'disabled') {
      return false;
    }
    // ensureStarted() sets `started` across the await
    if (!this.lifecycle.started) {
      this.lifecycle.countLocalDrop(
        outcome === 'aborted' ? 'shutdown_race' : 'setup_unavailable',
      );
      return false;
    }
    return true;
  }

  private async logEvent({
    eventType,
    context,
    rawContent,
    isTruncated = false,
    eventData = {},
    contentKind,
  }: LogEventParams): Promise<void> {
    if (!(await this.admit(eventType))) {
      return;
    }
    const prepared = prepareContent({
      eventType,
      rawContent,
      isTruncated,
      eventData,
      config: this.config,
    });
    if (prepared.formatterFailed) {
      this.lifecycle.countLocalDrop('formatter_failed');
    }
    const ids = resolveIds({eventData, context, traces: this.traces});
    const parser = this.lifecycle.parser;
    if (parser === null) {
      logger.warn(`Parser not initialized; skipping event ${eventType}.`);
      return;
    }
    const parsed = await parseContent({
      eventType,
      content: prepared.content,
      // A formatter's output is the caller's own value, not SDK content.
      contentKind: prepared.content === rawContent ? contentKind : undefined,
      ids,
      parser,
      settings: this.rowSettings,
    });
    if (parsed.parseFailed) {
      this.lifecycle.countLocalDrop('content_parse_failed');
    }
    const row = buildEventRow({
      eventType,
      context,
      eventData,
      ids,
      prepared,
      parsed,
      settings: this.rowSettings,
    });
    if (!this.lifecycle.append(row)) {
      this.lifecycle.countLocalDrop('shutdown_race');
    }
  }

  private truncate(value: unknown): {value: JsonValue; isTruncated: boolean} {
    return recursiveSmartTruncate({
      value,
      maxLen: this.config.maxContentLength,
    });
  }

  /**
   * Runs a callback body, logging and swallowing its failure so analytics never
   * breaks the agent run.
   */
  private async safely(
    name: string,
    body: () => Promise<void>,
  ): Promise<undefined> {
    try {
      await body();
    } catch (error) {
      logger.error(
        `BigQuery analytics plugin error in ${name}; skipping.`,
        error,
      );
    }
    return undefined;
  }

  private popSpan(context: Context, expectedKind: SpanKind) {
    return this.traces.popSpan({scope: scopeOf(context), expectedKind});
  }

  /**
   * Pops the span a completion or error row closes. An agent or invocation
   * span is unwound through any descendants left open by a skipped completion
   * callback. When the opening callback never ran (an unresolvable tool call,
   * a short-circuited callback), the row gets a span of its own under the
   * current one rather than reusing it.
   */
  private closeSpan(context: Context, kind: SpanKind): ClosedSpan {
    const scope = scopeOf(context);
    const {spanId, durationMs} =
      kind === 'agent'
        ? this.traces.unwindSpan({scope, kind, name: context.agentName})
        : kind === 'invocation'
          ? this.traces.unwindSpan({scope, kind})
          : this.popSpan(context, kind);
    return {
      latencyMs: durationMs,
      spanIdOverride: spanId ?? newSpanId(),
      parentSpanIdOverride: this.currentSpanAndParent(context).spanId,
    };
  }

  /**
   * Bounded by `shutdownTimeout`, so a slow or unavailable sink cannot hold up
   * the end of a run.
   */
  private async flushAtRunEnd(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        this.config.shutdownTimeout * 1000,
      );
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([this.flush(), deadline]);
      if (outcome === 'timeout') {
        logger.warn(
          `BigQuery analytics flush did not finish within ${this.config.shutdownTimeout}s at the end of a run; rows stay queued.`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Port of `_drain_workflow_node_observations`: one summary row per workflow
   * node path the runner call observed, up to the configured cap.
   */
  private async drainWorkflowObservations(
    context: Context,
    drainCallback: string,
  ): Promise<void> {
    if (!this.observing()) {
      return;
    }
    const summaries = this.workflowObservations.summarize(
      context.invocationId,
      drainCallback,
    );
    if (
      summaries === null ||
      this.eventTypeFiltered('WORKFLOW_NODE_OBSERVATION_SUMMARY')
    ) {
      return;
    }
    for (const adkExtras of summaries.adkExtras) {
      try {
        await this.logEvent({
          eventType: 'WORKFLOW_NODE_OBSERVATION_SUMMARY',
          context,
          eventData: {adkExtras},
        });
      } catch {
        logger.warn(
          'Could not emit workflow-node observation summary; continuing.',
        );
      }
    }
    const {truncatedNodeCount, totalObservedPaths} = summaries;
    if (truncatedNodeCount > 0) {
      this.lifecycle.countLocalDrop(
        'workflow_observation_capacity',
        truncatedNodeCount,
      );
      logger.warn(
        `Workflow observation summaries were not written for ${truncatedNodeCount} of ${totalObservedPaths} node paths: maxObservationSummariesPerSegment is ${this.config.maxObservationSummariesPerSegment}.`,
      );
    }
  }

  private currentSpanAndParent(context: Context) {
    return this.traces.getCurrentSpanAndParent(scopeOf(context));
  }

  private initTrace(context: Context): void {
    let rootAgentName: string | null = null;
    try {
      rootAgentName = context.invocationContext.agent?.rootAgent.name ?? null;
    } catch {
      rootAgentName = null;
    }
    this.traces.initTrace({scope: scopeOf(context), rootAgentName});
  }

  private pushSpan(context: Context, kind: SpanKind): void {
    this.initTrace(context);
    this.traces.pushSpan({
      scope: scopeOf(context),
      kind,
      name: kind === 'agent' ? context.agentName : null,
    });
  }

  private ensureInvocationSpan(context: Context): void {
    this.initTrace(context);
    this.traces.ensureInvocationSpan(scopeOf(context));
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    return this.safely('onUserMessageCallback', async () => {
      const context = contextOf(invocationContext);
      this.ensureInvocationSpan(context);
      await this.logEvent({
        eventType: 'USER_MESSAGE_RECEIVED',
        context,
        rawContent: userMessage,
        contentKind: 'content',
      });

      for (const part of userMessage.parts ?? []) {
        const functionResponse = part.functionResponse;
        if (functionResponse === undefined) {
          continue;
        }
        const responseName = functionResponse.name ?? null;
        const hitlEvent =
          responseName === null ? undefined : HITL_EVENT_MAP.get(responseName);
        const {value: result, isTruncated} = this.truncate(
          functionResponse.response ?? {},
        );
        const rawContent = {tool: responseName, result};
        if (hitlEvent !== undefined) {
          await this.logEvent({
            eventType: `${hitlEvent}_COMPLETED`,
            context,
            rawContent,
            isTruncated,
          });
          continue;
        }
        if (!functionResponse.id) {
          logger.debug(
            `User-message function_response for tool ${String(responseName)} has no id; the resulting ` +
              'TOOL_COMPLETED row cannot pair with a TOOL_PAUSED row.',
          );
        }
        await this.logEvent({
          eventType: 'TOOL_COMPLETED',
          context,
          rawContent,
          isTruncated,
          eventData: {
            adkExtras: {
              pause_kind: 'tool',
              function_call_id: functionResponse.id ?? null,
            },
          },
        });
      }
    });
  }

  override async onEventCallback({
    invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    return this.safely('onEventCallback', async () => {
      const context = contextOf(invocationContext);

      // A later beforeModel callback may short-circuit the model call, which
      // skips every afterModel callback; the synthesized non-partial event is
      // the only place to close that llm_request span.
      if (event.partial !== true) {
        this.traces.popSpan({
          scope: {
            invocationId: context.invocationId,
            branch: event.branch ?? invocationContext.branch,
          },
          expectedKind: 'llm_request',
        });
      }

      if (this.observing()) {
        try {
          const first = this.workflowObservations.record(
            event,
            context.invocationId,
          );
          if (first !== null) {
            await this.logEvent({
              eventType: 'WORKFLOW_NODE_FIRST_OBSERVED',
              context,
              eventData: {
                sourceEvent: event,
                adkExtras: {
                  workflow_segment_id: first.segmentId,
                  boundary_basis: 'event_observation',
                  source_event_timestamp: first.sourceEventTimestamp,
                },
              },
            });
          }
        } catch {
          logger.warn(
            'Could not record workflow-node observation; continuing.',
          );
        }
      }

      const stateDelta = event.actions.stateDelta;
      if (Object.keys(stateDelta).length > 0) {
        await this.logEvent({
          eventType: 'STATE_DELTA',
          context,
          eventData: {
            sourceEvent: event,
            extraAttributes: {state_delta: {...stateDelta}},
          },
        });
      }

      const nodeInfo = event.nodeInfo;
      let loggedNodeOutput = false;
      if (nodeInfo?.path && event.partial !== true) {
        if (isDurableNodeError(event)) {
          await this.logEvent({
            eventType: 'NODE_ERROR',
            context,
            rawContent: {error_code: event.errorCode ?? null},
            eventData: {
              sourceEvent: event,
              status: 'ERROR',
              errorMessage: event.errorMessage ?? null,
            },
          });
        }
        if (
          event.output !== undefined &&
          event.output !== null &&
          nodeInfo.messageAsOutput !== true
        ) {
          const {value, isTruncated} = this.truncate(event.output);
          loggedNodeOutput = true;
          await this.logEvent({
            eventType: 'NODE_OUTPUT',
            context,
            rawContent: value,
            isTruncated,
            eventData: {sourceEvent: event},
          });
        }
      }

      if (event.actions.transferToAgent) {
        await this.logEvent({
          eventType: 'AGENT_TRANSFER',
          context,
          rawContent: {
            from_agent: event.author ?? null,
            to_agent: event.actions.transferToAgent,
          },
          eventData: {sourceEvent: event},
        });
      }

      if (isCompactedEvent(event)) {
        const {text, isTruncated} = this.formatContentSafely(
          event.content ?? {
            role: 'model',
            parts: [{text: String(event.compactedContent)}],
          },
        );
        await this.logEvent({
          eventType: 'EVENT_COMPACTION',
          context,
          rawContent: {
            // adk-js times are epoch milliseconds; the view reads seconds.
            start_timestamp: secondsOrNull(event.startTime),
            end_timestamp: secondsOrNull(event.endTime),
            compacted_content: text,
          },
          isTruncated,
          eventData: {sourceEvent: event},
        });
      }

      if (
        event.actions.agentState != null ||
        event.actions.endOfAgent === true
      ) {
        const agentState =
          event.actions.agentState == null
            ? {value: null, isTruncated: false}
            : this.truncate(event.actions.agentState);
        await this.logEvent({
          eventType: 'AGENT_STATE_CHECKPOINT',
          context,
          rawContent: {
            agent_state: agentState.value,
            end_of_agent: event.actions.endOfAgent === true,
          },
          isTruncated: agentState.isTruncated,
          eventData: {sourceEvent: event},
        });
      }

      for (const pending of functionPartEvents({
        event,
        maxLen: this.config.maxContentLength,
      })) {
        await this.logEvent({...pending, context});
      }

      const meta = event.customMetadata;
      if (
        meta !== undefined &&
        ((meta['a2a:request'] ?? null) !== null ||
          (meta['a2a:response'] ?? null) !== null)
      ) {
        const a2aKeys = Object.fromEntries(
          Object.entries(meta).filter(([key]) => key.startsWith('a2a:')),
        );
        const a2aMetadata = this.truncate(a2aKeys);
        const responsePayload = a2aKeys['a2a:response'];
        const a2aContent =
          responsePayload === undefined
            ? {value: null, isTruncated: false}
            : this.truncate(responsePayload);
        await this.logEvent({
          eventType: 'A2A_INTERACTION',
          context,
          rawContent: a2aContent.value,
          isTruncated: a2aMetadata.isTruncated || a2aContent.isTruncated,
          eventData: {
            sourceEvent: event,
            extraAttributes: {a2a_metadata: a2aMetadata.value},
          },
        });
      }

      const eventContent = event.content;
      if (
        !loggedNodeOutput &&
        !isCompactedEvent(event) &&
        eventContent?.parts &&
        eventContent.parts.length > 0 &&
        isFinalResponse(event) &&
        event.partial !== true &&
        getFunctionCalls(event).length === 0 &&
        getFunctionResponses(event).length === 0 &&
        (event.longRunningToolIds ?? []).length === 0
      ) {
        const visibleParts = eventContent.parts.filter(
          (part) => part.text && !part.thought,
        );
        if (visibleParts.length > 0) {
          const {text, isTruncated} = this.formatContentSafely({
            role: eventContent.role,
            parts: visibleParts,
          });
          await this.logEvent({
            eventType: 'AGENT_RESPONSE',
            context,
            rawContent: {response: text},
            isTruncated,
            eventData: {
              sourceEvent: event,
              extraAttributes: {
                source_event_id: event.id,
                source_event_author: event.author ?? null,
                source_event_branch: event.branch ?? null,
              },
            },
          });
        }
      }
    });
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return this.safely('beforeRunCallback', async () => {
      await this.lifecycle.ensureStarted();
      if (this.observing()) {
        this.workflowObservations.open(invocationContext.invocationId);
      }
      const context = contextOf(invocationContext);
      this.ensureInvocationSpan(context);
      await this.logEvent({eventType: 'INVOCATION_STARTING', context});
    });
  }

  override async afterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    await this.safely('afterRunCallback', async () => {
      const context = contextOf(invocationContext);
      try {
        await this.drainWorkflowObservations(context, 'after_run');
        const traceId = this.traces.getTraceId(scopeOf(context));
        await this.logEvent({
          eventType: 'INVOCATION_COMPLETED',
          context,
          eventData: {
            traceIdOverride: traceId,
            ...this.closeSpan(context, 'invocation'),
          },
        });
      } finally {
        this.workflowObservations.close(context.invocationId);
        this.traces.clearInvocation(context.invocationId);
        if (this.config.flushOnRunEnd) {
          await this.flushAtRunEnd();
        }
      }
    });
  }

  override async beforeAgentCallback({
    agent,
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return this.safely('beforeAgentCallback', async () => {
      this.pushSpan(callbackContext, 'agent');
      const rawInstruction = safeGet(agent, 'instruction');
      const instructionText =
        typeof rawInstruction === 'string' && rawInstruction
          ? rawInstruction
          : null;
      const extraAttributes: Record<string, unknown> = {};
      if (typeof rawInstruction === 'function') {
        extraAttributes.instruction_source = 'provider';
      }

      const staticInstruction = staticInstructionText(
        safeGet(agent, 'staticInstruction'),
      );
      if (staticInstruction) {
        extraAttributes.static_instruction = staticInstruction;
      }
      if (typeof agent.description === 'string' && agent.description) {
        extraAttributes.agent_description = agent.description;
      }

      const subAgentNames = agent.subAgents
        .map((sub) => sub.name)
        .filter((name) => typeof name === 'string' && name !== '');
      if (subAgentNames.length > 0) {
        extraAttributes.sub_agents = subAgentNames;
      }

      await this.logEvent({
        eventType: 'AGENT_STARTING',
        context: callbackContext,
        rawContent: instructionText,
        eventData: {model: resolveModelName(agent), extraAttributes},
      });
    });
  }

  override async afterAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return this.safely('afterAgentCallback', async () => {
      await this.logEvent({
        eventType: 'AGENT_COMPLETED',
        context: callbackContext,
        eventData: this.closeSpan(callbackContext, 'agent'),
      });
    });
  }

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return this.safely('beforeModelCallback', async () => {
      this.popSpan(callbackContext, 'llm_request');

      const attributes: Record<string, unknown> = {};
      let toolsTruncated = false;
      const config = llmRequest.config;
      if (config !== undefined) {
        const llmConfig: Record<string, unknown> = {};
        for (const [field, pythonName] of LLM_CONFIG_FIELDS) {
          const value: unknown = config[field];
          if (value !== undefined && value !== null) {
            llmConfig[pythonName] =
              field === 'responseSchema' ? snakeCaseSchema(value) : value;
          }
        }
        if (Object.keys(llmConfig).length > 0) {
          attributes.llm_config = llmConfig;
        }
        if (config.labels && Object.keys(config.labels).length > 0) {
          attributes.labels = config.labels;
        }
      }
      if (Object.keys(llmRequest.toolsDict).length > 0) {
        const tools = this.truncate(
          extractToolDeclarations(llmRequest.toolsDict),
        );
        attributes.tools = tools.value;
        toolsTruncated = tools.isTruncated;
      }

      this.pushSpan(callbackContext, 'llm_request');
      await this.logEvent({
        eventType: 'LLM_REQUEST',
        context: callbackContext,
        rawContent: llmRequest,
        contentKind: 'llm_request',
        isTruncated: toolsTruncated,
        eventData: {
          model: llmRequest.model ?? null,
          extraAttributes: attributes,
        },
      });
    });
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return this.safely('afterModelCallback', async () => {
      const scope = scopeOf(callbackContext);
      const isPartial = llmResponse.partial === true;
      const contentDict: Record<string, unknown> = {};
      let isTruncated = false;
      if (llmResponse.content) {
        const formatted = this.formatContentSafely(llmResponse.content);
        if (formatted.text) {
          contentDict.response = formatted.text;
        }
        isTruncated = formatted.isTruncated;
      }
      const usage = llmResponse.usageMetadata;
      if (usage) {
        contentDict.usage = {
          prompt: usage.promptTokenCount ?? null,
          completion: usage.candidatesTokenCount ?? null,
          total: usage.totalTokenCount ?? null,
        };
      }

      let spanId = this.traces.getCurrentSpanId(scope);
      const {parentSpanId} = this.traces.getCurrentSpanAndParent(scope);
      let isPopped = false;
      let duration: number | null = 0;
      let timeToFirstToken: number | null = null;
      const extraAttributes: Record<string, unknown> = {};
      const cacheMetadata = safeGet(llmResponse, 'cacheMetadata');

      if (isPartial) {
        if (spanId !== null) {
          this.traces.recordFirstToken({scope, spanId});
          const startTime = this.traces.getStartTime({scope, spanId});
          const firstToken = this.traces.getFirstTokenTime({scope, spanId});
          if (startTime !== null) {
            duration = Math.trunc(Date.now() - startTime);
          }
          if (startTime !== null && firstToken !== null) {
            timeToFirstToken = Math.trunc(firstToken - startTime);
          }
        }
      } else {
        if (spanId !== null) {
          this.traces.recordFirstToken({scope, spanId});
          const startTime = this.traces.getStartTime({scope, spanId});
          const firstToken = this.traces.getFirstTokenTime({scope, spanId});
          if (startTime !== null && firstToken !== null) {
            timeToFirstToken = Math.trunc(firstToken - startTime);
          }
        }
        const popped = this.traces.popSpan({
          scope,
          expectedKind: 'llm_request',
        });
        duration = popped.durationMs ?? 0;
        isPopped = true;
        spanId = popped.spanId ?? spanId;

        const cached = (usage?.cachedContentTokenCount ?? 0) > 0;
        const cacheConfigured =
          cacheMetadata !== undefined && cacheMetadata !== null;
        if (!cached) {
          extraAttributes.cache_type = 'none';
        } else if (cacheConfigured) {
          extraAttributes.cache_type = 'explicit';
        } else {
          extraAttributes.cache_type = 'implicit';
        }
      }

      await this.logEvent({
        eventType: 'LLM_RESPONSE',
        context: callbackContext,
        rawContent: Object.keys(contentDict).length > 0 ? contentDict : null,
        isTruncated,
        eventData: {
          latencyMs: duration,
          timeToFirstTokenMs: timeToFirstToken,
          modelVersion: llmResponse.modelVersion ?? null,
          usageMetadata: usage,
          cacheMetadata,
          finishReason:
            !isPartial && llmResponse.finishReason !== undefined
              ? String(llmResponse.finishReason)
              : null,
          errorMessage: isPartial ? null : (llmResponse.errorMessage ?? null),
          spanIdOverride: isPopped ? spanId : null,
          parentSpanIdOverride: isPopped ? parentSpanId : null,
          extraAttributes,
          customMetadata: isPartial
            ? null
            : (llmResponse.customMetadata ?? null),
        },
      });
    });
  }

  override async onModelErrorCallback({
    callbackContext,
    error,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return this.safely('onModelErrorCallback', async () => {
      await this.logEvent({
        eventType: 'LLM_ERROR',
        context: callbackContext,
        eventData: {
          status: 'ERROR',
          errorMessage: errorText(error),
          ...this.closeSpan(callbackContext, 'llm_request'),
        },
      });
    });
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return this.safely('beforeToolCallback', async () => {
      isolateToolCall(toolContext);
      const {value: args, isTruncated} = this.truncate(toolArgs);
      const toolOrigin = getToolOrigin({
        tool,
        toolArgs,
        toolContext: toolOriginContext(toolContext),
      });
      this.pushSpan(toolContext, 'tool');
      await this.logEvent({
        eventType: 'TOOL_STARTING',
        context: toolContext,
        rawContent: {tool: tool.name, args, tool_origin: toolOrigin},
        isTruncated,
      });
    });
  }

  override async afterToolCallback({
    tool,
    toolArgs,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    return this.safely('afterToolCallback', async () => {
      if (popToolErrorRecorded(this, toolContext)) {
        return;
      }
      const toolOrigin = getToolOrigin({
        tool,
        toolArgs,
        toolContext: toolOriginContext(toolContext),
      });
      isolateToolCall(toolContext);
      const eventData: EventData = this.closeSpan(toolContext, 'tool');

      let errorMessage: string | null = null;
      try {
        errorMessage = classifyToolResultError({
          tool,
          toolArgs,
          toolContext,
          result,
          toolResultClassifier: this.config.toolResultClassifier,
        });
      } catch {
        errorMessage = null;
        logger.warn(
          `Could not classify the result of tool ${tool.name}; recording it as TOOL_COMPLETED.`,
        );
      }

      if (errorMessage !== null) {
        let args: JsonValue = '[UNSUPPORTED_OBJECT]';
        let argsTruncated = true;
        try {
          const truncatedArgs = this.truncate(toolArgs);
          args = truncatedArgs.value;
          argsTruncated = truncatedArgs.isTruncated;
        } catch {
          logger.warn(
            `Could not serialize the arguments of tool ${tool.name}; recording a sentinel in their place.`,
          );
        }
        await this.logEvent({
          eventType: 'TOOL_ERROR',
          context: toolContext,
          rawContent: {tool: tool.name, args, tool_origin: toolOrigin},
          isTruncated: argsTruncated,
          eventData: {...eventData, status: 'ERROR', errorMessage},
        });
        return;
      }

      let response: JsonValue = '[UNSUPPORTED_OBJECT]';
      let responseTruncated = true;
      try {
        const truncatedResult = this.truncate(result);
        response = truncatedResult.value;
        responseTruncated = truncatedResult.isTruncated;
      } catch {
        logger.warn(
          `Could not serialize the result of tool ${tool.name}; recording a sentinel in its place.`,
        );
      }
      await this.logEvent({
        eventType: 'TOOL_COMPLETED',
        context: toolContext,
        rawContent: {
          tool: tool.name,
          result: response,
          tool_origin: toolOrigin,
        },
        isTruncated: responseTruncated,
        eventData,
      });

      if (this.config.finalResponseToolNames.has(tool.name)) {
        const {value: args, isTruncated} = this.truncate(toolArgs);
        await this.logEvent({
          eventType: 'AGENT_RESPONSE',
          context: toolContext,
          rawContent: {response: args},
          isTruncated,
          eventData: {extraAttributes: {source_tool: tool.name}},
        });
      }
    });
  }

  override async onToolErrorCallback({
    tool,
    toolArgs,
    toolContext,
    error,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    return this.safely('onToolErrorCallback', async () => {
      isolateToolCall(toolContext);
      const {value: args, isTruncated} = this.truncate(toolArgs);
      const toolOrigin = getToolOrigin({
        tool,
        toolArgs,
        toolContext: toolOriginContext(toolContext),
      });
      const closed = this.closeSpan(toolContext, 'tool');
      let errorMessage: string;
      try {
        errorMessage = errorText(error) || errorName(error);
      } catch {
        errorMessage = errorName(error);
      }
      markToolErrorRecorded(this, toolContext);
      await this.logEvent({
        eventType: 'TOOL_ERROR',
        context: toolContext,
        rawContent: {tool: tool.name, args, tool_origin: toolOrigin},
        isTruncated,
        eventData: {status: 'ERROR', errorMessage, ...closed},
      });
    });
  }

  /**
   * adk-python `on_agent_error_callback`. `BasePlugin` has no agent-error
   * hook, so the runner never calls this; it is public so hosts that catch
   * agent failures can report them.
   */
  async onAgentErrorCallback({
    callbackContext,
    error,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
    error: unknown;
  }): Promise<undefined> {
    return this.safely('onAgentErrorCallback', async () => {
      await this.logEvent({
        eventType: 'AGENT_ERROR',
        context: callbackContext,
        rawContent: {error_traceback: errorTraceback(error)},
        eventData: {
          status: 'ERROR',
          errorMessage: errorText(error),
          ...this.closeSpan(callbackContext, 'agent'),
        },
      });
    });
  }

  /**
   * adk-python `on_run_error_callback`. `BasePlugin` has no run-error hook,
   * so the runner never calls this; hosts that catch a failed run can call it
   * to record the error and clean up.
   */
  async onRunErrorCallback({
    invocationContext,
    error,
  }: {
    invocationContext: InvocationContext;
    error: unknown;
  }): Promise<undefined> {
    return this.safely('onRunErrorCallback', async () => {
      const context = contextOf(invocationContext);
      try {
        await this.drainWorkflowObservations(context, 'on_run_error');
        const traceId = this.traces.getTraceId(scopeOf(context));
        await this.logEvent({
          eventType: 'INVOCATION_ERROR',
          context,
          rawContent: {error_traceback: errorTraceback(error)},
          eventData: {
            traceIdOverride: traceId,
            status: 'ERROR',
            errorMessage: errorText(error),
            ...this.closeSpan(context, 'invocation'),
          },
        });
      } finally {
        this.workflowObservations.close(context.invocationId);
        this.traces.clearInvocation(context.invocationId);
        if (this.config.flushOnRunEnd) {
          await this.flushAtRunEnd();
        }
      }
    });
  }
}
