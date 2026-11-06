/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type BaseAgent,
  BasePlugin,
  type BaseTool,
  type Context,
  type Event,
  getLogger,
  type InvocationContext,
  isAgentTool,
  isFunctionTool,
  isLlmAgent,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import type {Content} from '@google/genai';
import {isSpanContextValid, trace} from '@opentelemetry/api';
import {randomBytes} from 'node:crypto';

import {BatchProcessor, type DropStats} from './batch_processor.js';
import {
  type BigQueryAgentAnalyticsPluginOptions,
  type BigQueryLoggerConfig,
  createBigQueryLoggerConfig,
  validateLoggerConfig,
} from './config.js';
import {
  convertKeysToSnakeCase,
  parseContent,
  sanitizeText,
  smartTruncate,
} from './content_parser.js';
import {
  ADK_ENVELOPE_SCHEMA_VERSION,
  type ContentPartRow,
  type EventRow,
} from './event_schema.js';
import {
  createStorageWriter,
  ensureTable,
  type StorageWriter,
} from './storage_write_client.js';
import {TraceManager} from './trace_manager.js';

const logger = getLogger();

function getToolOrigin(tool: BaseTool): 'SUB_AGENT' | 'LOCAL' | 'UNKNOWN' {
  if (isAgentTool(tool)) {
    return 'SUB_AGENT';
  }
  if (isFunctionTool(tool)) {
    return 'LOCAL';
  }
  return 'UNKNOWN';
}

function resolveAgentModel(agent: BaseAgent): string | undefined {
  let curr: BaseAgent | undefined = agent;
  for (let i = 0; i < 16 && curr; i++) {
    if (isLlmAgent(curr) && curr.model) {
      if (typeof curr.model === 'string') {
        return curr.model;
      }
      if (
        typeof curr.model === 'object' &&
        curr.model !== null &&
        'model' in curr.model &&
        typeof curr.model.model === 'string'
      ) {
        return curr.model.model;
      }
    }
    curr = curr.parentAgent;
  }
  return undefined;
}

function extractInvocationAndBranch(ctx: InvocationContext | Context): {
  invocationId: string;
  branch: string;
} {
  if ('invocationContext' in ctx && ctx.invocationContext) {
    return {
      invocationId: ctx.invocationContext.invocationId,
      branch: ctx.invocationContext.branch ?? '',
    };
  }
  const inv = ctx as InvocationContext;
  return {
    invocationId: inv.invocationId,
    branch: inv.branch ?? '',
  };
}

function extractSessionId(ctx: InvocationContext | Context): string {
  if ('invocationContext' in ctx && ctx.invocationContext) {
    return ctx.invocationContext.session.id;
  }
  const inv = ctx as InvocationContext;
  return inv.session?.id ?? '';
}

function extractUserId(ctx: InvocationContext | Context): string {
  if ('invocationContext' in ctx && ctx.invocationContext) {
    return (
      ctx.invocationContext.userId ??
      ctx.invocationContext.session?.userId ??
      ''
    );
  }
  const inv = ctx as InvocationContext;
  return inv.userId ?? inv.session?.userId ?? '';
}

function extractAgentName(ctx: InvocationContext | Context): string | null {
  if ('agent' in ctx && ctx.agent) {
    return ctx.agent.name;
  }
  if ('invocationContext' in ctx && ctx.invocationContext?.agent) {
    return ctx.invocationContext.agent.name;
  }
  if ('agentName' in ctx && typeof ctx.agentName === 'string') {
    return ctx.agentName;
  }
  return null;
}

function getRootAgentName(ctx: InvocationContext | Context): string | null {
  let agent: BaseAgent | undefined;
  if ('invocationContext' in ctx && ctx.invocationContext) {
    agent = ctx.invocationContext.agent;
  } else if ('agent' in ctx && (ctx as {agent?: BaseAgent}).agent) {
    agent = (ctx as {agent?: BaseAgent}).agent;
  }
  if (!agent) {
    return null;
  }
  let curr = agent;
  while (curr.parentAgent) {
    curr = curr.parentAgent;
  }
  return curr.name ?? null;
}

/**
 * BigQuery analytics plugin that writes ADK agent lifecycle events to BigQuery.
 */
export class BigQueryAgentAnalyticsPlugin extends BasePlugin {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly config: BigQueryLoggerConfig;

  private readonly traceManager = new TraceManager();
  private readonly toolErrorContexts = new WeakSet<Context>();

  private storageWriter: StorageWriter | undefined;
  private batchProcessor: BatchProcessor | undefined;

  private generation = 0;
  private isStarted = false;
  private isShuttingDown = false;
  private isShutDown = false;
  private setupPromise: Promise<
    'ok' | 'disabled' | 'failed' | 'aborted'
  > | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private setupFailures = 0;
  private nextSetupRetryTime = 0;

  private setupUnavailableDrops = 0;
  private shutdownRaceDrops = 0;
  private contentParseFailedDrops = 0;

  constructor(options: BigQueryAgentAnalyticsPluginOptions) {
    super('bigquery_agent_analytics');
    this.projectId = options.projectId;
    this.datasetId = options.datasetId;
    this.config = createBigQueryLoggerConfig(options.config);
    this.tableId =
      options.tableId ?? options.config?.tableId ?? this.config.tableId;
    validateLoggerConfig(this.config);
  }

  private async ensureStarted(): Promise<
    'ok' | 'disabled' | 'failed' | 'aborted'
  > {
    if (!this.config.enabled) {
      return 'disabled';
    }
    if (this.isShutDown || this.isShuttingDown) {
      return 'aborted';
    }
    if (this.isStarted && this.batchProcessor) {
      return 'ok';
    }
    if (Date.now() < this.nextSetupRetryTime) {
      this.setupUnavailableDrops += 1;
      return 'failed';
    }
    if (this.setupPromise !== null) {
      return this.setupPromise;
    }

    const gen = this.generation;
    this.setupPromise = (async () => {
      try {
        await ensureTable({
          projectId: this.projectId,
          datasetId: this.datasetId,
          tableId: this.tableId,
          clusteringFields: this.config.clusteringFields,
        });

        const writer = await createStorageWriter({
          projectId: this.projectId,
          datasetId: this.datasetId,
          tableId: this.tableId,
        });

        if (this.generation !== gen || this.isShutDown || this.isShuttingDown) {
          await writer.close();
          this.shutdownRaceDrops += 1;
          return 'aborted';
        }

        this.storageWriter = writer;
        this.batchProcessor = new BatchProcessor({
          writeRows: (rows) => writer.writeRows(rows),
          batchSize: this.config.batchSize,
          flushInterval: this.config.batchFlushInterval,
          retryConfig: this.config.retryConfig,
          queueMaxSize: this.config.queueMaxSize,
          shutdownTimeout: this.config.shutdownTimeout,
        });
        this.isStarted = true;
        this.setupFailures = 0;
        return 'ok';
      } catch (err: unknown) {
        this.setupFailures += 1;
        const backoffSeconds = Math.min(
          60,
          Math.pow(2, Math.min(this.setupFailures, 6)),
        );
        this.nextSetupRetryTime = Date.now() + backoffSeconds * 1000;
        this.setupUnavailableDrops += 1;
        logger.warn(
          `BigQueryAgentAnalyticsPlugin table/writer setup failed: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        );
        return 'failed';
      } finally {
        this.setupPromise = null;
      }
    })();

    return this.setupPromise;
  }

  private async safeExecute<T>(
    eventType: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : 'Error';
      logger.warn(
        `BigQueryAgentAnalyticsPlugin error in ${eventType}: ${errorName}`,
      );
      return undefined;
    }
  }

  private enrichAttributes(
    ctx: InvocationContext | Context,
    options: {
      readonly extraAttributes?: Readonly<Record<string, unknown>>;
      readonly model?: string;
      readonly modelVersion?: string;
      readonly usageMetadata?: unknown;
      readonly finishReason?: string;
      readonly cacheType?: string;
    },
  ): Record<string, unknown> {
    const attrs: Record<string, unknown> = {...(options.extraAttributes ?? {})};

    const invCtx =
      'invocationContext' in ctx && ctx.invocationContext
        ? ctx.invocationContext
        : (ctx as InvocationContext);

    attrs['adk'] = {
      schema_version: ADK_ENVELOPE_SCHEMA_VERSION,
      app_name: invCtx.session?.appName ?? null,
    };

    attrs['root_agent_name'] = getRootAgentName(ctx);

    if (options.model) {
      attrs['model'] = options.model;
    }
    if (options.modelVersion) {
      attrs['model_version'] = options.modelVersion;
    }
    if (options.usageMetadata) {
      attrs['usage_metadata'] = convertKeysToSnakeCase(options.usageMetadata);
    }
    if (options.finishReason) {
      attrs['finish_reason'] = options.finishReason;
    }
    if (options.cacheType) {
      attrs['cache_type'] = options.cacheType;
    }

    if (this.config.logSessionMetadata) {
      const session = invCtx.session;
      if (session) {
        const sessionMeta: Record<string, unknown> = {
          session_id: session.id,
          app_name: session.appName,
          user_id: session.userId,
        };
        if (session.state && Object.keys(session.state).length > 0) {
          sessionMeta['state'] = smartTruncate(
            session.state,
            this.config.maxContentLength,
          ).value;
        }
        attrs['session_metadata'] = sessionMeta;
      }
    }

    if (
      this.config.customTags &&
      Object.keys(this.config.customTags).length > 0
    ) {
      attrs['custom_tags'] = this.config.customTags;
    }

    if (this.config.enableOtelCorrelation) {
      const ambientSpan = trace.getActiveSpan();
      const ambientCtx = ambientSpan?.spanContext();
      if (ambientCtx && isSpanContextValid(ambientCtx)) {
        attrs['otel'] = {
          span_id: ambientCtx.spanId,
          trace_id: ambientCtx.traceId,
        };
      }
    }

    return attrs;
  }

  private async logEvent(
    eventType: string,
    ctx: InvocationContext | Context,
    rawContent: unknown,
    options: {
      readonly spanIdOverride?: string | null;
      readonly parentSpanIdOverride?: string | null;
      readonly traceIdOverride?: string | null;
      readonly latencyMs?: {
        readonly total_ms?: number;
        readonly time_to_first_token_ms?: number;
      };
      readonly status?: 'OK' | 'ERROR';
      readonly errorMessage?: string | null;
      readonly extraAttributes?: Readonly<Record<string, unknown>>;
      readonly model?: string;
      readonly modelVersion?: string;
      readonly usageMetadata?: unknown;
      readonly finishReason?: string;
      readonly cacheType?: string;
    } = {},
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    if (
      this.config.eventAllowlist &&
      !this.config.eventAllowlist.includes(eventType)
    ) {
      return;
    }
    if (
      this.config.eventDenylist &&
      this.config.eventDenylist.includes(eventType)
    ) {
      return;
    }

    const startOutcome = await this.ensureStarted();
    if (startOutcome !== 'ok' || !this.batchProcessor) {
      return;
    }

    const resolvedIds = this.traceManager.resolveIds(
      {
        traceIdOverride: options.traceIdOverride,
        spanIdOverride: options.spanIdOverride,
        parentSpanIdOverride: options.parentSpanIdOverride,
      },
      ctx,
    );

    let contentPayload: unknown = null;
    let contentParts: ContentPartRow[] = [];
    let isTruncated = false;

    try {
      const parseResult = parseContent(
        rawContent,
        this.config.maxContentLength,
      );
      contentPayload = parseResult.content;
      contentParts = this.config.logMultiModalContent
        ? parseResult.contentParts
        : [];
      isTruncated = parseResult.truncated;
    } catch {
      this.contentParseFailedDrops += 1;
      contentPayload = '[CONTENT_PARSE_FAILED]';
      isTruncated = true;
    }

    let safeErrorMessage: string | null = null;
    if (options.errorMessage) {
      const sanitizedError = sanitizeText(
        options.errorMessage,
        this.config.maxContentLength,
      );
      safeErrorMessage = sanitizedError.value;
      if (sanitizedError.truncated) {
        isTruncated = true;
      }
    }

    const attributes = this.enrichAttributes(ctx, options);
    const truncatedAttributes = smartTruncate(
      attributes,
      this.config.maxContentLength,
    );
    if (truncatedAttributes.truncated) {
      isTruncated = true;
    }

    const invInfo = extractInvocationAndBranch(ctx);
    const invocationId = invInfo.invocationId;
    const agentName = extractAgentName(ctx);
    const sessionId = extractSessionId(ctx);
    const userId = extractUserId(ctx);

    const row: EventRow = {
      timestamp: new Date(),
      event_id: randomBytes(16).toString('hex'),
      event_type: eventType,
      agent: agentName,
      session_id: sessionId,
      invocation_id: invocationId,
      user_id: userId,
      trace_id: resolvedIds.traceId,
      span_id: resolvedIds.spanId,
      parent_span_id: resolvedIds.parentSpanId,
      content: contentPayload !== null ? JSON.stringify(contentPayload) : null,
      content_parts: contentParts,
      attributes: JSON.stringify(truncatedAttributes.value),
      latency_ms: options.latencyMs ? JSON.stringify(options.latencyMs) : null,
      status: options.status ?? 'OK',
      error_message: safeErrorMessage,
      is_truncated: isTruncated,
    };

    this.batchProcessor.append(row);
  }

  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return this.safeExecute('beforeRunCallback', async () => {
      this.traceManager.ensureInvocationSpan(params.invocationContext);
      await this.logEvent(
        'INVOCATION_STARTING',
        params.invocationContext,
        params.invocationContext.userContent,
      );
      return undefined;
    });
  }

  override async afterRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    await this.safeExecute('afterRunCallback', async () => {
      const traceId = this.traceManager.traceId(params.invocationContext);
      const popResult = this.traceManager.popSpan(
        'invocation',
        params.invocationContext,
      );
      await this.logEvent(
        'INVOCATION_COMPLETED',
        params.invocationContext,
        undefined,
        {
          traceIdOverride: traceId,
          spanIdOverride: popResult.spanId,
          latencyMs:
            popResult.durationMs !== undefined
              ? {total_ms: popResult.durationMs}
              : undefined,
        },
      );
      this.traceManager.clearInvocation(params.invocationContext.invocationId);
      if (this.config.flushOnRunEnd) {
        await this.flush();
      }
    });
  }

  override async beforeAgentCallback(params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return this.safeExecute('beforeAgentCallback', async () => {
      this.traceManager.pushSpan(params.callbackContext, 'agent');

      const extraAttributes: Record<string, unknown> = {};
      let content: string | null = null;

      if (isLlmAgent(params.agent)) {
        const isProvider = typeof params.agent.instruction === 'function';
        const instructionStr =
          typeof params.agent.instruction === 'string'
            ? params.agent.instruction
            : undefined;
        content = isProvider ? null : (instructionStr ?? null);

        if (isProvider) {
          extraAttributes['instruction_source'] = 'provider';
        } else if (instructionStr) {
          extraAttributes['static_instruction'] = instructionStr;
        }
      }

      if (params.agent.description) {
        extraAttributes['agent_description'] = params.agent.description;
      }
      if (params.agent.subAgents && params.agent.subAgents.length > 0) {
        extraAttributes['sub_agents'] = params.agent.subAgents.map(
          (s) => s.name,
        );
      }
      const model = resolveAgentModel(params.agent);
      if (model) {
        extraAttributes['model'] = model;
      }

      await this.logEvent('AGENT_STARTING', params.callbackContext, content, {
        extraAttributes,
        model,
      });
      return undefined;
    });
  }

  override async afterAgentCallback(params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return this.safeExecute('afterAgentCallback', async () => {
      const popResult = this.traceManager.popSpan(
        'agent',
        params.callbackContext,
      );
      await this.logEvent(
        'AGENT_COMPLETED',
        params.callbackContext,
        undefined,
        {
          spanIdOverride: popResult.spanId,
          latencyMs:
            popResult.durationMs !== undefined
              ? {total_ms: popResult.durationMs}
              : undefined,
        },
      );
      return undefined;
    });
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return this.safeExecute('beforeModelCallback', async () => {
      this.traceManager.pushSpan(params.callbackContext, 'llm_request');

      const extraAttributes: Record<string, unknown> = {};
      if (params.llmRequest.config) {
        const c = params.llmRequest.config;
        const llmConfig: Record<string, unknown> = {};
        if (c.temperature !== undefined)
          llmConfig['temperature'] = c.temperature;
        if (c.topP !== undefined) llmConfig['top_p'] = c.topP;
        if (c.topK !== undefined) llmConfig['top_k'] = c.topK;
        if (c.candidateCount !== undefined)
          llmConfig['candidate_count'] = c.candidateCount;
        if (c.maxOutputTokens !== undefined)
          llmConfig['max_output_tokens'] = c.maxOutputTokens;
        if (c.stopSequences !== undefined)
          llmConfig['stop_sequences'] = c.stopSequences;
        if (c.presencePenalty !== undefined)
          llmConfig['presence_penalty'] = c.presencePenalty;
        if (c.frequencyPenalty !== undefined)
          llmConfig['frequency_penalty'] = c.frequencyPenalty;
        if (c.responseMimeType !== undefined)
          llmConfig['response_mime_type'] = c.responseMimeType;
        if (c.responseSchema !== undefined)
          llmConfig['response_schema'] = convertKeysToSnakeCase(
            c.responseSchema,
          );
        if (c.seed !== undefined) llmConfig['seed'] = c.seed;
        if (c.responseLogprobs !== undefined)
          llmConfig['response_logprobs'] = c.responseLogprobs;
        if (c.logprobs !== undefined) llmConfig['logprobs'] = c.logprobs;
        extraAttributes['llm_config'] = llmConfig;

        if (c.labels) {
          extraAttributes['labels'] = c.labels;
        }

        if (c.tools && c.tools.length > 0) {
          const toolsList: unknown[] = [];
          for (const tool of c.tools) {
            if (
              typeof tool === 'object' &&
              tool !== null &&
              'functionDeclarations' in tool &&
              Array.isArray(
                (tool as {functionDeclarations?: unknown[]})
                  .functionDeclarations,
              )
            ) {
              const fds = (
                tool as {
                  functionDeclarations: Array<{
                    name: string;
                    description?: string;
                    parameters?: unknown;
                  }>;
                }
              ).functionDeclarations;
              for (const fd of fds) {
                toolsList.push({
                  name: fd.name,
                  description: fd.description ?? '',
                  parameters: fd.parameters
                    ? convertKeysToSnakeCase(fd.parameters)
                    : undefined,
                });
              }
            }
          }
          if (toolsList.length > 0) {
            extraAttributes['tools'] = toolsList;
          }
        }
      }

      await this.logEvent(
        'LLM_REQUEST',
        params.callbackContext,
        params.llmRequest,
        {
          model: params.llmRequest.model,
          extraAttributes,
        },
      );
      return undefined;
    });
  }

  override async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return this.safeExecute('afterModelCallback', async () => {
      const isPartial = params.llmResponse.partial === true;
      const currentSpanId = this.traceManager.currentSpanId(
        params.callbackContext,
      );
      if (currentSpanId) {
        this.traceManager.recordFirstToken(
          currentSpanId,
          params.callbackContext,
        );
      }

      let popResult: ReturnType<TraceManager['popSpan']> | undefined;
      let latencyMs:
        {total_ms?: number; time_to_first_token_ms?: number} | undefined;

      if (!isPartial) {
        popResult = this.traceManager.popSpan(
          'llm_request',
          params.callbackContext,
        );
        if (popResult.durationMs !== undefined) {
          latencyMs = {total_ms: popResult.durationMs};
          if (
            popResult.firstTokenTime !== undefined &&
            popResult.startTime !== undefined
          ) {
            latencyMs = {
              ...latencyMs,
              time_to_first_token_ms: Math.round(
                (popResult.firstTokenTime - popResult.startTime) * 1000,
              ),
            };
          }
        }
      }

      const content = {
        response: params.llmResponse.content,
        usage: params.llmResponse.usageMetadata
          ? {
              prompt: params.llmResponse.usageMetadata.promptTokenCount,
              completion: params.llmResponse.usageMetadata.candidatesTokenCount,
              total: params.llmResponse.usageMetadata.totalTokenCount,
            }
          : undefined,
      };

      const finishReason = params.llmResponse.finishReason;

      await this.logEvent('LLM_RESPONSE', params.callbackContext, content, {
        spanIdOverride: popResult?.spanId,
        latencyMs,
        modelVersion: params.llmResponse.modelVersion,
        usageMetadata: params.llmResponse.usageMetadata,
        finishReason,
        errorMessage: params.llmResponse.errorMessage,
      });
      return undefined;
    });
  }

  override async onModelErrorCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return this.safeExecute('onModelErrorCallback', async () => {
      const popResult = this.traceManager.popSpan(
        'llm_request',
        params.callbackContext,
      );
      await this.logEvent('LLM_ERROR', params.callbackContext, undefined, {
        spanIdOverride: popResult.spanId,
        latencyMs:
          popResult.durationMs !== undefined
            ? {total_ms: popResult.durationMs}
            : undefined,
        status: 'ERROR',
        errorMessage: params.error.message,
      });
      return undefined;
    });
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return this.safeExecute('beforeToolCallback', async () => {
      this.traceManager.pushSpan(params.toolContext, 'tool');
      const content = {
        tool: params.tool.name,
        args: params.toolArgs,
        tool_origin: getToolOrigin(params.tool),
      };
      await this.logEvent('TOOL_STARTING', params.toolContext, content);
      return undefined;
    });
  }

  override async afterToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    return this.safeExecute('afterToolCallback', async () => {
      if (this.toolErrorContexts.has(params.toolContext)) {
        return undefined;
      }

      const popResult = this.traceManager.popSpan('tool', params.toolContext);
      const isError =
        params.result &&
        (params.result['isError'] === true ||
          params.result['is_error'] === true);

      if (isError) {
        const content = {
          tool: params.tool.name,
          args: params.toolArgs,
          tool_origin: getToolOrigin(params.tool),
        };
        await this.logEvent('TOOL_ERROR', params.toolContext, content, {
          spanIdOverride: popResult.spanId,
          latencyMs:
            popResult.durationMs !== undefined
              ? {total_ms: popResult.durationMs}
              : undefined,
          status: 'ERROR',
          errorMessage:
            typeof params.result['error'] === 'string'
              ? params.result['error']
              : 'Tool reported error',
        });
      } else {
        const content = {
          tool: params.tool.name,
          result: params.result,
          tool_origin: getToolOrigin(params.tool),
        };
        await this.logEvent('TOOL_COMPLETED', params.toolContext, content, {
          spanIdOverride: popResult.spanId,
          latencyMs:
            popResult.durationMs !== undefined
              ? {total_ms: popResult.durationMs}
              : undefined,
          status: 'OK',
        });
      }
      return undefined;
    });
  }

  override async onToolErrorCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    return this.safeExecute('onToolErrorCallback', async () => {
      this.toolErrorContexts.add(params.toolContext);
      const popResult = this.traceManager.popSpan('tool', params.toolContext);
      const content = {
        tool: params.tool.name,
        args: params.toolArgs,
        tool_origin: getToolOrigin(params.tool),
      };
      await this.logEvent('TOOL_ERROR', params.toolContext, content, {
        spanIdOverride: popResult.spanId,
        latencyMs:
          popResult.durationMs !== undefined
            ? {total_ms: popResult.durationMs}
            : undefined,
        status: 'ERROR',
        errorMessage: params.error.message,
      });
      return undefined;
    });
  }

  override async onEventCallback(params: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    return this.safeExecute('onEventCallback', async () => {
      if (params.event.partial !== true) {
        this.traceManager.popSpan('llm_request', params.invocationContext);
      }
      return undefined;
    });
  }

  /**
   * Flushes all queued rows and waits for in-flight writes to complete.
   */
  async flush(): Promise<void> {
    if (this.batchProcessor) {
      await this.batchProcessor.flush();
    }
  }

  /**
   * Shuts down the plugin, draining the queue within the timeout and releasing clients.
   */
  async shutdown(timeoutSeconds?: number): Promise<void> {
    if (this.isShutDown) {
      return;
    }
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }

    this.generation += 1;
    this.isShuttingDown = true;

    this.shutdownPromise = (async () => {
      try {
        if (this.batchProcessor) {
          await this.batchProcessor.shutdown(
            timeoutSeconds ?? this.config.shutdownTimeout,
          );
        }
        if (this.storageWriter) {
          await this.storageWriter.close();
        }
      } finally {
        this.isShuttingDown = false;
        this.isShutDown = true;
        this.shutdownPromise = null;
      }
    })();

    return this.shutdownPromise;
  }

  /**
   * Returns a copy of the drop statistics counters.
   */
  getDropStats(): DropStats {
    const processorStats = this.batchProcessor
      ? this.batchProcessor.getDropStats()
      : {
          queue_full: 0,
          encode_failed: 0,
          retry_exhausted: 0,
          non_retryable: 0,
          unexpected_error: 0,
          shutdown_timeout: 0,
          shutdown_cancelled: 0,
          permission_denied: 0,
          not_found: 0,
        };

    return {
      ...processorStats,
      setup_unavailable:
        (processorStats.setup_unavailable ?? 0) + this.setupUnavailableDrops,
      shutdown_race:
        (processorStats.shutdown_race ?? 0) + this.shutdownRaceDrops,
      content_parse_failed:
        (processorStats.content_parse_failed ?? 0) +
        this.contentParseFailedDrops,
    };
  }
}
