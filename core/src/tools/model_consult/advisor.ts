/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Advisor model invocation helper for {@link ModelConsultTool}.
 *
 * Runs a single, tool-free reasoning turn on the configured advisor `BaseLlm`
 * (by default `gemini-3.1-pro-preview`) with configurable `ThinkingLevel`,
 * output token cap, timeout, and automatic fallback if the target model does
 * not accept `thinkingConfig`.
 */

import {
  Content,
  FinishReason,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  ThinkingConfig,
  ThinkingLevel,
} from '@google/genai';

import {BaseLlm, isBaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {LLMRegistry} from '../../models/registry.js';
import {logger} from '../../utils/logger.js';
import {ADVISOR_SYSTEM_INSTRUCTION, DEFAULT_ADVISOR_MODEL} from './prompts.js';

export type ThinkingLevelName = 'minimal' | 'low' | 'medium' | 'high';

const THINKING_LEVEL_MAP: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

const VALID_THINKING_ENUM_VALUES = new Set<string>([
  ThinkingLevel.MINIMAL,
  ThinkingLevel.LOW,
  ThinkingLevel.MEDIUM,
  ThinkingLevel.HIGH,
]);

/**
 * Normalizes a string or `ThinkingLevel` enum into a `ThinkingLevel`.
 */
export function resolveThinkingLevel(
  level: string | ThinkingLevel | undefined | null,
): ThinkingLevel | undefined {
  if (
    level === undefined ||
    level === null ||
    level === ThinkingLevel.THINKING_LEVEL_UNSPECIFIED
  ) {
    return undefined;
  }
  if (typeof level === 'string') {
    if (VALID_THINKING_ENUM_VALUES.has(level)) {
      return level as ThinkingLevel;
    }
    const key = level.trim().toLowerCase();
    if (
      key === '' ||
      key === 'none' ||
      key === 'off' ||
      key === 'thinking_level_unspecified'
    ) {
      return undefined;
    }
    if (key in THINKING_LEVEL_MAP) {
      return THINKING_LEVEL_MAP[key];
    }
  }
  throw new Error(
    `Invalid advisor thinking_level '${String(level)}'. Choose from: minimal, low, medium, high, or None.`,
  );
}

/**
 * Resolves a model name or `BaseLlm` instance into a `BaseLlm`.
 */
export function resolveAdvisorLlm(
  model: string | BaseLlm = DEFAULT_ADVISOR_MODEL,
): BaseLlm {
  if (isBaseLlm(model)) {
    return model;
  }
  if (typeof model === 'string' && model.trim()) {
    return LLMRegistry.newLlm(model.trim());
  }
  throw new Error(
    `Invalid advisor_model: expected a non-empty model string or BaseLlm instance, got ${JSON.stringify(model)}.`,
  );
}

export interface AdvisorUsageParams {
  promptTokens?: number;
  prompt_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  thoughtsTokens?: number;
  thoughts_tokens?: number;
  cachedTokens?: number;
  cached_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
}

/**
 * Token accounting for a single advisor consultation.
 */
export class AdvisorUsage {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtsTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;

  constructor(params: AdvisorUsageParams = {}) {
    this.promptTokens = params.promptTokens ?? params.prompt_tokens ?? 0;
    this.outputTokens = params.outputTokens ?? params.output_tokens ?? 0;
    this.thoughtsTokens = params.thoughtsTokens ?? params.thoughts_tokens ?? 0;
    this.cachedTokens = params.cachedTokens ?? params.cached_tokens ?? 0;
    this.totalTokens = params.totalTokens ?? params.total_tokens ?? 0;
  }

  get prompt_tokens(): number {
    return this.promptTokens;
  }

  get output_tokens(): number {
    return this.outputTokens;
  }

  get thoughts_tokens(): number {
    return this.thoughtsTokens;
  }

  get cached_tokens(): number {
    return this.cachedTokens;
  }

  get total_tokens(): number {
    return this.totalTokens;
  }

  static fromMetadata(
    meta:
      | GenerateContentResponseUsageMetadata
      | Record<string, unknown>
      | undefined
      | null,
  ): AdvisorUsage {
    if (!meta || typeof meta !== 'object') {
      return new AdvisorUsage();
    }
    const raw = meta as Record<string, unknown>;
    const toInt = (val: unknown): number => {
      const n = Number(val);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    };
    return new AdvisorUsage({
      promptTokens: toInt(raw.promptTokenCount ?? raw.prompt_token_count),
      outputTokens: toInt(
        raw.candidatesTokenCount ?? raw.candidates_token_count,
      ),
      thoughtsTokens: toInt(raw.thoughtsTokenCount ?? raw.thoughts_token_count),
      cachedTokens: toInt(
        raw.cachedContentTokenCount ?? raw.cached_content_token_count,
      ),
      totalTokens: toInt(raw.totalTokenCount ?? raw.total_token_count),
    });
  }

  add(other: AdvisorUsage): AdvisorUsage {
    return new AdvisorUsage({
      promptTokens: this.promptTokens + other.promptTokens,
      outputTokens: this.outputTokens + other.outputTokens,
      thoughtsTokens: this.thoughtsTokens + other.thoughtsTokens,
      cachedTokens: this.cachedTokens + other.cachedTokens,
      totalTokens: this.totalTokens + other.totalTokens,
    });
  }

  toDict(): Record<string, number> {
    return {
      prompt_tokens: this.promptTokens,
      output_tokens: this.outputTokens,
      thoughts_tokens: this.thoughtsTokens,
      cached_tokens: this.cachedTokens,
      total_tokens: this.totalTokens,
    };
  }
}

export interface AdvisorResultParams {
  guidance: string;
  modelVersion: string;
  thinkingLevel?: string;
  usage: AdvisorUsage;
  latencyMs: number;
}

/**
 * Structured output from an advisor consultation.
 */
export class AdvisorResult {
  readonly guidance: string;
  readonly modelVersion: string;
  readonly thinkingLevel?: string;
  readonly usage: AdvisorUsage;
  readonly latencyMs: number;

  constructor(params: AdvisorResultParams) {
    this.guidance = params.guidance;
    this.modelVersion = params.modelVersion;
    this.thinkingLevel = params.thinkingLevel;
    this.usage = params.usage;
    this.latencyMs = params.latencyMs;
  }

  get model_version(): string {
    return this.modelVersion;
  }

  get thinking_level(): string | undefined {
    return this.thinkingLevel;
  }

  get latency_ms(): number {
    return this.latencyMs;
  }
}

/**
 * Raised when the advisor model fails or returns an empty response.
 */
export class AdvisorError extends Error {
  override name = 'AdvisorError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, AdvisorError.prototype);
  }
}

function cloneGenerateContentConfig(
  baseConfig?: GenerateContentConfig,
): GenerateContentConfig {
  if (!baseConfig) {
    return {};
  }
  const copy: GenerateContentConfig = {...baseConfig};
  const raw = baseConfig as Record<string, unknown>;
  const existingThinking = (baseConfig.thinkingConfig ??
    raw.thinking_config) as ThinkingConfig | undefined;
  if (existingThinking && typeof existingThinking === 'object') {
    copy.thinkingConfig = {...existingThinking};
  }
  if (
    copy.maxOutputTokens === undefined &&
    typeof raw.max_output_tokens === 'number'
  ) {
    copy.maxOutputTokens = raw.max_output_tokens;
  }
  return copy;
}

function buildAdvisorRequest(options: {
  modelName: string;
  contents: Content[];
  systemInstruction: string;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  baseConfig?: GenerateContentConfig;
  clearThinkingConfig?: boolean;
}): LlmRequest {
  const config = cloneGenerateContentConfig(options.baseConfig);
  config.systemInstruction = options.systemInstruction;
  // The advisor never executes tools itself; strip any inherited declarations.
  config.tools = [];
  config.toolConfig = undefined;
  delete (config as Record<string, unknown>).tool_config;

  if (
    options.maxOutputTokens !== undefined &&
    options.maxOutputTokens !== null
  ) {
    config.maxOutputTokens = options.maxOutputTokens;
  }

  if (options.clearThinkingConfig) {
    config.thinkingConfig = undefined;
    delete (config as Record<string, unknown>).thinking_config;
  } else if (options.thinkingLevel !== undefined) {
    const existing = config.thinkingConfig ? {...config.thinkingConfig} : {};
    existing.thinkingLevel = options.thinkingLevel;
    // Do not stream internal thought text into the advisor's visible output
    // unless the caller explicitly asked for it in baseConfig.
    const rawExisting = existing as Record<string, unknown>;
    if (
      existing.includeThoughts === undefined &&
      rawExisting.include_thoughts === undefined
    ) {
      existing.includeThoughts = false;
    }
    config.thinkingConfig = existing;
  }

  return {
    model: options.modelName,
    contents: [...options.contents],
    config,
    liveConnectConfig: {},
    toolsDict: {},
  };
}

function isThinkingConfigError(exc: unknown): boolean {
  const msg = String(exc instanceof Error ? exc.message : exc).toLowerCase();
  const thinkingMarkers = [
    'thinking',
    'thinking_config',
    'thinkingconfig',
    'thinking_level',
    'thinkinglevel',
  ];
  const rejectMarkers = [
    'unsupported',
    'not supported',
    'invalid',
    'unknown',
    'unrecognized',
    'not allowed',
    'cannot be set',
  ];
  return (
    thinkingMarkers.some((m) => msg.includes(m)) &&
    rejectMarkers.some((m) => msg.includes(m))
  );
}

class AdvisorTimeoutError extends Error {
  override name = 'AdvisorTimeoutError';
}

async function collectWithOptionalTimeout<T>(
  iterable: AsyncIterable<T>,
  deadlineMs: number | undefined,
  onItem: (item: T) => void,
): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      let nextPromise = iterator.next();
      if (deadlineMs !== undefined) {
        const remainingMs = deadlineMs - performance.now();
        if (remainingMs <= 0) {
          throw new AdvisorTimeoutError('Timed out');
        }
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timerId = setTimeout(() => {
            reject(new AdvisorTimeoutError('Timed out'));
          }, remainingMs);
        });
        try {
          nextPromise = Promise.race([nextPromise, timeoutPromise]);
          const step = await nextPromise;
          if (step.done) {
            break;
          }
          onItem(step.value);
          continue;
        } finally {
          if (timerId !== undefined) {
            clearTimeout(timerId);
          }
        }
      }
      const step = await nextPromise;
      if (step.done) {
        break;
      }
      onItem(step.value);
    }
  } finally {
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch {
        // Ignore cleanup errors on aborted streams.
      }
    }
  }
}

export interface CallAdvisorOptions {
  systemInstruction?: string;
  system_instruction?: string;
  thinkingLevel?: string | ThinkingLevel | null;
  thinking_level?: string | ThinkingLevel | null;
  maxOutputTokens?: number | null;
  max_output_tokens?: number | null;
  generateContentConfig?: GenerateContentConfig;
  generate_content_config?: GenerateContentConfig;
  timeoutSeconds?: number | null;
  timeout_seconds?: number | null;
}

/**
 * Executes a single non-streaming advisor turn and returns its guidance.
 */
export async function callAdvisor(
  llm: BaseLlm,
  contents: Content[],
  options: CallAdvisorOptions = {},
): Promise<AdvisorResult> {
  const systemInstruction =
    options.systemInstruction ??
    options.system_instruction ??
    ADVISOR_SYSTEM_INSTRUCTION;
  const rawThinkingLevel =
    options.thinkingLevel !== undefined
      ? options.thinkingLevel
      : options.thinking_level !== undefined
        ? options.thinking_level
        : 'high';
  const maxOutputTokens =
    options.maxOutputTokens !== undefined
      ? (options.maxOutputTokens ?? undefined)
      : (options.generateContentConfig?.maxOutputTokens ??
        (
          options.generate_content_config as
            | {max_output_tokens?: number}
            | undefined
        )?.max_output_tokens ??
        options.max_output_tokens ??
        undefined);
  const generateContentConfig =
    options.generateContentConfig ?? options.generate_content_config;
  const timeoutSeconds =
    options.timeoutSeconds !== undefined
      ? options.timeoutSeconds
      : options.timeout_seconds;

  if (
    timeoutSeconds !== undefined &&
    timeoutSeconds !== null &&
    timeoutSeconds <= 0
  ) {
    throw new Error(
      `timeout_seconds must be > 0 when set, got ${timeoutSeconds}.`,
    );
  }

  const resolvedThinking = resolveThinkingLevel(rawThinkingLevel);
  const callerSetThinking = Boolean(
    generateContentConfig?.thinkingConfig !== undefined ||
    (generateContentConfig as Record<string, unknown> | undefined)
      ?.thinking_config !== undefined,
  );
  const request = buildAdvisorRequest({
    modelName: llm.model,
    contents,
    systemInstruction,
    thinkingLevel: resolvedThinking,
    maxOutputTokens,
    baseConfig: generateContentConfig,
  });

  const startMs = performance.now();
  const deadlineMs =
    timeoutSeconds !== undefined && timeoutSeconds !== null
      ? startMs + timeoutSeconds * 1000
      : undefined;

  const runAttempt = async (
    req: LlmRequest,
    attemptDeadlineMs: number | undefined,
  ): Promise<{
    chunks: string[];
    usage: AdvisorUsage;
    modelVersion: string;
    hitMaxTokens: boolean;
  }> => {
    const chunks: string[] = [];
    let usage = new AdvisorUsage();
    let modelVersion = llm.model;
    let hitMaxTokens = false;

    await collectWithOptionalTimeout<LlmResponse>(
      llm.generateContentAsync(req, false),
      attemptDeadlineMs,
      (resp) => {
        if (resp.partial) {
          return;
        }
        const rawResp = resp as Record<string, unknown>;
        const errorCode =
          resp.errorCode ?? (rawResp.error_code as string | undefined);
        const errorMessage =
          resp.errorMessage ?? (rawResp.error_message as string | undefined);

        // ADK's Gemini backend sets `errorCode = finishReason` whenever
        // `finishReason !== STOP`. For `MAX_TOKENS`, the response may still
        // carry usable partial guidance (or may have exhausted its budget on
        // thinking tokens), so handle `MAX_TOKENS` via the dedicated branch
        // below rather than failing immediately here.
        if (errorCode) {
          if (String(errorCode).toUpperCase().endsWith('MAX_TOKENS')) {
            hitMaxTokens = true;
          } else {
            throw new AdvisorError(
              `Advisor model '${llm.model}' returned error (${errorCode}): ${errorMessage || 'unknown error'}`,
            );
          }
        }

        const usageMeta =
          resp.usageMetadata ??
          (rawResp.usage_metadata as
            | GenerateContentResponseUsageMetadata
            | undefined);
        if (usageMeta) {
          usage = usage.add(AdvisorUsage.fromMetadata(usageMeta));
        }

        const respModelVersion =
          resp.modelVersion ?? (rawResp.model_version as string | undefined);
        if (respModelVersion) {
          modelVersion = respModelVersion;
        }

        const finishReason =
          resp.finishReason ??
          (rawResp.finish_reason as FinishReason | string | undefined);
        if (
          finishReason === FinishReason.MAX_TOKENS ||
          (finishReason !== undefined &&
            String(finishReason).toUpperCase().endsWith('MAX_TOKENS'))
        ) {
          hitMaxTokens = true;
        }

        if (resp.content && resp.content.parts) {
          for (const part of resp.content.parts) {
            if (part.thought) {
              continue;
            }
            if (part.text) {
              chunks.push(part.text);
            }
          }
        }
      },
    );

    return {chunks, usage, modelVersion, hitMaxTokens};
  };

  let guidanceChunks: string[];
  let usage: AdvisorUsage;
  let modelVersion: string;
  let hitMaxTokens: boolean;
  let effectiveThinking: ThinkingLevel | undefined = resolvedThinking;

  try {
    const attemptResult = await runAttempt(request, deadlineMs);
    guidanceChunks = attemptResult.chunks;
    usage = attemptResult.usage;
    modelVersion = attemptResult.modelVersion;
    hitMaxTokens = attemptResult.hitMaxTokens;
  } catch (exc) {
    if (exc instanceof AdvisorTimeoutError) {
      throw new AdvisorError(
        `Advisor model '${llm.model}' timed out after ${timeoutSeconds}s.`,
      );
    }
    if (
      (resolvedThinking !== undefined || callerSetThinking) &&
      isThinkingConfigError(exc)
    ) {
      logger.warn(
        `Advisor model '${llm.model}' rejected thinking_config (${String(exc)}); retrying consultation without thinking_config.`,
      );
      const fallbackReq = buildAdvisorRequest({
        modelName: llm.model,
        contents,
        systemInstruction,
        thinkingLevel: undefined,
        maxOutputTokens,
        baseConfig: generateContentConfig,
        clearThinkingConfig: true,
      });
      try {
        const fallbackResult = await runAttempt(fallbackReq, deadlineMs);
        guidanceChunks = fallbackResult.chunks;
        usage = fallbackResult.usage;
        modelVersion = fallbackResult.modelVersion;
        hitMaxTokens = fallbackResult.hitMaxTokens;
        effectiveThinking = undefined;
      } catch (retryExc) {
        if (retryExc instanceof AdvisorTimeoutError) {
          throw new AdvisorError(
            `Advisor model '${llm.model}' timed out after ${timeoutSeconds}s.`,
          );
        }
        if (retryExc instanceof AdvisorError) {
          throw retryExc;
        }
        throw new AdvisorError(
          `Advisor model '${llm.model}' call failed: ${retryExc instanceof Error ? retryExc.message : String(retryExc)}`,
        );
      }
    } else if (exc instanceof AdvisorError) {
      throw exc;
    } else {
      throw new AdvisorError(
        `Advisor model '${llm.model}' call failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  const latencyMs = Math.round((performance.now() - startMs) * 10) / 10;
  let guidance = guidanceChunks.join('\n').trim();
  if (!guidance) {
    if (hitMaxTokens) {
      throw new AdvisorError(
        `Advisor model '${llm.model}' hit max_output_tokens before producing ` +
          'any visible guidance (all output tokens were spent on internal ' +
          'thinking). Increase max_output_tokens or lower thinking_level.',
      );
    }
    throw new AdvisorError(
      `Advisor model '${llm.model}' returned an empty response.`,
    );
  }
  if (hitMaxTokens) {
    guidance = `${guidance}\n\n[advisor guidance truncated at max_output_tokens]`;
  }

  return new AdvisorResult({
    guidance,
    modelVersion,
    thinkingLevel: effectiveThinking
      ? String(effectiveThinking).toLowerCase()
      : undefined,
    usage,
    latencyMs,
  });
}
