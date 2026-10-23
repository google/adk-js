/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * {@link ModelConsultTool}: mid-turn advisor escalation tool for ADK agents.
 *
 * Implements the **advisor pattern**: a fast, cost-effective executor agent
 * handles routine work end-to-end and calls `model_consult` only when it hits a
 * hard architectural, debugging, or high-stakes decision. Unlike sub-agent
 * delegation (`AgentTool`), the executor retains full control of the task while
 * the advisor:
 *
 * - Sees the executor's session transcript (user request, agent turns, tool
 *   calls, and tool results) automatically without the executor having to
 *   re-summarize everything into a prompt argument.
 * - Runs a single, tool-free reasoning turn (defaulting to
 *   `gemini-3.1-pro-preview` with `thinkingLevel='high'`).
 * - Returns concise, structured guidance directly to the executor as a tool
 *   response, along with token usage and remaining consultation budget.
 */

import {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  Part,
  ThinkingLevel,
  Type,
} from '@google/genai';

import {injectSessionState} from '../../agents/instructions.js';
import {InvocationContext} from '../../agents/invocation_context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {Event} from '../../events/event.js';
import {BaseLlm, isBaseLlm} from '../../models/base_llm.js';
import {appendInstructions} from '../../models/llm_request.js';
import {LLMRegistry} from '../../models/registry.js';
import {State} from '../../sessions/state.js';
import {recordStateWrite} from '../../sessions/state_write_order.js';
import {logger} from '../../utils/logger.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from '../base_tool.js';
import {ToolContext} from '../tool_context.js';
import {
  callAdvisor,
  resolveAdvisorLlm,
  resolveThinkingLevel,
  ThinkingLevelName,
} from './advisor.js';
import {
  applyRewinds,
  buildAdvisorContents,
  ModelConsultContextConfig,
  ModelConsultContextConfigOptions,
} from './context.js';
import {
  ADVISOR_HANDOFF_TEMPLATE,
  ADVISOR_SYSTEM_INSTRUCTION,
  CONTEXT_BLOCK_TEMPLATE,
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_TOOL_NAME,
  EXECUTOR_INSTRUCTION,
  TOOL_DESCRIPTION,
} from './prompts.js';

/**
 * Per-session synchronization and reservation state for {@link ModelConsultTool}.
 *
 * Coordinates concurrent `model_consult` calls in the same session so that
 * per-turn (`maxUses`) and per-session (`sessionMaxUses`) caps cannot be
 * bypassed by parallel tool calls, and ensures all parallel `stateDelta` maps
 * in the same invocation converge on the final counter value.
 */
class SessionConsultState {
  readonly turnReserved = new Map<string, number>();
  sessionReserved = 0;
  readonly activeCalls = new Map<string, number>();
  readonly invDeltas = new Map<string, Array<Record<string, unknown>>>();
  commitEpoch = 0;
  nextCommitSeq = 0;
  private waiters: Array<() => void> = [];

  notifyAll(): void {
    const current = this.waiters.splice(0, this.waiters.length);
    for (const resolve of current) {
      resolve();
    }
  }

  async waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

function formatTemplate(
  template: string,
  values: Record<string, string>,
): string {
  let result = template;
  for (const [key, val] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, val);
  }
  return result;
}

/**
 * Extracts plain text from an `LlmAgent.staticInstruction` value.
 */
function extractStaticInstructionText(staticInstruction: unknown): string {
  if (typeof staticInstruction === 'string') {
    return staticInstruction.trim();
  }
  if (!staticInstruction || typeof staticInstruction !== 'object') {
    return '';
  }
  const maybeContent = staticInstruction as {parts?: unknown[]};
  if (Array.isArray(maybeContent.parts)) {
    const chunks: string[] = [];
    for (const part of maybeContent.parts) {
      if (
        part &&
        typeof part === 'object' &&
        typeof (part as Part).text === 'string' &&
        (part as Part).text
      ) {
        chunks.push((part as Part).text!);
      }
    }
    return chunks.join('\n').trim();
  }
  if (typeof (staticInstruction as Part).text === 'string') {
    return ((staticInstruction as Part).text ?? '').trim();
  }
  if (Array.isArray(staticInstruction)) {
    const chunks: string[] = [];
    for (const item of staticInstruction) {
      if (typeof item === 'string' && item) {
        chunks.push(item);
      } else if (
        item &&
        typeof item === 'object' &&
        typeof (item as Part).text === 'string' &&
        (item as Part).text
      ) {
        chunks.push((item as Part).text!);
      }
    }
    return chunks.join('\n').trim();
  }
  return '';
}

/**
 * Options for constructing a {@link ModelConsultTool}.
 *
 * Supports both camelCase and snake_case option names for parity with Python.
 */
export interface ModelConsultToolOptions {
  /**
   * Advisor model name (resolved through `LLMRegistry`) or a pre-configured
   * `BaseLlm` instance. Defaults to `'gemini-3.1-pro-preview'`.
   */
  model?: string | BaseLlm;
  /** Tool name exposed to the executor agent. Defaults to `'model_consult'`. */
  name?: string;
  /** Tool description exposed in the function declaration. */
  description?: string;
  /**
   * Reasoning effort requested on the advisor model (`'minimal'`, `'low'`,
   * `'medium'`, `'high'`, a `ThinkingLevel` enum, or `null` to leave unset).
   * Defaults to `'high'`.
   */
  thinkingLevel?: ThinkingLevelName | string | ThinkingLevel | null;
  /** Snake_case alias for {@link thinkingLevel}. */
  thinking_level?: ThinkingLevelName | string | ThinkingLevel | null;
  /**
   * Maximum number of advisor consultations allowed per user turn (invocation).
   * Calls beyond this cap return a structured `limit_reached` response without
   * invoking the advisor model. Set to `null` for unlimited per-turn calls.
   * Defaults to `3`.
   */
  maxUses?: number | null;
  /** Snake_case alias for {@link maxUses}. */
  max_uses?: number | null;
  /**
   * Optional cap on total advisor consultations across the entire session.
   * Defaults to `undefined` (unlimited).
   */
  sessionMaxUses?: number | null;
  /** Snake_case alias for {@link sessionMaxUses}. */
  session_max_uses?: number | null;
  /** Optional cap on output tokens generated by the advisor per consultation. */
  maxOutputTokens?: number | null;
  /** Snake_case alias for {@link maxOutputTokens}. */
  max_output_tokens?: number | null;
  /** Optional per-call timeout in seconds for the advisor model request. */
  timeoutSeconds?: number | null;
  /** Snake_case alias for {@link timeoutSeconds}. */
  timeout_seconds?: number | null;
  /** System instruction given to the advisor model. */
  advisorInstruction?: string;
  /** Snake_case alias for {@link advisorInstruction}. */
  advisor_instruction?: string;
  /**
   * Guidance appended to the executor agent's system instruction explaining
   * when and how to call `model_consult`. Pass `''` to disable automatic
   * instruction injection.
   */
  executorInstruction?: string | null;
  /** Snake_case alias for {@link executorInstruction}. */
  executor_instruction?: string | null;
  /**
   * Whether to forward the executor agent's own instruction to the advisor so
   * the advisor respects domain constraints and policies. Defaults to `true`.
   */
  includeAgentInstruction?: boolean;
  /** Snake_case alias for {@link includeAgentInstruction}. */
  include_agent_instruction?: boolean;
  /**
   * Whether to include a summary of the executor agent's available tools in the
   * advisor's prompt so it can recommend concrete next actions by tool name.
   * Defaults to `true`.
   */
  includeToolInventory?: boolean;
  /** Snake_case alias for {@link includeToolInventory}. */
  include_tool_inventory?: boolean;
  /**
   * Controls how the executor's session events are converted and budgeted for
   * the advisor.
   */
  contextConfig?: ModelConsultContextConfig | ModelConsultContextConfigOptions;
  /** Snake_case alias for {@link contextConfig}. */
  context_config?: ModelConsultContextConfig | ModelConsultContextConfigOptions;
  /**
   * Optional base `GenerateContentConfig` for the advisor call (for example,
   * custom `temperature` or `safetySettings`).
   */
  generateContentConfig?: GenerateContentConfig;
  /** Snake_case alias for {@link generateContentConfig}. */
  generate_content_config?: GenerateContentConfig;
}

/**
 * Tool that lets an executor agent consult a stronger advisor model.
 */
export class ModelConsultTool extends BaseTool {
  private _llm?: BaseLlm;
  private readonly _modelName?: string;
  private readonly _thinkingLevel?: ThinkingLevelName | string | ThinkingLevel;
  private readonly _maxUses?: number;
  private readonly _sessionMaxUses?: number;
  private readonly _maxOutputTokens?: number;
  private readonly _timeoutSeconds?: number;
  private readonly _advisorInstruction: string;
  private readonly _executorSystemInstruction: string;
  private readonly _includeAgentInstruction: boolean;
  private readonly _includeToolInventory: boolean;
  private readonly _contextConfig: ModelConsultContextConfig;
  private readonly _generateContentConfig?: GenerateContentConfig;
  private readonly _sessionStates = new WeakMap<object, SessionConsultState>();
  private readonly _fallbackSessionState = new SessionConsultState();

  constructor(options: ModelConsultToolOptions = {}) {
    const name = options.name ?? DEFAULT_TOOL_NAME;
    const description = options.description ?? TOOL_DESCRIPTION;
    super({name, description});

    const rawMaxUses =
      options.maxUses !== undefined
        ? options.maxUses
        : options.max_uses !== undefined
          ? options.max_uses
          : 3;
    if (rawMaxUses !== undefined && rawMaxUses !== null && rawMaxUses < 1) {
      throw new Error(`max_uses must be >= 1 or None, got ${rawMaxUses}.`);
    }

    const rawSessionMaxUses =
      options.sessionMaxUses !== undefined
        ? options.sessionMaxUses
        : options.session_max_uses;
    if (
      rawSessionMaxUses !== undefined &&
      rawSessionMaxUses !== null &&
      rawSessionMaxUses < 1
    ) {
      throw new Error(
        `session_max_uses must be >= 1 or None, got ${rawSessionMaxUses}.`,
      );
    }

    const rawMaxOutputTokens =
      options.maxOutputTokens !== undefined
        ? options.maxOutputTokens
        : options.max_output_tokens;
    if (
      rawMaxOutputTokens !== undefined &&
      rawMaxOutputTokens !== null &&
      rawMaxOutputTokens < 1
    ) {
      throw new Error(
        `max_output_tokens must be >= 1 or None, got ${rawMaxOutputTokens}.`,
      );
    }

    const generateContentConfig =
      options.generateContentConfig ?? options.generate_content_config;
    const rawCfg = generateContentConfig as
      | (GenerateContentConfig & {max_output_tokens?: number})
      | undefined;
    const cfgMaxOutputTokens =
      rawCfg?.maxOutputTokens !== undefined
        ? rawCfg.maxOutputTokens
        : rawCfg?.max_output_tokens;

    if (cfgMaxOutputTokens !== undefined && cfgMaxOutputTokens !== null) {
      if (cfgMaxOutputTokens < 1) {
        throw new Error(
          `generate_content_config.max_output_tokens must be >= 1, got ${cfgMaxOutputTokens}.`,
        );
      }
      if (
        rawMaxOutputTokens !== undefined &&
        rawMaxOutputTokens !== null &&
        rawMaxOutputTokens !== cfgMaxOutputTokens
      ) {
        throw new Error(
          `Conflicting max_output_tokens (${rawMaxOutputTokens}) and ` +
            `generate_content_config.max_output_tokens (${cfgMaxOutputTokens}). ` +
            'Specify only one or set them to the same value.',
        );
      }
    }

    const rawTimeoutSeconds =
      options.timeoutSeconds !== undefined
        ? options.timeoutSeconds
        : options.timeout_seconds;
    if (
      rawTimeoutSeconds !== undefined &&
      rawTimeoutSeconds !== null &&
      rawTimeoutSeconds <= 0
    ) {
      throw new Error(
        `timeout_seconds must be > 0 or None, got ${rawTimeoutSeconds}.`,
      );
    }

    const hasExplicitThinkingLevel =
      'thinkingLevel' in options || 'thinking_level' in options;
    const rawThinkingLevel = hasExplicitThinkingLevel
      ? options.thinkingLevel !== undefined
        ? options.thinkingLevel
        : options.thinking_level
      : 'high';

    // Validate thinking_level and model eagerly so typos fail at construction.
    resolveThinkingLevel(rawThinkingLevel);
    const rawModel = options.model ?? DEFAULT_ADVISOR_MODEL;
    if (isBaseLlm(rawModel)) {
      this._llm = rawModel;
    } else if (typeof rawModel === 'string' && rawModel.trim()) {
      this._modelName = rawModel.trim();
      LLMRegistry.resolve(this._modelName);
    } else {
      throw new Error(
        `Invalid advisor_model: expected a non-empty model string or BaseLlm instance, got ${JSON.stringify(rawModel)}.`,
      );
    }
    this._thinkingLevel = rawThinkingLevel ?? undefined;
    this._maxUses = rawMaxUses ?? undefined;
    this._sessionMaxUses = rawSessionMaxUses ?? undefined;
    this._maxOutputTokens =
      rawMaxOutputTokens !== undefined && rawMaxOutputTokens !== null
        ? rawMaxOutputTokens
        : (cfgMaxOutputTokens ?? undefined);
    this._timeoutSeconds = rawTimeoutSeconds ?? undefined;
    this._advisorInstruction =
      options.advisorInstruction ??
      options.advisor_instruction ??
      ADVISOR_SYSTEM_INSTRUCTION;

    const rawExecutorInstruction =
      options.executorInstruction !== undefined
        ? options.executorInstruction
        : options.executor_instruction;
    if (
      rawExecutorInstruction === undefined ||
      rawExecutorInstruction === null
    ) {
      this._executorSystemInstruction =
        name === DEFAULT_TOOL_NAME
          ? EXECUTOR_INSTRUCTION
          : EXECUTOR_INSTRUCTION.replaceAll(
              `\`${DEFAULT_TOOL_NAME}\``,
              `\`${name}\``,
            );
    } else {
      this._executorSystemInstruction = rawExecutorInstruction;
    }

    this._includeAgentInstruction =
      options.includeAgentInstruction ??
      options.include_agent_instruction ??
      true;
    this._includeToolInventory =
      options.includeToolInventory ?? options.include_tool_inventory ?? true;

    const rawContextConfig = options.contextConfig ?? options.context_config;
    this._contextConfig =
      rawContextConfig instanceof ModelConsultContextConfig
        ? rawContextConfig
        : new ModelConsultContextConfig(rawContextConfig);
    this._generateContentConfig = generateContentConfig;
  }

  /** The resolved `BaseLlm` used as the advisor. */
  get advisorModel(): BaseLlm {
    if (!this._llm) {
      this._llm = resolveAdvisorLlm(this._modelName ?? DEFAULT_ADVISOR_MODEL);
    }
    return this._llm;
  }

  /** Snake_case alias for {@link advisorModel}. */
  get advisor_model(): BaseLlm {
    return this.advisorModel;
  }

  /** Configured thinking level for the advisor call. */
  get thinkingLevel(): ThinkingLevelName | string | ThinkingLevel | undefined {
    return this._thinkingLevel;
  }

  /** Snake_case alias for {@link thinkingLevel}. */
  get thinking_level(): ThinkingLevelName | string | ThinkingLevel | undefined {
    return this._thinkingLevel;
  }

  /** Per-turn consultation cap (`undefined` means unlimited). */
  get maxUses(): number | undefined {
    return this._maxUses;
  }

  /** Snake_case alias for {@link maxUses}. */
  get max_uses(): number | undefined {
    return this._maxUses;
  }

  /** Whole-session consultation cap (`undefined` means unlimited). */
  get sessionMaxUses(): number | undefined {
    return this._sessionMaxUses;
  }

  /** Snake_case alias for {@link sessionMaxUses}. */
  get session_max_uses(): number | undefined {
    return this._sessionMaxUses;
  }

  /** Per-consultation output token cap (`undefined` means model default). */
  get maxOutputTokens(): number | undefined {
    return this._maxOutputTokens;
  }

  /** Snake_case alias for {@link maxOutputTokens}. */
  get max_output_tokens(): number | undefined {
    return this._maxOutputTokens;
  }

  /** Per-consultation timeout in seconds (`undefined` means no timeout). */
  get timeoutSeconds(): number | undefined {
    return this._timeoutSeconds;
  }

  /** Snake_case alias for {@link timeoutSeconds}. */
  get timeout_seconds(): number | undefined {
    return this._timeoutSeconds;
  }

  /** Session handover configuration for the advisor call. */
  get contextConfig(): ModelConsultContextConfig {
    return this._contextConfig;
  }

  /** Snake_case alias for {@link contextConfig}. */
  get context_config(): ModelConsultContextConfig {
    return this._contextConfig;
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          question: {
            type: Type.STRING,
            description:
              'The specific, decision-oriented question you want the advisor ' +
              'model to help you resolve. State what you are trying to ' +
              'achieve, what options or hypotheses you are weighing, and why ' +
              'the choice is non-trivial.',
          },
          context: {
            type: Type.STRING,
            description:
              'Optional brief notes on constraints, hypotheses, or recent ' +
              'findings not already obvious from the session transcript.',
          },
        },
        required: ['question'],
      },
    };
  }

  /** Snake_case alias for {@link _getDeclaration}. */
  _get_declaration(): FunctionDeclaration {
    return this._getDeclaration();
  }

  override async processLlmRequest({
    toolContext,
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    const alreadyRegisteredSelf =
      Object.hasOwn(llmRequest.toolsDict, this.name) &&
      llmRequest.toolsDict[this.name] === this;
    if (!alreadyRegisteredSelf) {
      await super.processLlmRequest({toolContext, llmRequest});
    }
    if (!this._executorSystemInstruction) {
      return;
    }
    const existing = llmRequest.config?.systemInstruction ?? '';
    if (
      typeof existing === 'string' &&
      existing.includes(this._executorSystemInstruction)
    ) {
      return;
    }
    appendInstructions(llmRequest, [this._executorSystemInstruction]);
  }

  /** Snake_case alias for {@link processLlmRequest}. */
  async process_llm_request(
    params:
      | ToolProcessLlmRequest
      | {
          tool_context: ToolContext;
          llm_request: ToolProcessLlmRequest['llmRequest'];
        },
  ): Promise<void> {
    const toolContext =
      'toolContext' in params ? params.toolContext : params.tool_context;
    const llmRequest =
      'llmRequest' in params ? params.llmRequest : params.llm_request;
    return this.processLlmRequest({toolContext, llmRequest});
  }

  _turnUsesStateKey(toolContext: ToolContext): string {
    const invId = toolContext.invocationId || 'unknown';
    return `${State.TEMP_PREFIX}model_consult:${this.name}:${invId}:uses`;
  }

  /** Snake_case alias for {@link _turnUsesStateKey}. */
  _turn_uses_state_key(toolContext: ToolContext): string {
    return this._turnUsesStateKey(toolContext);
  }

  _sessionUsesStateKey(): string {
    return `model_consult:${this.name}:session_uses`;
  }

  /** Snake_case alias for {@link _sessionUsesStateKey}. */
  _session_uses_state_key(): string {
    return this._sessionUsesStateKey();
  }

  private getSessionConsultState(
    toolContext: ToolContext,
  ): SessionConsultState {
    const session = toolContext.invocationContext?.session;
    if (!session || typeof session !== 'object') {
      return this._fallbackSessionState;
    }
    let state = this._sessionStates.get(session);
    if (!state) {
      state = new SessionConsultState();
      this._sessionStates.set(session, state);
    }
    return state;
  }

  private static safeIntState(toolContext: ToolContext, key: string): number {
    const stateObj = toolContext.state as unknown as
      | State
      | Record<string, unknown>
      | undefined;
    let raw: unknown;
    if (stateObj && typeof (stateObj as State).get === 'function') {
      raw = (stateObj as State).get(key, 0);
    } else if (stateObj && typeof stateObj === 'object') {
      raw = (stateObj as Record<string, unknown>)[key] ?? 0;
    } else {
      raw = 0;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.max(Math.trunc(parsed), 0);
  }

  private getTurnUses(toolContext: ToolContext): number {
    return ModelConsultTool.safeIntState(
      toolContext,
      this._turnUsesStateKey(toolContext),
    );
  }

  private getSessionUses(toolContext: ToolContext): number {
    const sessionKey = this._sessionUsesStateKey();
    const stateUses = ModelConsultTool.safeIntState(toolContext, sessionKey);
    const rawSessionState = toolContext.invocationContext?.session?.state;
    let rawUses = 0;
    if (rawSessionState && typeof rawSessionState === 'object') {
      const n = Number(rawSessionState[sessionKey] ?? 0);
      if (Number.isFinite(n)) {
        rawUses = Math.max(Math.trunc(n), 0);
      }
    }
    return Math.max(stateUses, rawUses);
  }

  private computeRemaining(
    turnUses: number,
    sessionUses: number,
  ): number | null {
    const candidates: number[] = [];
    if (this._maxUses !== undefined) {
      candidates.push(Math.max(this._maxUses - turnUses, 0));
    }
    if (this._sessionMaxUses !== undefined) {
      candidates.push(Math.max(this._sessionMaxUses - sessionUses, 0));
    }
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  private budgetSummary(
    turnUses: number,
    sessionUses: number,
  ): Record<string, number | null> {
    return {
      used_this_turn: turnUses,
      max_uses: this._maxUses ?? null,
      used_this_session: sessionUses,
      session_max_uses: this._sessionMaxUses ?? null,
      remaining: this.computeRemaining(turnUses, sessionUses),
    };
  }

  /**
   * Returns `true` if another consultation is permitted in this turn/session.
   */
  hasRemainingBudget(toolContext: ToolContext): boolean {
    const turnUses = this.getTurnUses(toolContext);
    const sessionUses = this.getSessionUses(toolContext);
    const remaining = this.computeRemaining(turnUses, sessionUses);
    return remaining === null || remaining > 0;
  }

  /** Snake_case alias for {@link hasRemainingBudget}. */
  has_remaining_budget(toolContext: ToolContext): boolean {
    return this.hasRemainingBudget(toolContext);
  }

  private async resolveAgentInstruction(
    invocationContext: InvocationContext,
  ): Promise<string> {
    if (!this._includeAgentInstruction) {
      return '';
    }
    const agent = invocationContext.agent as unknown as
      | Record<string, unknown>
      | undefined;
    if (!agent || typeof agent !== 'object') {
      return '';
    }
    const readonlyCtx = new ReadonlyContext(invocationContext);
    const segments: string[] = [];

    const staticInstruction =
      agent.staticInstruction ?? agent.static_instruction;
    if (staticInstruction !== undefined && staticInstruction !== null) {
      const staticText = extractStaticInstructionText(staticInstruction);
      if (staticText) {
        segments.push(staticText);
      }
    }

    const canonicalInstFn =
      typeof agent.canonicalInstruction === 'function'
        ? (agent.canonicalInstruction as (
            ctx: ReadonlyContext,
          ) => Promise<unknown>)
        : typeof agent.canonical_instruction === 'function'
          ? (agent.canonical_instruction as (
              ctx: ReadonlyContext,
            ) => Promise<unknown>)
          : undefined;

    if (canonicalInstFn) {
      try {
        const result = await canonicalInstFn.call(agent, readonlyCtx);
        let rawInst = '';
        let bypassStateInjection = false;
        if (typeof result === 'string') {
          rawInst = result;
        } else if (Array.isArray(result)) {
          rawInst = typeof result[0] === 'string' ? result[0] : '';
          bypassStateInjection = Boolean(result[1]);
        } else if (result && typeof result === 'object') {
          const obj = result as {
            instruction?: string;
            requireStateInjection?: boolean;
          };
          rawInst = typeof obj.instruction === 'string' ? obj.instruction : '';
          bypassStateInjection = obj.requireStateInjection === false;
        }

        if (rawInst && !bypassStateInjection) {
          try {
            rawInst = await injectSessionState(rawInst, readonlyCtx);
          } catch {
            // Fall back to substituting any populated state keys while leaving
            // unset `{placeholder}` tokens intact.
            const stateRecord = readonlyCtx.state.toRecord();
            for (const [k, v] of Object.entries(stateRecord)) {
              if (typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
                rawInst = rawInst.replaceAll(`{${k}}`, String(v));
              }
            }
          }
        }
        if (rawInst && rawInst.trim()) {
          segments.push(rawInst.trim());
        }
      } catch {
        // Ignore broken instruction callbacks.
      }
    }

    const cleanedSegments: string[] = [];
    for (const seg of segments) {
      let text = seg;
      for (const injected of [
        this._executorSystemInstruction,
        EXECUTOR_INSTRUCTION,
      ]) {
        if (injected && text.includes(injected)) {
          text = text.replaceAll(injected, '').trim();
        }
      }
      if (text) {
        cleanedSegments.push(text);
      }
    }
    return cleanedSegments.join('\n\n');
  }

  private async formatToolOverview(
    invocationContext: InvocationContext,
  ): Promise<string> {
    if (!this._includeToolInventory) {
      return '';
    }
    const agent = invocationContext.agent as unknown as
      | Record<string, unknown>
      | undefined;
    if (!agent || typeof agent !== 'object') {
      return '';
    }

    const rawInvCtx = invocationContext as InvocationContext & {
      canonical_tools_cache?: BaseTool[];
    };
    let tools =
      invocationContext.canonicalToolsCache ?? rawInvCtx.canonical_tools_cache;

    if (tools === undefined || tools === null) {
      const canonicalToolsFn =
        typeof agent.canonicalTools === 'function'
          ? (agent.canonicalTools as (
              ctx: ReadonlyContext,
            ) => Promise<BaseTool[]>)
          : typeof agent.canonical_tools === 'function'
            ? (agent.canonical_tools as (
                ctx: ReadonlyContext,
              ) => Promise<BaseTool[]>)
            : undefined;
      if (!canonicalToolsFn) {
        return '';
      }
      try {
        tools = await canonicalToolsFn.call(
          agent,
          new ReadonlyContext(invocationContext),
        );
      } catch {
        return '';
      }
      invocationContext.canonicalToolsCache = tools;
      rawInvCtx.canonical_tools_cache = tools;
    }

    const lines: string[] = [];
    for (const tool of tools) {
      const tName = tool?.name ?? '';
      if (!tName || tName === this.name || tName === DEFAULT_TOOL_NAME) {
        continue;
      }
      let desc = (tool?.description ?? '').trim().split(/\s+/).join(' ');
      if (desc.length > 300) {
        desc = `${desc.slice(0, 300)}...`;
      }
      if (desc) {
        lines.push(`- ${tName}: ${desc}`);
      } else {
        lines.push(`- ${tName}`);
      }
    }

    if (lines.length === 0) {
      return '';
    }
    return (
      '--- TOOLS AVAILABLE TO THE EXECUTOR ---\n' +
      'The executor agent can call the following tools (you cannot call them ' +
      'yourself, but you can recommend them by name):\n' +
      lines.join('\n') +
      '\n--- END TOOLS AVAILABLE TO THE EXECUTOR ---'
    );
  }

  /**
   * Collects IDs of `model_consult` function calls that do not yet have a
   * matching `functionResponse` in `events` (plus the current call's ID).
   */
  private collectUnansweredConsultCallIds(
    events: readonly Event[],
    currentCallId?: string,
  ): Set<string> {
    const activeEvents = applyRewinds(events);
    const consultCallIds = new Set<string>();
    const answeredIds = new Set<string>();

    for (const event of activeEvents) {
      if (!event.content || !event.content.parts) {
        continue;
      }
      for (const part of event.content.parts) {
        const fc =
          part.functionCall ??
          (part as {function_call?: Part['functionCall']}).function_call;
        if (
          fc &&
          fc.id &&
          (fc.name === this.name || fc.name === DEFAULT_TOOL_NAME)
        ) {
          consultCallIds.add(fc.id);
        }
        const fr =
          part.functionResponse ??
          (part as {function_response?: Part['functionResponse']})
            .function_response;
        if (fr && fr.id) {
          answeredIds.add(fr.id);
        }
      }
    }

    const pending = new Set<string>();
    for (const id of consultCallIds) {
      if (!answeredIds.has(id)) {
        pending.add(id);
      }
    }
    if (currentCallId) {
      pending.add(currentCallId);
    }
    return pending;
  }

  private buildHandoffMessage(options: {
    agentName: string;
    question: string;
    extraContext?: string;
  }): Content {
    const {agentName, question, extraContext} = options;
    const agentLabel =
      agentName && agentName !== 'unknown' ? ` (${agentName})` : '';
    const contextBlock =
      extraContext && extraContext.trim()
        ? formatTemplate(CONTEXT_BLOCK_TEMPLATE, {
            context: extraContext.trim(),
          })
        : '';
    const text = formatTemplate(ADVISOR_HANDOFF_TEMPLATE, {
      agent_label: agentLabel,
      tool_name: this.name,
      context_block: contextBlock,
      question: question.trim(),
    });
    return {role: 'user', parts: [{text}]};
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<Record<string, unknown>> {
    const rawQuestion = args?.question;
    const question =
      rawQuestion === undefined || rawQuestion === null
        ? ''
        : typeof rawQuestion === 'string'
          ? rawQuestion
          : String(rawQuestion);

    if (!question.trim()) {
      const turnUses = this.getTurnUses(toolContext);
      const sessionUses = this.getSessionUses(toolContext);
      return {
        status: 'invalid_request',
        message:
          `\`${this.name}\` requires a non-empty \`question\` describing the ` +
          'decision or problem you want the advisor to help resolve.',
        consults: this.budgetSummary(turnUses, sessionUses),
      };
    }

    const sessionState = this.getSessionConsultState(toolContext);
    const invKey = toolContext.invocationId || 'unknown';
    const turnUses = this.getTurnUses(toolContext);
    const sessionUses = this.getSessionUses(toolContext);
    const turnInFlight = sessionState.turnReserved.get(invKey) ?? 0;
    const turnEffective = turnUses + turnInFlight;
    const sessionEffective = sessionUses + sessionState.sessionReserved;

    if (this._maxUses !== undefined && turnEffective >= this._maxUses) {
      return {
        status: 'limit_reached',
        message:
          `Advisor consultation budget for this turn is exhausted ` +
          `(${turnEffective} of ${this._maxUses} used). Proceed using the ` +
          'guidance already received and your own best judgment.',
        consults: this.budgetSummary(turnEffective, sessionEffective),
      };
    }

    if (
      this._sessionMaxUses !== undefined &&
      sessionEffective >= this._sessionMaxUses
    ) {
      return {
        status: 'limit_reached',
        message:
          `Advisor consultation budget for this session is exhausted ` +
          `(${sessionEffective} of ${this._sessionMaxUses} used). Proceed ` +
          'using the guidance already received and your own best judgment.',
        consults: this.budgetSummary(turnEffective, sessionEffective),
      };
    }

    // Reserve budget slot before awaiting the advisor LLM so concurrent
    // `model_consult` calls in the same turn/session cannot bypass caps.
    sessionState.turnReserved.set(invKey, turnInFlight + 1);
    sessionState.sessionReserved += 1;
    sessionState.activeCalls.set(
      invKey,
      (sessionState.activeCalls.get(invKey) ?? 0) + 1,
    );

    const stateDelta = toolContext.actions?.stateDelta;
    if (stateDelta && typeof stateDelta === 'object') {
      let deltas = sessionState.invDeltas.get(invKey);
      if (!deltas) {
        deltas = [];
        sessionState.invDeltas.set(invKey, deltas);
      }
      if (!deltas.includes(stateDelta)) {
        deltas.push(stateDelta);
      }
    }

    const mySeq = sessionState.nextCommitSeq;
    sessionState.nextCommitSeq += 1;

    try {
      const rawExtra = args?.context;
      const extraContext =
        rawExtra === undefined || rawExtra === null
          ? undefined
          : typeof rawExtra === 'string'
            ? rawExtra
            : String(rawExtra);

      const invocationContext = toolContext.invocationContext;
      const events = invocationContext?.session?.events ?? [];
      const currentCallId =
        toolContext.functionCallId ??
        (toolContext as unknown as {function_call_id?: string})
          .function_call_id;
      const skipIds = this.collectUnansweredConsultCallIds(
        events,
        currentCallId,
      );

      const sessionContents = buildAdvisorContents(events, {
        config: this._contextConfig,
        skipFunctionCallIds: skipIds,
      });

      let rawAgentName: unknown;
      try {
        rawAgentName = toolContext.agentName;
      } catch {
        rawAgentName = invocationContext?.agent?.name;
      }
      const agentName =
        typeof rawAgentName === 'string' && rawAgentName.trim()
          ? rawAgentName.trim()
          : '';

      const preambleParts: Part[] = [];
      const executorInst =
        await this.resolveAgentInstruction(invocationContext);
      if (executorInst) {
        const headerLabel =
          agentName && agentName !== 'unknown'
            ? ` (${agentName})`
            : ' (the executor)';
        preambleParts.push({
          text:
            `--- EXECUTOR AGENT INSTRUCTION${headerLabel} ---\n` +
            'The executor agent is operating under the following instruction ' +
            '(tailor your guidance so it stays compliant with these rules):\n' +
            `${executorInst}\n` +
            '--- END EXECUTOR AGENT INSTRUCTION ---',
        });
      }

      const toolOverview = await this.formatToolOverview(invocationContext);
      if (toolOverview) {
        preambleParts.push({text: toolOverview});
      }

      const handoff = this.buildHandoffMessage({
        agentName,
        question,
        extraContext,
      });

      const mergedParts: Part[] = [...preambleParts];
      for (const content of sessionContents) {
        if (content.parts) {
          mergedParts.push(...content.parts);
        }
      }
      if (handoff.parts) {
        mergedParts.push(...handoff.parts);
      }
      const contents: Content[] = [{role: 'user', parts: mergedParts}];

      let result;
      try {
        result = await callAdvisor(this.advisorModel, contents, {
          systemInstruction: this._advisorInstruction,
          thinkingLevel: this._thinkingLevel ?? null,
          maxOutputTokens: this._maxOutputTokens,
          generateContentConfig: this._generateContentConfig,
          timeoutSeconds: this._timeoutSeconds,
        });
      } catch (exc) {
        await sessionState.waitFor(() => sessionState.commitEpoch === mySeq);
        sessionState.turnReserved.set(
          invKey,
          Math.max((sessionState.turnReserved.get(invKey) ?? 1) - 1, 0),
        );
        sessionState.sessionReserved = Math.max(
          sessionState.sessionReserved - 1,
          0,
        );
        sessionState.commitEpoch += 1;
        sessionState.notifyAll();

        const curTurn = this.getTurnUses(toolContext);
        const curSession = this.getSessionUses(toolContext);
        const errMsg = exc instanceof Error ? exc.message : String(exc);
        logger.warn(`ModelConsultTool advisor call failed: ${errMsg}`);
        return {
          status: 'error',
          error: errMsg,
          message:
            'The advisor model could not be reached or returned an invalid ' +
            'response. Continue the task using your own best judgment.',
          consults: this.budgetSummary(curTurn, curSession),
        };
      }

      await sessionState.waitFor(() => sessionState.commitEpoch === mySeq);
      sessionState.turnReserved.set(
        invKey,
        Math.max((sessionState.turnReserved.get(invKey) ?? 1) - 1, 0),
      );
      sessionState.sessionReserved = Math.max(
        sessionState.sessionReserved - 1,
        0,
      );
      const newTurnUses = this.getTurnUses(toolContext) + 1;
      const newSessionUses = this.getSessionUses(toolContext) + 1;
      const turnKey = this._turnUsesStateKey(toolContext);
      const sessionKey = this._sessionUsesStateKey();

      // Persist both counters in `toolContext.state` so `stateDelta` carries
      // them onto the emitted function_response event.
      try {
        const stateObj = toolContext.state as unknown as
          | State
          | Record<string, unknown>
          | undefined;
        if (stateObj && typeof (stateObj as State).set === 'function') {
          (stateObj as State).set(turnKey, newTurnUses);
          (stateObj as State).set(sessionKey, newSessionUses);
        } else if (stateObj && typeof stateObj === 'object') {
          (stateObj as Record<string, unknown>)[turnKey] = newTurnUses;
          (stateObj as Record<string, unknown>)[sessionKey] = newSessionUses;
        }
      } catch (exc) {
        logger.warn(
          `ModelConsultTool could not persist its use counters into toolContext.state (${String(exc)}); falling back to session.state and actions.stateDelta.`,
        );
      }

      const rawSessionState = invocationContext?.session?.state;
      if (rawSessionState && typeof rawSessionState === 'object') {
        rawSessionState[turnKey] = newTurnUses;
        rawSessionState[sessionKey] = newSessionUses;
      }

      // Update all active parallel `stateDelta` maps in this invocation so
      // `mergeEventActions` preserves the highest counter regardless of
      // function call ordering.
      for (const delta of sessionState.invDeltas.get(invKey) ?? []) {
        delta[turnKey] = newTurnUses;
        delta[sessionKey] = newSessionUses;
        if (rawSessionState && typeof rawSessionState === 'object') {
          recordStateWrite(rawSessionState, delta, turnKey);
          recordStateWrite(rawSessionState, delta, sessionKey);
        }
      }

      sessionState.commitEpoch += 1;
      sessionState.notifyAll();

      return {
        status: 'ok',
        guidance: result.guidance,
        advisor_model: result.modelVersion,
        thinking_level: result.thinkingLevel ?? null,
        consults: this.budgetSummary(newTurnUses, newSessionUses),
        usage: result.usage.toDict(),
        latency_ms: result.latencyMs,
      };
    } finally {
      const remainingActive = Math.max(
        (sessionState.activeCalls.get(invKey) ?? 1) - 1,
        0,
      );
      if (remainingActive === 0) {
        sessionState.activeCalls.delete(invKey);
        sessionState.invDeltas.delete(invKey);
        if ((sessionState.turnReserved.get(invKey) ?? 0) === 0) {
          sessionState.turnReserved.delete(invKey);
        }
      } else {
        sessionState.activeCalls.set(invKey, remainingActive);
      }
    }
  }

  /** Snake_case alias for {@link runAsync}. */
  async run_async(
    request:
      | RunAsyncToolRequest
      | {args: Record<string, unknown>; tool_context: ToolContext},
  ): Promise<Record<string, unknown>> {
    const toolContext =
      'toolContext' in request ? request.toolContext : request.tool_context;
    return this.runAsync({args: request.args, toolContext});
  }
}
