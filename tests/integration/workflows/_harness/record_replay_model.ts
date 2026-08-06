/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Record/replay model boundary for the workflow-sample integration tests.
 *
 * The samples construct `LlmAgent`s with a string model (`gemini-2.5-flash`),
 * which every agent resolves lazily via `LLMRegistry.newLlm(...)`. We register a
 * single {@link RecordReplayModel} for the Gemini model regexes so that EVERY
 * agent in a sample — including ones captured inside a `dynamicEntry`/`ctx.runNode`
 * closure that static traversal can't reach — resolves to it.
 *
 * - Replay (default): each model call is matched to a recorded response by a
 *   stable fingerprint of its request. Concurrency- and order-independent, so
 *   parallel samples need no special casing. A miss throws with a re-record hint.
 * - Record (`RECORD_MODEL_RESPONSES=1`): the call is delegated to a real Gemini
 *   and the raw response is captured keyed by the same fingerprint.
 */

import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {BaseLlm, Gemini, LLMRegistry} from '@google/adk';
import type {Candidate} from '@google/genai';
import {createHash} from 'node:crypto';
import type {RawGenerateContentResponse} from '../../test_case_utils.js';

/** A single recorded model call: its request fingerprint and raw response. */
export interface RecordedCall {
  /** Stable fingerprint of the request (see {@link fingerprint}). */
  key: string;
  /** A readable snippet of the request, for debugging the fixture. */
  request: {contents: unknown; systemInstruction?: unknown};
  /** The raw response to replay. */
  response: RawGenerateContentResponse;
}

type Mode = 'record' | 'replay';

interface HarnessState {
  mode: Mode;
  recorded: RecordedCall[];
  replay: Map<
    string,
    {responses: RawGenerateContentResponse[]; cursor: number}
  >;
  /** Backend used in record mode (default: a real Gemini). Overridable in tests. */
  liveBackend: (model: string) => BaseLlm;
}

let state: HarnessState | undefined;

/** Recursively sorts object keys so JSON serialization is stable. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Strips volatile fields (randomly-generated `id`s on function calls/responses)
 * so a request fingerprints identically across the record run and later replays.
 */
function normalizeContents(contents: unknown): unknown {
  const clone = structuredClone(contents) as unknown;
  const scrub = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(scrub);
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if ('functionCall' in obj && obj['functionCall']) {
        delete (obj['functionCall'] as Record<string, unknown>)['id'];
      }
      if ('functionResponse' in obj && obj['functionResponse']) {
        delete (obj['functionResponse'] as Record<string, unknown>)['id'];
      }
      for (const v of Object.values(obj)) scrub(v);
    }
  };
  scrub(clone);
  return clone;
}

/** Stable fingerprint of a model request (contents + config, id-normalized). */
export function fingerprint(req: LlmRequest): string {
  const material = JSON.stringify(
    sortKeys({
      contents: normalizeContents(req.contents),
      config: req.config ?? {},
    }),
  );
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** Reconstructs the raw response shape the fixture stores from an LlmResponse. */
function toRaw(resp: LlmResponse): RawGenerateContentResponse {
  const candidate: Candidate = {
    content: resp.content,
    finishReason: resp.finishReason,
    groundingMetadata: resp.groundingMetadata,
    citationMetadata: resp.citationMetadata,
  };
  return {
    candidates: resp.content ? [candidate] : [],
    usageMetadata: resp.usageMetadata,
  };
}

/** Inflates a recorded raw response back into an LlmResponse for replay. */
function toLlmResponse(raw: RawGenerateContentResponse): LlmResponse {
  const candidate = raw.candidates?.[0];
  return {
    content: candidate?.content,
    finishReason: candidate?.finishReason,
    groundingMetadata: candidate?.groundingMetadata,
    citationMetadata: candidate?.citationMetadata,
    usageMetadata: raw.usageMetadata,
  };
}

/**
 * The model registered for the Gemini regexes during a sample test. It reuses
 * `Gemini.supportedModels` (the same RegExp instances) so registering it
 * overwrites Gemini's registry entries rather than adding lower-priority ones.
 */
class RecordReplayModel extends BaseLlm {
  static override readonly supportedModels = Gemini.supportedModels;

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    if (!state) {
      throw new Error(
        'RecordReplayModel used without installRecordReplay(); did the harness set it up?',
      );
    }
    const key = fingerprint(llmRequest);

    if (state.mode === 'replay') {
      const entry = state.replay.get(key);
      if (!entry) {
        throw new Error(
          `No recorded model response for request fingerprint ${key}. ` +
            'Re-record with: npm run record:samples',
        );
      }
      // Deterministic: identical requests reuse the last recorded response.
      const raw =
        entry.responses[Math.min(entry.cursor, entry.responses.length - 1)];
      entry.cursor++;
      yield toLlmResponse(raw);
      return;
    }

    // Record: delegate to a real backend and capture the raw response.
    const backend = state.liveBackend(this.model);
    for await (const resp of backend.generateContentAsync(
      llmRequest,
      stream,
      abortSignal,
    )) {
      state.recorded.push({
        key,
        request: {
          contents: normalizeContents(llmRequest.contents),
          systemInstruction: llmRequest.config?.systemInstruction,
        },
        response: toRaw(resp),
      });
      yield resp;
    }
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('RecordReplayModel does not support live connections.');
  }
}

/**
 * Installs the record/replay model into the LLM registry and sets the mode.
 * Call once per test run (before the runner executes).
 */
export function installRecordReplay(opts: {
  mode: Mode;
  recordedCalls?: RecordedCall[];
  liveBackend?: (model: string) => BaseLlm;
}): void {
  const replay = new Map<
    string,
    {responses: RawGenerateContentResponse[]; cursor: number}
  >();
  for (const call of opts.recordedCalls ?? []) {
    const entry = replay.get(call.key) ?? {responses: [], cursor: 0};
    entry.responses.push(call.response);
    replay.set(call.key, entry);
  }
  state = {
    mode: opts.mode,
    recorded: [],
    replay,
    liveBackend: opts.liveBackend ?? ((model: string) => new Gemini({model})),
  };
  LLMRegistry.register(RecordReplayModel);
}

/** Restores the real Gemini registration and clears harness state. */
export function restoreRecordReplay(): void {
  LLMRegistry.register(Gemini);
  state = undefined;
}

/** Returns the calls captured during a record run. */
export function drainRecordedCalls(): RecordedCall[] {
  return state?.recorded ?? [];
}
