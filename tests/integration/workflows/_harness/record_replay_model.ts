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
 *   casing. On a miss the match degrades a step at a time (see
 *   {@link installRecordReplay}): a request whose system instruction alone has
 *   changed since it was recorded still matches, but is then served in
 *   recording order and warns. A miss on every key throws with a re-record hint.
 * - Record (`RECORD_MODEL_RESPONSES=1`): the call is delegated to a real Gemini
 *   and the raw response is captured under the same fingerprints.
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
   * invalidates {@link key}. Absent on fixtures recorded before it existed.
   */
  instructionAgnosticKey?: string;
  /**
   * Last-resort fingerprint over the contents alone (see
   * {@link contentsFingerprint}). Only consulted for fixtures that predate
   * {@link instructionAgnosticKey} and so never recorded their `config`; see
   * {@link installRecordReplay}.
   */
  contentsKey?: string;
  /**
   * The request, for debugging the fixture and for deriving keys offline if the
   * fingerprints ever have to change again (which is how `contentsKey` was
   * added to existing fixtures without re-recording them).
   *
   * `systemInstruction` is the legacy form: fixtures recorded before `config`
   * was stored kept only that one field of it.
   */
  request: {contents: unknown; config?: unknown; systemInstruction?: unknown};
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
  exact: Map<string, ReplayEntry>;
  /** Fallback index: everything but the system instruction. */
  byRequest: Map<string, ReplayEntry>;
  /** Last-resort index: contents only, for fixtures that recorded no config. */
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
 * {@link instructionAgnosticFingerprint}.
 */
export function fingerprint(req: LlmRequest): string {
  return hash({
    contents: normalizeContents(req.contents),
    config: req.config ?? {},
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
  const {systemInstruction: _instruction, ...config} = req.config ?? {};
  return hash({contents: normalizeContents(req.contents), config});
}

/**
 * Last-resort fingerprint over the request's contents alone.
 *
 * For fixtures recorded before {@link instructionAgnosticFingerprint} existed:
 * they stored no `config`, so contents are all that can be matched on once the
 * prompt has moved. Weaker than the key above in exactly the way that key was
 * introduced to avoid — `tools` and `responseSchema` go unchecked, so a
 * regression dropping either still replays green — and the warning says so.
 * This tier retires with the last un-re-recorded fixture.
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

/** How closely a replayed request matched what was recorded. */
type MatchTier = 'exact' | 'instructionAgnostic' | 'contents';

interface Match {
  entry: ReplayEntry;
  tier: MatchTier;
  /** The key that matched, named in the warning for a degraded tier. */
  matchedKey: string;
}

/**
 * Finds the recorded responses for a request, degrading a tier at a time (see
 * {@link installRecordReplay} for what populates each index).
 */
function lookup(
  s: HarnessState,
  keys: {key: string; instructionAgnosticKey: string; contentsKey: string},
): Match | undefined {
  const exact = s.exact.get(keys.key);
  if (exact) {
    return {entry: exact, tier: 'exact', matchedKey: keys.key};
  }
  // The prompt moved under the fixture: match on everything else, so one
  // instruction edit does not take out every sample at once.
  const byRequest = s.byRequest.get(keys.instructionAgnosticKey);
  if (byRequest) {
    return {
      entry: byRequest,
      tier: 'instructionAgnostic',
      matchedKey: keys.instructionAgnosticKey,
    };
  }
  const byContents = s.byContents.get(keys.contentsKey);
  if (byContents) {
    return {entry: byContents, tier: 'contents', matchedKey: keys.contentsKey};
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
      const contentsKey = contentsFingerprint(llmRequest.contents);
      const match = lookup(state, {
        key,
        instructionAgnosticKey,
        contentsKey,
      });
      if (!match) {
        // This throw is easy to lose: the caller can swallow it and the failure
        // then surfaces far away, as a node reading a property of `undefined`.
        // Say it once on stderr where it happens, with every key that missed.
        const message =
          `No recorded model response for request ${key} (minus instruction ` +
          `${instructionAgnosticKey}, contents ${contentsKey}). ` +
          'Re-record with: npm run record:samples';
        console.error(`[sample-harness] ${message}`);
        throw new Error(message);
      }
      const {entry, tier} = match;
      if (tier !== 'exact') {
        warnStaleFixture(tier, match.matchedKey, entry.responses.length);
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
        instructionAgnosticKey,
        request: {
          contents: normalizeContents(llmRequest.contents),
          // Stored whole (system instruction included) so both keys can be
          // re-derived offline should the fingerprints have to change again.
          config: llmRequest.config ?? {},
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
 *
 * Builds the indexes {@link lookup} consults, in order of decreasing strictness.
 * A call joins the contents-only index *instead of* the instruction-agnostic
 * one, never as well: that last tier is a migration path for fixtures whose
 * `config` was never recorded, and offering it to a fixture that has one would
 * hand back the very coverage — `tools`, `responseSchema` — the middle tier
 * exists to keep.
 */
export function installRecordReplay(opts: {
  mode: Mode;
  recordedCalls?: RecordedCall[];
  liveBackend?: (model: string) => BaseLlm;
}): void {
  const exact = new Map<string, ReplayEntry>();
  const byRequest = new Map<string, ReplayEntry>();
  const byContents = new Map<string, ReplayEntry>();
  const index = (map: Map<string, ReplayEntry>, key: string): ReplayEntry => {
    const entry = map.get(key) ?? {responses: [], cursor: 0};
    map.set(key, entry);
    return entry;
  };
  for (const call of opts.recordedCalls ?? []) {
    index(exact, call.key).responses.push(call.response);
    if (call.instructionAgnosticKey) {
      index(byRequest, call.instructionAgnosticKey).responses.push(
        call.response,
      );
    } else {
      // Recorded before the config was fingerprinted, so the contents are all
      // that survives a prompt change; recomputed for fixtures older still.
      const contentsKey =
        call.contentsKey ?? contentsFingerprint(call.request.contents);
      index(byContents, contentsKey).responses.push(call.response);
    }
  }
  warnedStaleKeys.clear();
  state = {
    mode: opts.mode,
    recorded: [],
    exact,
    byRequest,
    byContents,
    liveBackend: opts.liveBackend ?? ((model: string) => new Gemini({model})),
  };
  LLMRegistry.register(RecordReplayModel);
}

/** Fallback keys already reported stale this run, so each is warned about once. */
const warnedStaleKeys = new Set<string>();

function warnStaleFixture(
  tier: Exclude<MatchTier, 'exact'>,
  matchedKey: string,
  candidates: number,
): void {
  if (warnedStaleKeys.has(matchedKey)) {
    return;
  }
  warnedStaleKeys.add(matchedKey);
  const ambiguity =
    candidates > 1
      ? ` ${candidates} recorded calls share this key, so they are being ` +
        'served in recording order — which a concurrent sample does not guarantee.'
      : '';
  const what =
    tier === 'instructionAgnostic'
      ? `matched request ${matchedKey} on everything but its system ` +
        'instruction, so the prompt has changed since it was recorded.'
      : `matched request contents ${matchedKey} but not its config, so the ` +
        'prompt has changed since it was recorded. This fixture predates ' +
        'config fingerprinting and stored no config, so its tools and ' +
        'response schema go unverified here — dropping either would still ' +
        'replay green.';
  console.warn(
    `[sample-harness] Stale fixture: ${what} Replaying anyway.${ambiguity} ` +
      'Refresh with: npm run record:samples',
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
