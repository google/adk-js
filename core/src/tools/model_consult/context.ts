/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session context handover for {@link ModelConsultTool}.
 *
 * Converts a session's event history into `Content` messages suitable for the
 * tool-free advisor model call. Because the advisor has no tools of its own, raw
 * `functionCall` and `functionResponse` parts from the executor's session are
 * rendered as compact, human-readable text blocks so that:
 *
 * 1. The advisor can inspect every tool call and result without needing matching
 *    tool declarations on its request.
 * 2. Large tool outputs are truncated to a predictable budget instead of blowing
 *    out the advisor's context window.
 * 3. All converted messages use `role='user'` so the advisor receives a clean,
 *    well-formed prompt ending with the consultation handoff.
 */

import {Content, Part} from '@google/genai';

import {Event} from '../../events/event.js';

export const DEFAULT_MAX_CONTEXT_CHARS = 200_000;
export const DEFAULT_MAX_PART_CHARS = 4_000;

/**
 * Fraction of `maxChars` reserved for the opening of the session (initial user
 * request, constraints, and setup) so long sessions do not lose the original
 * goal when later tool output fills the budget.
 */
const HEAD_BUDGET_FRACTION = 4; // 1/4 head, 3/4 tail

/**
 * Unique brand symbol used to identify {@link ModelConsultContextConfig}
 * instances across module boundaries.
 */
const MODEL_CONSULT_CONTEXT_CONFIG_SYMBOL = Symbol.for(
  'google.adk.modelConsultContextConfig',
);

/**
 * Type guard to check if an object is an instance of
 * {@link ModelConsultContextConfig}.
 */
export function isModelConsultContextConfig(
  obj: unknown,
): obj is ModelConsultContextConfig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    MODEL_CONSULT_CONTEXT_CONFIG_SYMBOL in obj &&
    (obj as {[MODEL_CONSULT_CONTEXT_CONFIG_SYMBOL]?: unknown})[
      MODEL_CONSULT_CONTEXT_CONFIG_SYMBOL
    ] === true
  );
}

/**
 * Options for configuring {@link ModelConsultContextConfig}.
 */
export interface ModelConsultContextConfigOptions {
  /** Whether to forward the session's prior events to the advisor. Defaults to `true`. */
  includeSession?: boolean;
  /** Optional cap on the number of most-recent non-partial events to include. */
  maxEvents?: number | null;
  /** Approximate character budget across all forwarded session contents. Defaults to `200_000`. */
  maxChars?: number;
  /** Maximum characters kept for a single rendered tool call or tool response. Defaults to `4_000`. */
  maxPartChars?: number;
  /** Whether to pass inline media / file parts (`inlineData`, `fileData`) to the advisor. Defaults to `true`. */
  includeMedia?: boolean;
  /** Whether to include the executor's internal thought parts (`part.thought === true`). Defaults to `false`. */
  includeThoughts?: boolean;
}

const KNOWN_CONFIG_KEYS = new Set([
  'includeSession',
  'maxEvents',
  'maxChars',
  'maxPartChars',
  'includeMedia',
  'includeThoughts',
]);

/**
 * Controls how the executor's session is packaged for the advisor model.
 */
export class ModelConsultContextConfig {
  readonly [MODEL_CONSULT_CONTEXT_CONFIG_SYMBOL] = true;
  readonly includeSession: boolean;
  readonly maxEvents?: number;
  readonly maxChars: number;
  readonly maxPartChars: number;
  readonly includeMedia: boolean;
  readonly includeThoughts: boolean;

  constructor(options: ModelConsultContextConfigOptions = {}) {
    if (options && typeof options === 'object') {
      for (const key of Object.keys(options)) {
        if (!KNOWN_CONFIG_KEYS.has(key)) {
          throw new Error(
            `Unknown ModelConsultContextConfig field '${key}'. Allowed fields: ` +
              'includeSession, maxEvents, maxChars, maxPartChars, includeMedia, includeThoughts.',
          );
        }
      }
    }

    this.includeSession = options.includeSession ?? true;

    const rawMaxEvents = options.maxEvents;
    if (rawMaxEvents !== undefined && rawMaxEvents !== null) {
      if (
        typeof rawMaxEvents !== 'number' ||
        !Number.isInteger(rawMaxEvents) ||
        rawMaxEvents < 1
      ) {
        throw new Error(
          `maxEvents must be an integer >= 1 or null, got ${String(rawMaxEvents)}.`,
        );
      }
      this.maxEvents = rawMaxEvents;
    } else {
      this.maxEvents = undefined;
    }

    const rawMaxChars = options.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;
    if (
      typeof rawMaxChars !== 'number' ||
      !Number.isInteger(rawMaxChars) ||
      rawMaxChars < 1
    ) {
      throw new Error(
        `maxChars must be an integer >= 1, got ${String(rawMaxChars)}.`,
      );
    }
    this.maxChars = rawMaxChars;

    const rawMaxPartChars = options.maxPartChars ?? DEFAULT_MAX_PART_CHARS;
    if (
      typeof rawMaxPartChars !== 'number' ||
      !Number.isInteger(rawMaxPartChars) ||
      rawMaxPartChars < 1
    ) {
      throw new Error(
        `maxPartChars must be an integer >= 1, got ${String(rawMaxPartChars)}.`,
      );
    }
    this.maxPartChars = rawMaxPartChars;

    this.includeMedia = options.includeMedia ?? true;
    this.includeThoughts = options.includeThoughts ?? false;
  }
}

function truncate(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) {
    return text;
  }
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n... [${omitted} chars truncated]`;
}

function serializePythonStyleJson(
  value: unknown,
  seen: Set<object> = new Set(),
): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? String(value)
      : JSON.stringify(String(value));
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    return JSON.stringify(String(value));
  }
  if (seen.has(value)) {
    throw new TypeError('Circular reference detected');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => serializePythonStyleJson(item, seen));
      return `[${items.join(', ')}]`;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const entries = keys.map(
        (k) =>
          `${JSON.stringify(k)}: ${serializePythonStyleJson(record[k], seen)}`,
      );
      return `{${entries.join(', ')}}`;
    }
    return JSON.stringify(String(value));
  } finally {
    seen.delete(value);
  }
}

function safeJson(value: unknown): string {
  try {
    return serializePythonStyleJson(value);
  } catch {
    return String(value);
  }
}

function renderArgs(
  args: Record<string, unknown> | undefined | null,
  maxChars: number,
): string {
  if (!args || Object.keys(args).length === 0) {
    return '';
  }
  let rendered: string;
  try {
    const parts = Object.entries(args).map(
      ([k, v]) => `${k}=${serializePythonStyleJson(v)}`,
    );
    rendered = parts.join(', ');
  } catch {
    rendered = safeJson(args);
  }
  return truncate(rendered, maxChars);
}

function renderResponse(
  response: Record<string, unknown> | undefined | null,
  maxChars: number,
): string {
  if (response === undefined || response === null) {
    return 'null';
  }
  return truncate(safeJson(response), maxChars);
}

function describeMediaPart(part: Part, reason: string): string {
  if (part.fileData !== undefined) {
    const uri = part.fileData.fileUri || part.fileData.mimeType || 'file';
    return `[file ${reason}: ${uri}]`;
  }
  const mime = part.inlineData?.mimeType || 'unknown';
  return `[media ${reason}: ${mime}]`;
}

function convertPart(
  part: Part,
  options: {
    author: string;
    config: ModelConsultContextConfig;
    skipFunctionCallIds: ReadonlySet<string>;
  },
): Part | undefined {
  const {author, config, skipFunctionCallIds} = options;
  if (part.thought && !config.includeThoughts) {
    return undefined;
  }

  const functionCall = part.functionCall;
  if (functionCall !== undefined) {
    if (functionCall.id && skipFunctionCallIds.has(functionCall.id)) {
      return undefined;
    }
    const name = functionCall.name || 'unknown_tool';
    const argsStr = renderArgs(
      functionCall.args as Record<string, unknown> | undefined,
      config.maxPartChars,
    );
    return {
      text: `[tool_call] ${name}(${argsStr})`,
    };
  }

  const functionResponse = part.functionResponse;
  if (functionResponse !== undefined) {
    if (functionResponse.id && skipFunctionCallIds.has(functionResponse.id)) {
      return undefined;
    }
    const name = functionResponse.name || 'unknown_tool';
    const respStr = renderResponse(
      functionResponse.response as Record<string, unknown> | undefined,
      config.maxPartChars,
    );
    return {
      text: `[tool_result] ${name} -> ${respStr}`,
    };
  }

  if (part.text !== undefined) {
    const text = truncate(part.text, config.maxPartChars * 8);
    if (!text.trim()) {
      return undefined;
    }
    if (part.thought) {
      return {text: `[thought] ${text}`};
    }
    const resolvedSpeaker =
      author === 'user' ? 'user' : author ? `agent:${author}` : 'agent';
    return {text: `[${resolvedSpeaker}] ${text}`};
  }

  if (part.inlineData !== undefined || part.fileData !== undefined) {
    if (config.includeMedia) {
      return part;
    }
    return {text: describeMediaPart(part, 'omitted')};
  }

  if (part.executableCode !== undefined) {
    const code = truncate(part.executableCode.code || '', config.maxPartChars);
    return {text: `[code]\n${code}`};
  }

  if (part.codeExecutionResult !== undefined) {
    const output = truncate(
      part.codeExecutionResult.output || '',
      config.maxPartChars,
    );
    return {text: `[code_result] ${output}`};
  }

  return undefined;
}

function contentCharLen(content: Content): number {
  let total = 0;
  for (const part of content.parts ?? []) {
    if (part.text) {
      total += part.text.length;
    } else {
      total += 256;
    }
  }
  return total;
}

/**
 * Returns a copy of `content` trimmed to at most `budget` characters.
 *
 * Used as a last-resort safeguard so the most recent turn is still delivered
 * (truncated) rather than dropped altogether when a single turn exceeds the
 * remaining context budget.
 */
function truncateContent(content: Content, budget: number): Content {
  let remaining = Math.max(budget, 64);
  const trimmedParts: Part[] = [];
  for (const part of content.parts ?? []) {
    if (part.text) {
      if (part.text.length <= remaining) {
        trimmedParts.push(part);
        remaining -= part.text.length;
      } else {
        trimmedParts.push({
          text: truncate(part.text, Math.max(remaining, 32)),
        });
        break;
      }
    } else if (remaining >= 256) {
      trimmedParts.push(part);
      remaining -= 256;
    } else {
      const placeholder = describeMediaPart(part, 'omitted for budget');
      if (placeholder.length <= remaining) {
        trimmedParts.push({text: placeholder});
        remaining -= placeholder.length;
      } else {
        trimmedParts.push({
          text: truncate(placeholder, Math.max(remaining, 16)),
        });
        break;
      }
    }
  }
  return {role: content.role, parts: trimmedParts};
}

/**
 * Keeps the opening and most recent contents within `maxChars`.
 *
 * Preserves up to `1 / HEAD_BUDGET_FRACTION` of the budget for the earliest
 * session turns (so the original user goal and constraints remain visible) and
 * fills the rest of the budget from the newest turns backward, inserting an
 * explicit omission marker for any middle turns that were dropped. The newest
 * turn is always kept (trimmed if necessary) so the immediate lead-up to the
 * consult is never lost.
 */
function applyCharBudget(contents: Content[], maxChars: number): Content[] {
  const sizes = contents.map((c) => contentCharLen(c));
  const total = sizes.reduce((acc, s) => acc + s, 0);
  if (total <= maxChars) {
    return contents;
  }

  // Reserve a slice of the budget for the opening turns of the session, but
  // always leave enough room for the most recent turn.
  const headBudget = Math.floor(maxChars / HEAD_BUDGET_FRACTION);
  const headIndices: number[] = [];
  let headUsed = 0;
  for (let idx = 0; idx < sizes.length - 1; idx++) {
    const size = sizes[idx];
    if (headUsed + size > headBudget) {
      break;
    }
    headIndices.push(idx);
    headUsed += size;
  }

  const tailFloor =
    headIndices.length > 0 ? headIndices[headIndices.length - 1] + 1 : 0;
  // Reserve space for the omission marker that will sit between head and tail
  // whenever middle turns are dropped.
  const markerReserve = 80;
  const tailBudget = Math.max(maxChars - headUsed - markerReserve, 0);

  const tailIndices: number[] = [];
  let tailUsed = 0;
  for (let idx = sizes.length - 1; idx >= tailFloor; idx--) {
    const size = sizes[idx];
    if (tailUsed + size > tailBudget && tailIndices.length > 0) {
      break;
    }
    tailIndices.push(idx);
    tailUsed += size;
    if (tailUsed >= tailBudget) {
      break;
    }
  }
  tailIndices.reverse();

  let dropped =
    tailIndices.length > 0
      ? tailIndices[0] - tailFloor
      : sizes.length - tailFloor;

  // If the newest turn alone exceeded the remaining tail budget, reclaim head
  // turns if needed and truncate the newest turn so it fits within `maxChars`.
  const newestIdx = sizes.length - 1;
  let trimmedNewest: Content | undefined;
  if (
    tailIndices.length === 1 &&
    tailIndices[0] === newestIdx &&
    headUsed + tailUsed > maxChars
  ) {
    while (
      headIndices.length > 0 &&
      headUsed + Math.min(tailUsed, maxChars) + markerReserve > maxChars
    ) {
      const removed = headIndices.pop()!;
      headUsed -= sizes[removed];
      dropped += 1;
    }
    const availableForNewest = Math.max(
      maxChars - headUsed - (dropped > 0 ? markerReserve : 0),
      64,
    );
    if (sizes[newestIdx] > availableForNewest) {
      trimmedNewest = truncateContent(contents[newestIdx], availableForNewest);
    }
  }

  const result: Content[] = headIndices.map((i) => contents[i]);
  if (dropped > 0) {
    const markerContent: Content = {
      role: 'user',
      parts: [
        {
          text: `[... ${dropped} earlier turn(s) omitted to fit the context budget ...]`,
        },
      ],
    };
    const newestContent =
      trimmedNewest !== undefined ? trimmedNewest : contents[newestIdx];
    // Only include the omission marker when the budget can hold both the marker
    // and the newest turn; under tiny budgets the newest turn wins.
    if (
      result.length > 0 ||
      contentCharLen(markerContent) + contentCharLen(newestContent) <= maxChars
    ) {
      result.push(markerContent);
    }
  }
  for (const i of tailIndices) {
    if (i === newestIdx && trimmedNewest !== undefined) {
      result.push(trimmedNewest);
    } else {
      result.push(contents[i]);
    }
  }
  return result;
}

export interface BuildAdvisorContentsOptions {
  config?: ModelConsultContextConfig | ModelConsultContextConfigOptions;
  skipFunctionCallIds?: Iterable<string>;
}

function isBuildAdvisorContentsOptions(
  value: unknown,
): value is BuildAdvisorContentsOptions {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (isModelConsultContextConfig(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.some((k) => k === 'config' || k === 'skipFunctionCallIds');
}

/**
 * Builds the advisor's conversation contents from session events.
 *
 * Skips partial streaming events, omits the in-flight `model_consult` function
 * call (so the question is not duplicated), and merges all kept parts into a
 * single `role='user'` `Content`.
 */
export function buildAdvisorContents(
  events: readonly Event[],
  configOrOptions?:
    | ModelConsultContextConfig
    | ModelConsultContextConfigOptions
    | BuildAdvisorContentsOptions,
  skipFunctionCallIdsArg?: Iterable<string>,
): Content[] {
  let rawConfig:
    ModelConsultContextConfig | ModelConsultContextConfigOptions | undefined;
  let rawSkipIds: Iterable<string> | undefined = skipFunctionCallIdsArg;

  if (isBuildAdvisorContentsOptions(configOrOptions)) {
    rawConfig = configOrOptions.config;
    rawSkipIds = rawSkipIds ?? configOrOptions.skipFunctionCallIds;
  } else {
    rawConfig = configOrOptions;
  }

  const config = isModelConsultContextConfig(rawConfig)
    ? rawConfig
    : new ModelConsultContextConfig(rawConfig);

  if (!config.includeSession) {
    return [];
  }

  const skipIds = new Set<string>(rawSkipIds ?? []);

  let kept = events.filter((e) => !e.partial);
  if (config.maxEvents !== undefined && kept.length > config.maxEvents) {
    kept = kept.slice(-config.maxEvents);
  }

  const contents: Content[] = [];
  for (const event of kept) {
    if (
      !event.content ||
      !event.content.parts ||
      event.content.parts.length === 0
    ) {
      continue;
    }
    const author = event.author || 'agent';
    const convertedParts: Part[] = [];
    for (const part of event.content.parts) {
      const converted = convertPart(part, {
        author,
        config,
        skipFunctionCallIds: skipIds,
      });
      if (converted !== undefined) {
        convertedParts.push(converted);
      }
    }
    if (convertedParts.length > 0) {
      contents.push({role: 'user', parts: convertedParts});
    }
  }

  const budgeted = applyCharBudget(contents, config.maxChars);
  const mergedParts: Part[] = [];
  for (const content of budgeted) {
    if (content.parts) {
      mergedParts.push(...content.parts);
    }
  }
  if (mergedParts.length === 0) {
    return [];
  }
  return [{role: 'user', parts: mergedParts}];
}
