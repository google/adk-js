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

/** A single recorded model call: its request fingerprints and raw response. */
export interface RecordedCall {
  /** Exact fingerprint of the request: contents + config (see {@link fingerprint}). */
  key: string;
  /**
   * Fallback fingerprint over the request's contents alone (see
   * {@link contentsFingerprint}), used when a prompt change invalidates
   * {@link key}.
   */
  contentsKey?: string;
  /** A readable snippet of the request, for debugging the fixture. */
  request: {contents: unknown; systemInstruction?: unknown};
  /** The raw response to replay. */
  response: RawGenerateContentResponse;
}

type Mode = 'record' | 'replay';

/** Recorded responses for one fingerprint, served in recording order. */
interface ReplayEntry {
  responses: RawGenerateContentResponse[];
  cursor: number;
}

interface HarnessState {
  mode: Mode;
  recorded: RecordedCall[];
  /** Exact index: contents + config. */
  replay: Map<string, ReplayEntry>;
  /** Fallback index: contents only. */
  byContents: Map<string, ReplayEntry>;
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

function hash(material: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(material)))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Exact fingerprint of a model request: contents + config, id-normalized.
 *
 * `config` carries the system instruction, so this is deliberately sensitive to
 * the prompt — two agents that differ only in their instructions are told
 * apart. It is also why it cannot be the only key: see
 * {@link contentsFingerprint}.
 */
export function fingerprint(req: LlmRequest): string {
  return hash({
    contents: normalizeContents(req.contents),
    config: req.config ?? {},
  });
}

/**
 * Fallback fingerprint over the request's contents alone.
 *
 * Anything that edits a system instruction — a prompt tweak, or a framework
 * change like #616 dropping the identity preamble for transfer-disabled agents
 * — changes {@link fingerprint} for every call in every fixture at once, and
 * the whole sample suite fails with each agent producing nothing. The contents
 * are what actually distinguish one call from another within a sample, and they
 * are unaffected by such a change, so a miss on the exact key retries here.
 *
 * This is a degraded match, not an equal one: calls that share contents and
 * differ only in their instructions (a real case — `nested_workflow`) collapse
 * into one bucket and are then served in recording order, which a concurrent
 * sample does not guarantee. Hitting this path warns and asks for a re-record.
 */
export function contentsFingerprint(contents: unknown): string {
  return hash({contents: normalizeContents(contents)});
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
    const contentsKey = contentsFingerprint(llmRequest.contents);

    if (state.mode === 'replay') {
      let entry = state.replay.get(key);
      if (!entry) {
        // The prompt moved under the fixture: fall back to matching on the
        // contents (see `contentsFingerprint`), so one instruction edit does
        // not take out every sample at once.
        entry = state.byContents.get(contentsKey);
        if (entry) {
          warnStaleFixture(contentsKey, entry.responses.length);
        }
      }
      if (!entry) {
        // This throw is easy to lose: the caller can swallow it and the failure
        // then surfaces far away, as a node reading a property of `undefined`.
        // Say it once on stderr where it happens.
        const message =
          `No recorded model response for request ${key} (contents ` +
          `${contentsKey}). Re-record with: npm run record:samples`;
        console.error(`[sample-harness] ${message}`);
        throw new Error(message);
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
        contentsKey,
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
  const replay = new Map<string, ReplayEntry>();
  const byContents = new Map<string, ReplayEntry>();
  const index = (map: Map<string, ReplayEntry>, key: string | undefined) => {
    if (!key) return;
    const entry = map.get(key) ?? {responses: [], cursor: 0};
    map.set(key, entry);
    return entry;
  };
  for (const call of opts.recordedCalls ?? []) {
    index(replay, call.key)?.responses.push(call.response);
    // Fixtures recorded before `contentsKey` existed fall back on the value
    // recomputed from the contents they stored.
    const contentsKey =
      call.contentsKey ?? contentsFingerprint(call.request.contents);
    index(byContents, contentsKey)?.responses.push(call.response);
  }
  warnedStaleKeys.clear();
  state = {
    mode: opts.mode,
    recorded: [],
    replay,
    byContents,
    liveBackend: opts.liveBackend ?? ((model: string) => new Gemini({model})),
  };
  LLMRegistry.register(RecordReplayModel);
}

/** Contents keys already reported stale this run, so each is warned about once. */
const warnedStaleKeys = new Set<string>();

function warnStaleFixture(contentsKey: string, candidates: number): void {
  if (warnedStaleKeys.has(contentsKey)) {
    return;
  }
  warnedStaleKeys.add(contentsKey);
  const ambiguity =
    candidates > 1
      ? ` ${candidates} recorded calls share these contents, so they are being ` +
        'served in recording order — which a concurrent sample does not guarantee.'
      : '';
  console.warn(
    `[sample-harness] Stale fixture: matched request contents ${contentsKey} ` +
      'but not its config, so the prompt has changed since it was recorded. ' +
      `Replaying anyway.${ambiguity} Refresh with: npm run record:samples`,
  );
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
