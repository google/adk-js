/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, FunctionDeclaration, Part} from '@google/genai';

import {BaseLlm} from './base_llm.js';
import type {BaseLlmConnection} from './base_llm_connection.js';
import type {LlmRequest} from './llm_request.js';
import type {LlmResponse} from './llm_response.js';

/**
 * An ADK `BaseLlm` backed by Chrome's built-in on-device model, reached through
 * the Prompt API (`globalThis.LanguageModel`).
 *
 * ## What this adapter is for
 *
 * ADK's agent loop is built around a model that emits *function calls*: the
 * Runner inspects them, applies before/after-tool callbacks, executes the tool,
 * appends a function response and loops. Chrome's Prompt API offers `prompt()`
 * and `promptStreaming()`, which return a plain string.
 *
 * Chrome does expose a `tools` option on `LanguageModel.create()`, but its
 * contract differs in a way that matters here: each tool carries an `execute()`
 * callback and *the browser runs the tool itself*, feeding the result back into
 * the model internally. The caller receives only the final text. That takes ADK
 * out of its own loop — no tool callbacks, no per-call events, no confirmation
 * hooks, no session state updates and nothing to trace.
 *
 * So this adapter synthesises function calling out of constrained decoding
 * instead. Tools are described in the system prompt, and the reply is forced to
 * match a JSON Schema whose branches are "final answer" or "call this exact
 * tool with these exact arguments" (via `responseConstraint`). The reply is
 * parsed back into genai `functionCall` parts, and ADK stays in control.
 *
 * ## Session strategy
 *
 * ADK is stateless per request: it re-sends the whole conversation every time.
 * Chrome sessions are stateful, and `create()` is far more expensive than
 * `prompt()`. This adapter therefore keeps one warm "base" session holding only
 * the system prompt and `clone()`s it per request, destroying the clone after
 * the turn. The conversation history rides in the prompt input.
 *
 * ## Availability
 *
 * The Prompt API is exposed to documents, not to workers, and it is desktop
 * only with a substantial hardware floor. Call {@link availability} before
 * relying on it. `create()` also requires a user gesture while the model is
 * still downloading, so build the session in response to a user action.
 *
 * @example
 * ```ts
 * const llm = new ChromePromptApiLlm();
 * if ((await llm.availability()) === 'unavailable') {
 *   // Fall back to a hosted model.
 * }
 * const agent = new LlmAgent({name: 'search', model: llm, tools: [...]});
 * ```
 */

/* ------------------------------------------------------------------ *
 * Prompt API surface
 *
 * Declared structurally rather than pulled in from `@types/dom-chromium-ai`,
 * so that a browser-only model does not force an ambient global type package
 * on every consumer of this package. A real `globalThis.LanguageModel`
 * satisfies these by structural typing.
 * ------------------------------------------------------------------ */

/** Whether the on-device model can serve a request right now. */
export type ChromeModelAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

/** A modality declared at session creation. */
export interface ChromeExpectedModality {
  type: 'text' | 'image' | 'audio';
  languages?: string[];
}

/** One piece of a multimodal message. */
export interface ChromeMessageContent {
  type: 'text' | 'image' | 'audio';
  value: string;
}

/** A single turn handed to `prompt()`. */
export interface ChromeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChromeMessageContent[];
}

/** Emits `downloadprogress` while the model is fetched on first use. */
export interface ChromeCreateMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: {loaded: number}) => void,
  ): void;
}

/** Options accepted by `LanguageModel.availability()`. */
export interface ChromeCreateCoreOptions {
  expectedInputs?: ChromeExpectedModality[];
  expectedOutputs?: ChromeExpectedModality[];
}

/** Options accepted by `LanguageModel.create()`. */
export interface ChromeCreateOptions extends ChromeCreateCoreOptions {
  signal?: AbortSignal;
  initialPrompts?: ChromeMessage[];
  monitor?: (monitor: ChromeCreateMonitor) => void;
  temperature?: number;
  topK?: number;
}

/** Options accepted by `prompt()` and `promptStreaming()`. */
export interface ChromePromptOptions {
  signal?: AbortSignal;
  responseConstraint?: Record<string, unknown>;
  omitResponseConstraintInput?: boolean;
}

/** A live Prompt API session. */
export interface ChromeLanguageModelSession {
  prompt(
    input: string | ChromeMessage[],
    options?: ChromePromptOptions,
  ): Promise<string>;
  promptStreaming(
    input: string | ChromeMessage[],
    options?: ChromePromptOptions,
  ): ReadableStream<string>;
  clone(options?: {signal?: AbortSignal}): Promise<ChromeLanguageModelSession>;
  destroy?(): void;
  addEventListener?(type: 'contextoverflow', listener: () => void): void;
  readonly contextUsage?: number;
  readonly contextWindow?: number;
}

/** The `LanguageModel` global itself. */
export interface ChromeLanguageModelFactory {
  availability(
    options?: ChromeCreateCoreOptions,
  ): Promise<ChromeModelAvailability>;
  create(options?: ChromeCreateOptions): Promise<ChromeLanguageModelSession>;
}

/* ------------------------------------------------------------------ *
 * Options and diagnostics
 * ------------------------------------------------------------------ */

/** Timing and context signals emitted while the adapter runs. */
export interface ChromePromptApiDiagnostic {
  phase: 'create' | 'prompt' | 'parse-fallback' | 'context-overflow';
  ms?: number;
  contextUsage?: number;
  contextWindow?: number;
  note?: string;
}

/** Constructor options for {@link ChromePromptApiLlm}. */
export interface ChromePromptApiLlmParams {
  /** Model id used for registry matching. Defaults to `chrome-on-device`. */
  model?: string;
  /**
   * Injects an alternative implementation of the `LanguageModel` global, for
   * tests and for embedding a stand-in. Defaults to
   * `globalThis.LanguageModel`.
   */
  languageModel?: ChromeLanguageModelFactory;
  /**
   * Sampling temperature. Accepted only in extension contexts; on a plain web
   * page `create()` rejects it and the adapter retries without it.
   */
  temperature?: number;
  /** Sampling top-K. Subject to the same restriction as `temperature`. */
  topK?: number;
  /** Modalities to declare at session creation. */
  expectedInputs?: ChromeExpectedModality[];
  expectedOutputs?: ChromeExpectedModality[];
  /** Receives bytes-loaded progress while the model downloads on first use. */
  onDownloadProgress?: (loaded: number) => void;
  /**
   * Rewrites the system prompt before a session is created.
   *
   * This exists because of a specific and costly interaction with ADK. Every
   * request is prefixed by ADK's identity processor with:
   *
   *     You are an agent. Your internal name is "<agent name>".
   *
   * Under a `ParallelAgent` fan-out each child has a different name, so every
   * child produces a *different* system prompt, so the warm base session never
   * hits and each child pays a full `create()` — the most expensive call
   * available — precisely when the most calls are in flight.
   *
   * Pass {@link stripAdkIdentityPreamble} to drop it. That is safe whenever
   * agent transfer is disabled, because the identity line exists to support
   * transfer. Leave it unset for multi-agent setups that route by name.
   */
  normalizeSystemPrompt?: (systemPrompt: string) => string;
  /** Receives timing and context diagnostics. */
  onDiagnostic?: (diagnostic: ChromePromptApiDiagnostic) => void;
}

/** Thrown when the browser has no usable on-device model. */
export class ChromeModelUnavailableError extends Error {
  constructor(readonly availability: ChromeModelAvailability | 'missing-api') {
    super(
      availability === 'missing-api'
        ? 'This browser does not expose the Prompt API ' +
            '(globalThis.LanguageModel is undefined).'
        : `Chrome's built-in model is not available ` +
            `(availability: "${availability}").`,
    );
    this.name = 'ChromeModelUnavailableError';
  }
}

/* ------------------------------------------------------------------ *
 * Schema conversion
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Converts a genai `Schema` to standard JSON Schema.
 *
 * genai uses OpenAPI-style uppercase type names (`OBJECT`, `STRING`) while
 * `responseConstraint` expects lowercase JSON Schema types. genai-only keys are
 * dropped, because a JSON Schema validator rejects them.
 */
export function genaiSchemaToJsonSchema(
  schema: unknown,
): Record<string, unknown> {
  if (!isRecord(schema)) return {type: 'object', properties: {}};
  const out: Record<string, unknown> = {};

  if (typeof schema['type'] === 'string') {
    out['type'] = schema['type'].toLowerCase();
  }
  if (schema['description']) out['description'] = schema['description'];
  if (schema['enum']) out['enum'] = schema['enum'];
  if (schema['format']) out['format'] = schema['format'];
  if (Array.isArray(schema['required']) && schema['required'].length) {
    out['required'] = schema['required'];
  }

  if (isRecord(schema['properties'])) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema['properties'])) {
      properties[key] = genaiSchemaToJsonSchema(value);
    }
    out['properties'] = properties;
  }
  if (schema['items']) {
    out['items'] = genaiSchemaToJsonSchema(schema['items']);
  }
  if (out['type'] === 'object' && !out['properties']) out['properties'] = {};
  return out;
}

/** Returns the argument schema for a declaration, in JSON Schema form. */
function argumentSchema(
  declaration: FunctionDeclaration,
): Record<string, unknown> {
  return declaration.parametersJsonSchema
    ? (declaration.parametersJsonSchema as Record<string, unknown>)
    : genaiSchemaToJsonSchema(declaration.parameters);
}

/** Pulls function declarations out of a request's tool config. */
function collectFunctionDeclarations(
  llmRequest: LlmRequest,
): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  for (const tool of llmRequest.config?.tools ?? []) {
    if (isRecord(tool) && Array.isArray(tool['functionDeclarations'])) {
      declarations.push(
        ...(tool['functionDeclarations'] as FunctionDeclaration[]),
      );
    }
  }
  return declarations;
}

/**
 * Builds the constrained-decoding schema: a union of "final answer" and one
 * branch per available tool, each carrying that tool's exact argument schema.
 *
 * A single-value `enum` is used rather than `const`, because it is semantically
 * identical and more widely supported across constraint engines.
 */
export function buildToolChoiceSchema(
  declarations: FunctionDeclaration[],
): Record<string, unknown> {
  const branches: Array<Record<string, unknown>> = [
    {
      type: 'object',
      properties: {
        kind: {type: 'string', enum: ['final']},
        text: {type: 'string'},
      },
      required: ['kind', 'text'],
    },
  ];

  for (const declaration of declarations) {
    if (!declaration.name) continue;
    branches.push({
      type: 'object',
      properties: {
        kind: {type: 'string', enum: ['tool']},
        name: {type: 'string', enum: [declaration.name]},
        args: argumentSchema(declaration),
      },
      required: ['kind', 'name', 'args'],
    });
  }

  return branches.length === 1 ? branches[0]! : {anyOf: branches};
}

/** Renders tool declarations into instructions the model can act on. */
export function renderToolInstructions(
  declarations: FunctionDeclaration[],
): string {
  if (!declarations.length) return '';
  const lines = declarations.map(
    (declaration) =>
      `- ${declaration.name}: ${declaration.description ?? ''}\n` +
      `  arguments: ${JSON.stringify(argumentSchema(declaration))}`,
  );
  return [
    'You can call these tools:',
    ...lines,
    '',
    'Reply with JSON only. To call a tool use ' +
      '{"kind":"tool","name":<tool>,"args":{...}}.',
    'When you have the answer use {"kind":"final","text":<answer>}.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Content mapping
 * ------------------------------------------------------------------ */

/**
 * Renders a tool result as text the model can actually read.
 *
 * ADK wraps a tool's string return value as `{result: "<the string>"}`. Naively
 * JSON-stringifying that produces double-encoded output, in which every quote
 * is escaped twice:
 *
 *     [tool_result] search -> {"result":"{\"matches\":[{\"id\":8, ...
 *
 * A large model shrugs at this. A small one has to spend attention unpicking
 * the encoding before it can read the payload, and often just fails. Unwrapping
 * the single `result` key and re-emitting plain JSON costs nothing and gives
 * the model something legible:
 *
 *     [tool_result] search -> {"matches":[{"id":8, ...
 */
export function renderToolResult(response: unknown): string {
  if (response == null) return '{}';
  let value: unknown = response;

  // Unwrap ADK's {result: ...} envelope.
  if (isRecord(value) && Object.keys(value).length === 1 && 'result' in value) {
    value = value['result'];
  }

  // If it is already a JSON string, splice it in rather than escaping again.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Maps genai `Content[]` onto Prompt API messages.
 *
 * Function calls and responses have no native representation in a Prompt API
 * message, so they are serialised to text. Without this the model loses the
 * thread of a multi-step tool interaction.
 */
export function contentsToMessages(contents: Content[]): ChromeMessage[] {
  const messages: ChromeMessage[] = [];

  for (const content of contents ?? []) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const chunks: string[] = [];
    const rich: ChromeMessageContent[] = [];

    for (const part of (content.parts ?? []) as Part[]) {
      if (part.text) chunks.push(part.text);
      if (part.functionCall) {
        const args = JSON.stringify(part.functionCall.args ?? {});
        chunks.push(`[tool_call] ${part.functionCall.name}(${args})`);
      }
      if (part.functionResponse) {
        const rendered = renderToolResult(part.functionResponse.response);
        chunks.push(
          `[tool_result] ${part.functionResponse.name} -> ${rendered}`,
        );
      }
      if (
        typeof part.inlineData?.data === 'string' &&
        part.inlineData.mimeType?.startsWith('image/')
      ) {
        rich.push({type: 'image', value: part.inlineData.data});
      }
    }

    if (rich.length) {
      if (chunks.length) {
        rich.unshift({type: 'text', value: chunks.join('\n')});
      }
      messages.push({role, content: rich});
    } else if (chunks.length) {
      messages.push({role, content: chunks.join('\n')});
    }
  }

  return messages;
}

/** Extracts the system instruction from a request as plain text. */
export function extractSystemInstruction(llmRequest: LlmRequest): string {
  const instruction: unknown = llmRequest.config?.systemInstruction;
  if (!instruction) return '';
  if (typeof instruction === 'string') return instruction;
  if (Array.isArray(instruction)) {
    return instruction
      .map((entry) =>
        typeof entry === 'string' ? entry : ((entry as Part)?.text ?? ''),
      )
      .filter(Boolean)
      .join('\n');
  }
  if (isRecord(instruction) && Array.isArray(instruction['parts'])) {
    return (instruction['parts'] as Part[])
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return String(instruction);
}

/**
 * Removes ADK's per-agent identity preamble from a system prompt.
 *
 * Turns:
 *
 *     You are an agent. Your internal name is "rerank_11".
 *     The description about you is "..."
 *
 *     <the actual instruction>
 *
 * into just the instruction, so that sibling agents sharing one instruction
 * also share one cached session. See
 * {@link ChromePromptApiLlmParams.normalizeSystemPrompt}.
 */
export function stripAdkIdentityPreamble(systemPrompt: string): string {
  return systemPrompt
    .replace(/^You are an agent\. Your internal name is "[^"]*"\.\s*/m, '')
    .replace(/^The description about you is "[^"]*"\s*/m, '')
    .trimStart();
}

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

/** See the file overview for the design rationale. */
export class ChromePromptApiLlm extends BaseLlm {
  // Left unanchored on purpose: LLMRegistry.resolve wraps each pattern in
  // `^...$` before matching, so anchoring here would double-anchor and never
  // match.
  static override readonly supportedModels: Array<string | RegExp> = [
    /chrome-on-device/,
    /chrome\/.*/,
  ];

  private readonly params: ChromePromptApiLlmParams;

  /**
   * A warm session holding only the system prompt, cloned per request.
   *
   * The *promise* is memoised, not the resolved session. Under a
   * `ParallelAgent` fan-out every child reaches this at the same instant, and
   * caching only the resolved value means they all observe an empty cache and
   * each create their own session — turning the optimisation into a no-op
   * precisely when it matters most. Sharing the in-flight promise collapses
   * them onto one `create()`.
   */
  private baseSessionPromise?: Promise<ChromeLanguageModelSession>;
  private baseSession?: ChromeLanguageModelSession;
  private baseSessionKey?: string;

  constructor(params: ChromePromptApiLlmParams = {}) {
    super({model: params.model ?? 'chrome-on-device'});
    this.params = params;
  }

  private get api(): ChromeLanguageModelFactory {
    const api =
      this.params.languageModel ??
      (globalThis as {LanguageModel?: ChromeLanguageModelFactory})
        .LanguageModel;
    if (!api) throw new ChromeModelUnavailableError('missing-api');
    return api;
  }

  /** Reports whether this browser can actually run the model. */
  async availability(): Promise<ChromeModelAvailability> {
    try {
      return await this.api.availability({
        expectedInputs: this.params.expectedInputs,
        expectedOutputs: this.params.expectedOutputs,
      });
    } catch {
      return 'unavailable';
    }
  }

  private diagnostic(diagnostic: ChromePromptApiDiagnostic): void {
    this.params.onDiagnostic?.(diagnostic);
  }

  /**
   * Returns a session cloned from a warm base carrying `systemPrompt`, and
   * rebuilds that base only when the system prompt or sampling changes.
   */
  private async acquireSession(
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<ChromeLanguageModelSession> {
    const key = JSON.stringify([
      systemPrompt,
      this.params.temperature,
      this.params.topK,
      this.params.expectedInputs,
    ]);

    if (this.baseSessionKey === key && this.baseSessionPromise) {
      const base = await this.baseSessionPromise;
      return base.clone({signal});
    }

    this.baseSessionKey = key;
    // Deliberately stored before being awaited: concurrent callers have to be
    // able to find and share this promise while it is still pending.
    this.baseSessionPromise = this.createBaseSession(systemPrompt, signal);
    try {
      const base = await this.baseSessionPromise;
      return base.clone({signal});
    } catch (error) {
      // A failed creation must not poison the cache for later attempts.
      this.baseSessionPromise = undefined;
      this.baseSessionKey = undefined;
      throw error;
    }
  }

  private async createBaseSession(
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<ChromeLanguageModelSession> {
    const availability = await this.availability();
    if (availability === 'unavailable') {
      throw new ChromeModelUnavailableError(availability);
    }

    const createOptions: ChromeCreateOptions = {signal};
    if (this.params.onDownloadProgress) {
      createOptions.monitor = (monitor) => {
        monitor.addEventListener('downloadprogress', (event) => {
          this.params.onDownloadProgress!(event.loaded);
        });
      };
    }
    if (systemPrompt) {
      createOptions.initialPrompts = [{role: 'system', content: systemPrompt}];
    }
    if (this.params.expectedInputs) {
      createOptions.expectedInputs = this.params.expectedInputs;
    }
    if (this.params.expectedOutputs) {
      createOptions.expectedOutputs = this.params.expectedOutputs;
    }
    if (this.params.temperature !== undefined) {
      createOptions.temperature = this.params.temperature;
      createOptions.topK = this.params.topK ?? 3;
    }

    const startedAt = performance.now();
    let session: ChromeLanguageModelSession;
    try {
      session = await this.api.create(createOptions);
    } catch (error) {
      // Sampling parameters are rejected outside extension contexts. Retry
      // without them so the same code path works on a plain web page.
      if (this.params.temperature === undefined) throw error;
      delete createOptions.temperature;
      delete createOptions.topK;
      session = await this.api.create(createOptions);
    }
    this.diagnostic({phase: 'create', ms: performance.now() - startedAt});

    session.addEventListener?.('contextoverflow', () => {
      this.diagnostic({
        phase: 'context-overflow',
        note: 'history truncated by the browser',
        contextUsage: session.contextUsage,
        contextWindow: session.contextWindow,
      });
    });

    this.baseSession = session;
    return session;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const declarations = collectFunctionDeclarations(llmRequest);
    const useTools = declarations.length > 0;

    const rawSystem = extractSystemInstruction(llmRequest);
    const systemParts = [
      this.params.normalizeSystemPrompt
        ? this.params.normalizeSystemPrompt(rawSystem)
        : rawSystem,
    ];
    if (useTools) systemParts.push(renderToolInstructions(declarations));
    const systemPrompt = systemParts.filter(Boolean).join('\n\n');

    const messages = contentsToMessages(llmRequest.contents ?? []);
    if (!messages.length) messages.push({role: 'user', content: 'Continue.'});

    let session: ChromeLanguageModelSession | undefined;
    try {
      session = await this.acquireSession(systemPrompt, abortSignal);

      // An ADK output schema maps straight onto responseConstraint.
      const outputSchema =
        llmRequest.config?.responseJsonSchema ??
        llmRequest.config?.responseSchema;

      const responseConstraint = useTools
        ? buildToolChoiceSchema(declarations)
        : outputSchema
          ? genaiSchemaToJsonSchema(outputSchema)
          : undefined;

      // Streaming is only meaningful for free text. When the reply has to
      // satisfy a schema, it means nothing until the whole document arrives.
      if (stream && !responseConstraint) {
        yield* this.streamText(session, messages, abortSignal);
        return;
      }

      const raw = await this.promptOnce(
        session,
        messages,
        responseConstraint,
        abortSignal,
      );

      yield useTools ? this.parseToolChoice(raw, declarations) : finalText(raw);
    } catch (error) {
      yield errorResponse(error);
    } finally {
      // Only clones are destroyed; the base session stays warm.
      if (session && session !== this.baseSession) session.destroy?.();
    }
  }

  private async promptOnce(
    session: ChromeLanguageModelSession,
    messages: ChromeMessage[],
    responseConstraint: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const startedAt = performance.now();
    const output = await session.prompt(messages, {
      signal,
      ...(responseConstraint
        ? {responseConstraint, omitResponseConstraintInput: true}
        : {}),
    });
    this.diagnostic({
      phase: 'prompt',
      ms: performance.now() - startedAt,
      contextUsage: session.contextUsage,
      contextWindow: session.contextWindow,
    });
    return output;
  }

  private async *streamText(
    session: ChromeLanguageModelSession,
    messages: ChromeMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const reader = session.promptStreaming(messages, {signal}).getReader();
    let accumulated = '';
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        accumulated += value;
        yield {
          content: {role: 'model', parts: [{text: value}]},
          partial: true,
        };
      }
    } finally {
      reader.releaseLock();
    }
    yield {
      content: {role: 'model', parts: [{text: accumulated}]},
      turnComplete: true,
    };
  }

  /** Turns the constrained JSON reply into an ADK response. */
  private parseToolChoice(
    raw: string,
    declarations: FunctionDeclaration[],
  ): LlmResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The constraint should make this impossible, but a small model
      // sometimes wraps its output in prose or fences. Salvage the first
      // JSON object.
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          // Fall through to the plain-text path below.
        }
      }
    }

    if (!isRecord(parsed)) {
      this.diagnostic({
        phase: 'parse-fallback',
        note: 'unparseable JSON; treated as text',
      });
      return finalText(raw);
    }

    if (parsed['kind'] === 'tool' && typeof parsed['name'] === 'string') {
      const name = parsed['name'];
      if (!declarations.some((declaration) => declaration.name === name)) {
        return finalText(`The model requested an unknown tool "${name}".`);
      }
      const args = isRecord(parsed['args']) ? parsed['args'] : {};
      return {
        content: {
          role: 'model',
          parts: [{functionCall: {id: newCallId(), name, args}}],
        },
        turnComplete: true,
      };
    }

    return finalText(typeof parsed['text'] === 'string' ? parsed['text'] : raw);
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      "Chrome's Prompt API has no bidirectional live mode, so connect() is " +
        'not supported by ChromePromptApiLlm.',
    );
  }

  /** Releases the warm base session. */
  destroy(): void {
    this.baseSession?.destroy?.();
    this.baseSession = undefined;
    this.baseSessionPromise = undefined;
    this.baseSessionKey = undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function newCallId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `chrome-${Date.now()}-${random}`;
}

function finalText(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, turnComplete: true};
}

function errorResponse(error: unknown): LlmResponse {
  const details = isRecord(error) ? error : {};
  const name =
    typeof details['name'] === 'string' ? details['name'] : 'UnknownError';
  const message =
    typeof details['message'] === 'string' ? details['message'] : String(error);

  if (name === 'QuotaExceededError') {
    return {
      errorCode: name,
      errorMessage:
        `Prompt exceeded the context window (requested ` +
        `${details['requested']} of ${details['contextWindow']} tokens).`,
      turnComplete: true,
    };
  }
  return {errorCode: name, errorMessage: message, turnComplete: true};
}
