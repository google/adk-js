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
 *   stable fingerprint of its request (contents + config) — exact,
 *   concurrency- and order-independent, so parallel samples need no special
 *   casing. On a miss the match degrades once: a request whose system
 *   instruction alone has changed since it was recorded still matches, but is
 *   then served in recording order and warns. A miss on both keys throws with a
 *   re-record hint.
 * - Record (`RECORD_MODEL_RESPONSES=1`): the call is delegated to a real Gemini
 *   and the raw response is captured under both fingerprints.
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
   * Fallback fingerprint over everything but the system instruction (see
   * {@link instructionAgnosticFingerprint}), used when a prompt change
   * invalidates {@link key}.
   */
  instructionAgnosticKey: string;
  /**
   * The request both keys were taken over: readable when debugging a fixture,
   * and enough to re-derive the keys offline should the fingerprints ever have
   * to change, without a re-record.
   */
  request: {contents: unknown; config: unknown};
  /** The raw response to replay. */
  response: RawGenerateContentResponse;
}

type Mode = 'record' | 'replay';

/** Recorded responses for one fingerprint, served in recording order. */
interface ReplayEntry {
  responses: RawGenerateContentResponse[];
  cursor: number;
}

/** The two indexes {@link lookup} consults, and their shared read position. */
interface ReplayIndexes {
  /** Exact index: contents + config. */
  exact: Map<string, ReplayEntry>;
  /** Fallback index: everything but the system instruction. */
  byRequest: Map<string, ReplayEntry>;
}

interface HarnessState extends ReplayIndexes {
  mode: Mode;
  recorded: RecordedCall[];
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
 * Drops the caller's `AbortSignal`: a live handle rather than request data,
 * which serializes to `{}` and so tells no two calls apart anyway.
 */
function normalizeConfig(
  config: LlmRequest['config'],
): Record<string, unknown> {
  const {abortSignal: _signal, ...rest} = config ?? {};
  return rest;
}

/** A framework-generated id: random per run, so never part of a key. */
const VOLATILE_ID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Scrubs ids out of the system instruction, which {@link normalizeContents}
 * cannot reach: a sample that interpolates state holding a function response
 * prints the id the framework generated for it into the prompt (the HITL
 * samples do, through `{complaint}`). Left in, the exact key would differ on
 * every run and such a call could only ever match through the degraded
 * fallback — which a re-record would not fix, since the next run generates a
 * new id again.
 */
function scrubInstructionIds(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const instruction = config['systemInstruction'];
  if (instruction === undefined) {
    return config;
  }
  return {
    ...config,
    systemInstruction: JSON.parse(
      JSON.stringify(instruction).replace(VOLATILE_ID, '<id>'),
    ) as unknown,
  };
}

/**
 * Exact fingerprint of a model request: contents + config, id-normalized.
 *
 * `config` carries the system instruction, so this is deliberately sensitive to
 * the prompt — two agents that differ only in their instructions are told
 * apart. It is also why it cannot be the only key: see
 * {@link instructionAgnosticFingerprint}.
 */
export function fingerprint(req: LlmRequest): string {
  return hash({
    contents: normalizeContents(req.contents),
    config: scrubInstructionIds(normalizeConfig(req.config)),
  });
}

/**
 * Fallback fingerprint over the request minus its system instruction.
 *
 * Anything that edits a system instruction — a prompt tweak, or a framework
 * change like #616 dropping the identity preamble for transfer-disabled agents
 * — changes {@link fingerprint} for every call in every fixture at once, and
 * the whole sample suite fails with each agent producing nothing. Dropping just
 * that one field absorbs such a change while the rest of `config` still has to
 * match, so a regression that drops a tool or a `responseSchema` is still a
 * miss rather than a green replay.
 *
 * This is a degraded match, not an equal one: calls that differ only in their
 * instructions (a real case — `nested_workflow`) collapse into one bucket and
 * are then served in recording order, which a concurrent sample does not
 * guarantee. Hitting this path warns and asks for a re-record.
 */
export function instructionAgnosticFingerprint(req: LlmRequest): string {
  const {systemInstruction: _instruction, ...config} = normalizeConfig(
    req.config,
  );
  return hash({contents: normalizeContents(req.contents), config});
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

interface Match {
  entry: ReplayEntry;
  /**
   * Set when only the fallback key matched, naming it for the warning; absent
   * on an exact match.
   */
  staleKey?: string;
}

/** Finds the recorded responses for a request, exactly or by the fallback key. */
function lookup(
  s: HarnessState,
  keys: {key: string; instructionAgnosticKey: string},
): Match | undefined {
  const exact = s.exact.get(keys.key);
  if (exact) {
    return {entry: exact};
  }
  // The prompt moved under the fixture: match on everything else, so one
  // instruction edit does not take out every sample at once.
  const byRequest = s.byRequest.get(keys.instructionAgnosticKey);
  if (byRequest) {
    return {entry: byRequest, staleKey: keys.instructionAgnosticKey};
  }
  return undefined;
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
    const instructionAgnosticKey = instructionAgnosticFingerprint(llmRequest);

    if (state.mode === 'replay') {
      const match = lookup(state, {key, instructionAgnosticKey});
      if (!match) {
        // This throw is easy to lose: the caller can swallow it and the failure
        // then surfaces far away, as a node reading a property of `undefined`.
        // Say it once on stderr where it happens, with both keys that missed.
        const message =
          `No recorded model response for request ${key} (minus instruction ` +
          `${instructionAgnosticKey}). Re-record with: npm run record:samples`;
        console.error(`[sample-harness] ${message}`);
        throw new Error(message);
      }
      const {entry, staleKey} = match;
      if (staleKey) {
        warnStaleFixture(staleKey, entry.responses.length);
      }
      // Deterministic: identical requests reuse the last recorded response.
      const raw =
        entry.responses[Math.min(entry.cursor, entry.responses.length - 1)];
      entry.cursor++;
      yield toLlmResponse(raw);
      return;
    }

    // Record: delegate to a real backend and capture the raw response.
    //
    // Snapshot the request first. A backend may edit it on the way out —
    // `Gemini.preprocessRequest` clears `config.labels` on the Gemini API path
    // — and a fixture whose stored request is not the one its keys were taken
    // over could not re-derive them.
    const request = {
      contents: normalizeContents(llmRequest.contents),
      // Kept whole (system instruction included) so both keys can be
      // re-derived offline should the fingerprints have to change again.
      config: normalizeConfig(llmRequest.config),
    };
    const backend = state.liveBackend(this.model);
    for await (const resp of backend.generateContentAsync(
      llmRequest,
      stream,
      abortSignal,
    )) {
      state.recorded.push({
        key,
        instructionAgnosticKey,
        request,
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
 * Replay indexes already built this process, by fixture. A sample's scenarios
 * share one fixture file, written in the order they ran, so their read position
 * has to carry across the `runSample` calls that replay it: restarting each
 * scenario at the first recorded response serves scenario 1's draft to scenario
 * 3, and a follow-up call whose conversation quotes scenario 3's draft — the
 * revise turn of a HITL sample — then matches nothing.
 */
const replayIndexes = new Map<string, ReplayIndexes>();

/**
 * Installs the record/replay model into the LLM registry and sets the mode.
 * Call once per test run (before the runner executes).
 *
 * Builds the two indexes {@link lookup} consults, keeping them (cursors and
 * all) under `fixtureId` for the scenarios that replay the same fixture later
 * in the process. A fixture written before both keys existed lands in neither
 * under a key any request can produce, so it misses and says to re-record —
 * deliberately, rather than matching on something loose enough to hide a
 * dropped tool or `responseSchema`.
 */
export function installRecordReplay(opts: {
  mode: Mode;
  recordedCalls?: RecordedCall[];
  liveBackend?: (model: string) => BaseLlm;
  /** The fixture being replayed, identified by path. */
  fixtureId?: string;
}): void {
  const shared = opts.mode === 'replay' ? opts.fixtureId : undefined;
  let indexes = shared === undefined ? undefined : replayIndexes.get(shared);
  if (!indexes) {
    indexes = buildIndexes(opts.recordedCalls ?? []);
    if (shared !== undefined) {
      replayIndexes.set(shared, indexes);
    }
  }
  warnedStaleKeys.clear();
  state = {
    mode: opts.mode,
    recorded: [],
    ...indexes,
    liveBackend: opts.liveBackend ?? ((model: string) => new Gemini({model})),
  };
  LLMRegistry.register(RecordReplayModel);
}

function buildIndexes(calls: RecordedCall[]): ReplayIndexes {
  const exact = new Map<string, ReplayEntry>();
  const byRequest = new Map<string, ReplayEntry>();
  const index = (map: Map<string, ReplayEntry>, key: string): ReplayEntry => {
    const entry = map.get(key) ?? {responses: [], cursor: 0};
    map.set(key, entry);
    return entry;
  };
  for (const call of calls) {
    index(exact, call.key).responses.push(call.response);
    index(byRequest, call.instructionAgnosticKey).responses.push(call.response);
  }
  return {exact, byRequest};
}

/** Fallback keys already reported stale this run, so each is warned about once. */
const warnedStaleKeys = new Set<string>();

function warnStaleFixture(matchedKey: string, candidates: number): void {
  if (warnedStaleKeys.has(matchedKey)) {
    return;
  }
  warnedStaleKeys.add(matchedKey);
  const ambiguity =
    candidates > 1
      ? ` ${candidates} recorded calls share this key, so they are being ` +
        'served in recording order — which a concurrent sample does not guarantee.'
      : '';
  console.warn(
    `[sample-harness] Stale fixture: matched request ${matchedKey} on ` +
      'everything but its system instruction, so the prompt has changed since ' +
      `it was recorded. Replaying anyway.${ambiguity} Refresh with: ` +
      'npm run record:samples',
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
