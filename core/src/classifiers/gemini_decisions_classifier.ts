/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions, Part, PartMediaResolutionLevel} from '@google/genai';
import {mergeTrackingHeaders} from '../utils/client_labels.js';
import {isBrowser} from '../utils/env_aware_utils.js';
import {experimental} from '../utils/experimental.js';
import {BaseClassifier} from './base_classifier.js';
import {
  Answer,
  ClassifierInput,
  ClassifierRequest,
  ClassifierResponse,
  createBinaryAnswer,
  createChoiceAnswer,
  createClassifierResponse,
  createRefusalAnswer,
  createScoreAnswer,
  isClassifierContentInput,
  isPlainJsonObject,
  Question,
  renderJSONContent,
  setOwnProperty,
  validateClassifierInput,
  validateQuestion,
} from './types.js';

const GEMINI_DECISIONS_CLASSIFIER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.classifiers.geminiDecisionsClassifier',
);

/**
 * Default model used by {@link GeminiDecisionsClassifier} when no model is
 * specified.
 */
export const DEFAULT_GEMINI_DECISIONS_MODEL = 'gemini-decision-1';

/**
 * Default per-request timeout in milliseconds for
 * {@link GeminiDecisionsClassifier}.
 */
export const DEFAULT_GEMINI_DECISIONS_TIMEOUT_MS = 30_000;

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_API_VERSION = 'v1beta';
const MAX_QUESTIONS = 1000;
const MAX_OPTIONS = 255;
const MAX_OPTION_KEY_CHARS = 128;
const MAX_OPTION_KEY_BYTES = 512;
const QUESTION_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
// Option keys allow internal ASCII spaces (0x20), disallow leading/trailing
// spaces, control characters (0x00-0x1F, 0x7F-0x9F), and non-ASCII spaces.
const INVALID_OPTION_KEY_CHAR_REGEX =
  // eslint-disable-next-line no-control-regex -- intentionally rejects ASCII and C1 control characters per Decisions API limits
  /[\u0000-\u001F\u007F-\u009F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
const CLAMP_TOLERANCE = 1e-6;

const BLOCKED_CODES = new Set([
  'safety',
  'prohibited_content',
  'blocklist',
  'image_safety',
  'content_blocked',
]);

const MEDIA_RESOLUTIONS: Partial<Record<PartMediaResolutionLevel, string>> = {
  [PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW]: 'low',
  [PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM]: 'medium',
  [PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH]: 'high',
  [PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH]: 'ultra_high',
};

const UTF8_ENCODER = new TextEncoder();

/**
 * Content block sent in the `input` array of a Gemini Decisions API request.
 */
export interface GeminiDecisionInputBlock {
  /** Block media type. */
  readonly type: 'text' | 'image' | 'audio' | 'video' | 'document';
  /** Plain text for a `'text'` block. */
  readonly text?: string;
  /** Base64-encoded inline media bytes. */
  readonly data?: string;
  /** Files API URI or HTTPS media URL. */
  readonly uri?: string;
  /** IANA MIME type of the media block. */
  readonly mime_type?: string;
  /** Media resolution level (`'low'`, `'medium'`, `'high'`, or `'ultra_high'`). */
  readonly resolution?: string;
}

/**
 * Question definition sent in the `questions` map of a Gemini Decisions API
 * request.
 */
export interface GeminiDecisionWireQuestion {
  /** Wire question type (`'noul'`, `'choice'`, or `'score'`). */
  readonly type: 'noul' | 'choice' | 'score';
  /** Question instructions evaluated against the shared input. */
  readonly instructions: string;
  /** Criteria describing the possible outcomes for the question. */
  readonly criteria?:
    | {readonly true_description: string}
    | Readonly<Record<string, string>>
    | readonly string[];
}

/**
 * Request body sent to the Gemini Decisions API.
 */
export interface GeminiDecisionCreateParams {
  /** Decisions model ID, such as `'gemini-decision-1'`. */
  readonly model: string;
  /** Shared context evaluated across all questions. */
  readonly input: string | readonly GeminiDecisionInputBlock[];
  /** Map of question keys to their wire definitions. */
  readonly questions: Readonly<Record<string, GeminiDecisionWireQuestion>>;
}

/**
 * Request options passed to `decisions.create`.
 */
export interface GeminiDecisionRequestOptions {
  /** HTTP headers sent with the request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-request timeout in milliseconds. */
  readonly timeout?: number;
  /** Cancellation signal for the request. */
  readonly signal?: AbortSignal;
}

/**
 * Response body returned by the Gemini Decisions API.
 */
export interface GeminiDecisionCreateResponse {
  /** Model version that produced the decision response, when reported. */
  readonly model?: string;
  /** Snake-case model version field, when reported. */
  readonly model_version?: string;
  /** Camel-case model version field, when reported. */
  readonly modelVersion?: string;
  /** Map of question keys to their raw answers. */
  readonly answers?: Readonly<Record<string, unknown>>;
  /** Input safety feedback when the request was blocked. */
  readonly prompt_feedback?: {readonly block_reason?: string};
}

/**
 * Structural client interface compatible with `@google/genai` clients exposing
 * `decisions.create`.
 */
export interface GeminiDecisionsClientLike {
  /** The Decisions API resource. */
  readonly decisions: {
    /** Evaluates a batch of structured decision questions against shared input. */
    create(
      params: GeminiDecisionCreateParams,
      options?: GeminiDecisionRequestOptions,
    ): Promise<GeminiDecisionCreateResponse>;
  };
}

/**
 * Configuration for constructing a {@link GeminiDecisionsClassifier}.
 */
export interface GeminiDecisionsClassifierConfig {
  /** The Decisions model name. Defaults to `'gemini-decision-1'`. */
  readonly model?: string;
  /**
   * A configured client exposing `decisions.create`. When omitted, the
   * classifier calls the Gemini Developer API Decisions endpoint directly.
   */
  readonly client?: {
    readonly decisions: {
      create(
        params: {
          readonly model: string;
          readonly input: unknown;
          readonly questions: Readonly<Record<string, unknown>>;
        },
        options?: {
          readonly headers?: Readonly<Record<string, string>>;
          readonly timeout?: number;
          readonly signal?: AbortSignal;
        },
      ): Promise<{
        readonly model?: string;
        readonly model_version?: string;
        readonly modelVersion?: string;
        readonly answers?: Readonly<Record<string, unknown>>;
        readonly prompt_feedback?: {readonly block_reason?: string};
      }>;
    };
  };
  /**
   * API key for the Gemini Developer API. Defaults to `GOOGLE_GENAI_API_KEY`,
   * `GOOGLE_API_KEY`, or `GEMINI_API_KEY`.
   */
  readonly apiKey?: string;
  /**
   * Base URL for the Gemini Developer API. Defaults to
   * `'https://generativelanguage.googleapis.com'`.
   */
  readonly baseUrl?: string;
  /**
   * API version for the Gemini Developer API. Defaults to `'v1beta'`.
   */
  readonly apiVersion?: string;
  /**
   * Request timeout in milliseconds. Defaults to `30000` (30 seconds).
   */
  readonly timeout?: number;
  /** Additional HTTP options (custom headers, baseUrl, apiVersion, timeout, or fetch). */
  readonly httpOptions?: HttpOptions;
}

/**
 * Type guard to check if an object is an instance of
 * {@link GeminiDecisionsClassifier}.
 */
export function isGeminiDecisionsClassifier(
  obj: unknown,
): obj is GeminiDecisionsClassifier {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GEMINI_DECISIONS_CLASSIFIER_SIGNATURE_SYMBOL in obj &&
    obj[GEMINI_DECISIONS_CLASSIFIER_SIGNATURE_SYMBOL] === true
  );
}

function hasDecisionsResource(
  client: unknown,
): client is GeminiDecisionsClientLike {
  if (
    typeof client !== 'object' ||
    client === null ||
    !('decisions' in client)
  ) {
    return false;
  }
  const decisions = client.decisions;
  return (
    typeof decisions === 'object' &&
    decisions !== null &&
    'create' in decisions &&
    typeof decisions.create === 'function'
  );
}

function resolveMediaType(
  mimeType: string | undefined,
): 'image' | 'audio' | 'video' | 'document' {
  if (!mimeType || mimeType === 'application/octet-stream') {
    throw new Error(
      'GeminiDecisionsClassifier requires an explicit media MIME type.',
    );
  }
  if (mimeType === 'application/pdf') {
    return 'document';
  }
  const [prefix] = mimeType.split('/');
  switch (prefix) {
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    default:
      throw new Error(
        `GeminiDecisionsClassifier accepts image, audio, video, and PDF parts; got MIME type '${mimeType}'.`,
      );
  }
}

function partToWireBlock(part: Part): GeminiDecisionInputBlock {
  if (part.thought) {
    throw new Error(
      'GeminiDecisionsClassifier does not accept thought parts in input.',
    );
  }
  if (
    part.functionCall !== undefined ||
    part.functionResponse !== undefined ||
    part.executableCode !== undefined ||
    part.codeExecutionResult !== undefined
  ) {
    throw new Error(
      'GeminiDecisionsClassifier accepts text, inline data, and file parts only; the input has another kind of part.',
    );
  }
  if (part.text !== undefined && part.text !== null) {
    return {type: 'text', text: part.text};
  }
  const level = part.mediaResolution?.level;
  const resolution =
    level !== undefined && Object.hasOwn(MEDIA_RESOLUTIONS, level)
      ? MEDIA_RESOLUTIONS[level]
      : undefined;

  if (part.inlineData?.data !== undefined && part.inlineData?.data !== null) {
    const type = resolveMediaType(part.inlineData.mimeType);
    return {
      type,
      data: part.inlineData.data,
      mime_type: part.inlineData.mimeType,
      ...(resolution && (type === 'image' || type === 'video')
        ? {resolution}
        : {}),
    };
  }
  if (part.fileData?.fileUri !== undefined && part.fileData?.fileUri !== null) {
    const type = resolveMediaType(part.fileData.mimeType);
    return {
      type,
      uri: part.fileData.fileUri,
      mime_type: part.fileData.mimeType,
      ...(resolution && (type === 'image' || type === 'video')
        ? {resolution}
        : {}),
    };
  }
  throw new Error(
    'GeminiDecisionsClassifier accepts text, inline data, and file parts only; the input has another kind of part.',
  );
}

function inputToWire(
  input: ClassifierInput,
): string | GeminiDecisionInputBlock[] {
  const validated = validateClassifierInput(input);
  if (!isClassifierContentInput(validated)) {
    const rendered = renderJSONContent(validated);
    if (rendered.length === 0) {
      throw new Error('GeminiDecisionsClassifier received empty input.');
    }
    return rendered;
  }
  const parts = validated.parts ?? [];
  if (parts.length === 0) {
    throw new Error('GeminiDecisionsClassifier received empty input.');
  }
  return parts.map(partToWireBlock);
}

function validateOptionKey(questionName: string, label: string): void {
  if (
    label.length === 0 ||
    label.length > MAX_OPTION_KEY_CHARS ||
    UTF8_ENCODER.encode(label).byteLength > MAX_OPTION_KEY_BYTES ||
    label.startsWith(' ') ||
    label.endsWith(' ') ||
    INVALID_OPTION_KEY_CHAR_REGEX.test(label)
  ) {
    throw new Error(
      `Gemini option keys in question ${JSON.stringify(questionName)} must be 1 to ${MAX_OPTION_KEY_CHARS} characters without leading/trailing spaces or control characters.`,
    );
  }
}

function questionToWire(
  name: string,
  question: Question,
): GeminiDecisionWireQuestion {
  if (!QUESTION_NAME_REGEX.test(name)) {
    throw new Error(
      `Gemini needs question names of 1 to 64 letters, digits, "_" or "-"; got ${JSON.stringify(name)}.`,
    );
  }
  const validated = validateQuestion(question);
  if (validated.type !== 'binary') {
    const count =
      validated.type === 'choice'
        ? Object.keys(validated.criteria).length
        : validated.criteria.length;
    if (count > MAX_OPTIONS) {
      throw new Error(
        `Gemini accepts at most ${MAX_OPTIONS} options in a question; question ${JSON.stringify(name)} has ${count}.`,
      );
    }
  }
  if (validated.instructions === undefined) {
    throw new Error(
      `GeminiDecisionsClassifier needs instructions for question ${JSON.stringify(name)}.`,
    );
  }
  const instructions = renderJSONContent(validated.instructions);
  if (instructions.length === 0) {
    throw new Error(
      `GeminiDecisionsClassifier needs non-empty instructions for question ${JSON.stringify(name)}.`,
    );
  }

  switch (validated.type) {
    case 'choice': {
      const criteria: Record<string, string> = {};
      for (const [label, description] of Object.entries(validated.criteria)) {
        validateOptionKey(name, label);
        setOwnProperty(
          criteria,
          label,
          description === null || description === undefined
            ? ''
            : renderJSONContent(description),
        );
      }
      return {
        type: 'choice',
        instructions,
        criteria,
      };
    }
    case 'binary':
      return {
        type: 'noul',
        instructions,
        ...(validated.criteria !== undefined
          ? {
              criteria: {
                true_description: renderJSONContent(validated.criteria),
              },
            }
          : {}),
      };
    case 'score': {
      const criteria = validated.criteria.map((level) => {
        const rendered = renderJSONContent(level);
        if (rendered.length === 0) {
          throw new Error(
            `Gemini score levels in question ${JSON.stringify(name)} must be non-empty.`,
          );
        }
        return rendered;
      });
      return {
        type: 'score',
        instructions,
        criteria,
      };
    }
    default: {
      const exhaustive: never = validated;
      throw new Error(`Unknown question: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function readClampedNumber(
  name: string,
  key: string,
  value: unknown,
  high = 1.0,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Gemini returned a non-number for '${key}' in question '${name}'.`,
    );
  }
  if (value < -CLAMP_TOLERANCE || value > high + CLAMP_TOLERANCE) {
    throw new Error(
      `Gemini returned a value for '${key}' in question '${name}' outside [0, ${high}].`,
    );
  }
  return Math.min(Math.max(value, 0), high) + 0;
}

function readProbabilities(
  name: string,
  expectedType: string,
  raw: Record<string, unknown>,
  expectedKeys: readonly string[],
): Record<string, number> {
  const probabilities = raw['probabilities'];
  if (!isPlainJsonObject(probabilities)) {
    throw new Error(
      `Gemini returned a malformed '${expectedType}' answer to '${name}', whose probabilities are not an object.`,
    );
  }
  const actualKeys = Object.keys(probabilities);
  const expectedSet = new Set(expectedKeys);
  if (
    actualKeys.length !== expectedSet.size ||
    actualKeys.some((key) => !expectedSet.has(key))
  ) {
    throw new Error(
      `Gemini returned probabilities for ${actualKeys.length} options in '${name}', expected ${JSON.stringify(expectedKeys)}.`,
    );
  }
  const result: Record<string, number> = {};
  for (const key of expectedKeys) {
    setOwnProperty(
      result,
      key,
      readClampedNumber(name, key, probabilities[key]),
    );
  }
  return result;
}

function parseDecisionAnswer(
  name: string,
  question: Question,
  raw: unknown,
): Answer {
  if (!isPlainJsonObject(raw)) {
    throw new Error(`Gemini returned no answer to '${name}'.`);
  }
  const expected = question.type === 'binary' ? 'noul' : question.type;
  if (raw['type'] !== expected) {
    throw new Error(
      `Gemini returned an unexpected answer type for '${name}', which is a '${expected}' question.`,
    );
  }
  const required =
    expected === 'noul' ? [expected] : [expected, 'probabilities'];
  const missing = required.filter(
    (key) => raw[key] === undefined || raw[key] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `Gemini returned a malformed '${expected}' answer to '${name}', missing ${JSON.stringify(missing)}.`,
    );
  }

  const confidence =
    raw['confidence'] !== undefined && raw['confidence'] !== null
      ? readClampedNumber(name, 'confidence', raw['confidence'])
      : undefined;

  if (question.type === 'binary') {
    return createBinaryAnswer({
      probability: readClampedNumber(name, 'noul', raw['noul']),
      confidence,
    });
  }
  if (question.type === 'choice') {
    const choice = raw['choice'];
    if (
      typeof choice !== 'string' ||
      !Object.hasOwn(question.criteria, choice)
    ) {
      throw new Error(
        `Gemini chose a label for '${name}' that is not one of its declared labels.`,
      );
    }
    return createChoiceAnswer({
      choice,
      probabilities: readProbabilities(
        name,
        expected,
        raw,
        Object.keys(question.criteria),
      ),
      confidence,
    });
  }

  const top = question.criteria.length - 1;
  const levelKeys = Array.from({length: top + 1}, (_, level) => String(level));
  const rawProbs = readProbabilities(name, expected, raw, levelKeys);
  const probabilities: Record<number, number> = {};
  for (let level = 0; level <= top; level++) {
    probabilities[level] = rawProbs[String(level)];
  }
  return createScoreAnswer({
    score: readClampedNumber(name, 'score', raw['score'], top),
    probabilities,
    confidence,
  });
}

function parseErrorObjectCandidate(
  candidate: unknown,
): Record<string, unknown> | undefined {
  if (isPlainJsonObject(candidate)) {
    return candidate;
  }
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const braceIndex = candidate.indexOf('{');
  const jsonSlice = braceIndex >= 0 ? candidate.slice(braceIndex) : candidate;
  try {
    const parsed: unknown = JSON.parse(jsonSlice);
    return isPlainJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isBlockedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  const status = record['status'] ?? record['statusCode'];
  if (status !== undefined && status !== 400) {
    return false;
  }

  const candidates: unknown[] = [
    record['body'],
    record['error'],
    record['message'],
  ];
  for (const candidate of candidates) {
    const parsed = parseErrorObjectCandidate(candidate);
    if (!parsed) {
      continue;
    }
    const details = isPlainJsonObject(parsed['error'])
      ? parsed['error']
      : parsed;
    const code = details['code'];
    if (typeof code === 'string' && BLOCKED_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

function createRefusalResponse(
  questions: Readonly<Record<string, Question>>,
): ClassifierResponse {
  const answers: Record<string, Answer> = {};
  for (const name of Object.keys(questions)) {
    setOwnProperty(answers, name, createRefusalAnswer());
  }
  return createClassifierResponse({answers});
}

function resolveApiKey(configuredKey?: string): string | undefined {
  if (configuredKey) {
    return configuredKey;
  }
  if (isBrowser()) {
    return undefined;
  }
  return (
    process.env['GOOGLE_GENAI_API_KEY'] ||
    process.env['GOOGLE_API_KEY'] ||
    process.env['GEMINI_API_KEY']
  );
}

/**
 * Creates a per-request `AbortSignal` combining `timeoutMs` and an optional
 * caller `abortSignal`, returning a cleanup callback that clears the timer and
 * listener.
 */
function createRequestSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): {signal: AbortSignal; dispose: () => void} {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort, {once: true});
  }
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Gemini Decisions request timed out after ${timeoutMs}ms.`),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Answers typed questions with the Gemini Decisions API (`gemini-decision-1`).
 *
 * The Decisions API evaluates every question about an input in one forward pass
 * and returns calibrated probabilities and confidence scores with zero output
 * tokens. `Binary` questions are sent as `noul` questions, and every question
 * requires `instructions`. Input can be text, JSON, or a `Content` with text,
 * image, audio, video, or PDF document parts. When Gemini safety filters block
 * the input, every question receives a {@link RefusalAnswer}.
 */
@experimental
export class GeminiDecisionsClassifier extends BaseClassifier {
  readonly [GEMINI_DECISIONS_CLASSIFIER_SIGNATURE_SYMBOL] = true;

  protected override readonly clientLabelKind = 'gemini';

  /** Per-request timeout in milliseconds. */
  readonly timeout: number;

  private readonly configuredClient?: GeminiDecisionsClientLike;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly httpOptions?: HttpOptions;

  constructor(config: GeminiDecisionsClassifierConfig = {}) {
    const model = config.model ?? DEFAULT_GEMINI_DECISIONS_MODEL;
    super({model});
    const timeout =
      config.timeout ??
      config.httpOptions?.timeout ??
      DEFAULT_GEMINI_DECISIONS_TIMEOUT_MS;
    if (
      typeof timeout !== 'number' ||
      !Number.isFinite(timeout) ||
      timeout <= 0
    ) {
      throw new Error(
        'GeminiDecisionsClassifier timeout must be a positive finite number.',
      );
    }
    if (config.client !== undefined && !hasDecisionsResource(config.client)) {
      throw new Error(
        'GeminiDecisionsClassifier client must expose a decisions.create(params, options) method.',
      );
    }
    this.timeout = timeout;
    this.configuredClient = config.client;
    this.apiKey = config.apiKey;
    const rawBaseUrl =
      config.baseUrl ?? config.httpOptions?.baseUrl ?? DEFAULT_BASE_URL;
    this.baseUrl = rawBaseUrl.replace(/\/+$/, '');
    const rawApiVersion =
      config.apiVersion ??
      config.httpOptions?.apiVersion ??
      DEFAULT_API_VERSION;
    this.apiVersion = rawApiVersion.replace(/^\/+|\/+$/g, '');
    this.httpOptions = config.httpOptions;
  }

  private async sendDecisionRequest(
    wireRequest: GeminiDecisionCreateParams,
    abortSignal?: AbortSignal,
  ): Promise<GeminiDecisionCreateResponse> {
    abortSignal?.throwIfAborted();
    const headers = mergeTrackingHeaders(this.httpOptions?.headers);

    if (
      this.configuredClient !== undefined &&
      hasDecisionsResource(this.configuredClient)
    ) {
      return this.configuredClient.decisions.create(wireRequest, {
        headers,
        timeout: this.timeout,
        signal: abortSignal,
      });
    }

    const apiKey = resolveApiKey(this.apiKey);
    if (!apiKey) {
      throw new Error(
        'GeminiDecisionsClassifier requires an API key via apiKey, GOOGLE_GENAI_API_KEY, GOOGLE_API_KEY, or GEMINI_API_KEY.',
      );
    }

    const endpoint = this.apiVersion
      ? `${this.baseUrl}/${this.apiVersion}/decisions`
      : `${this.baseUrl}/decisions`;
    const fetchFn = this.httpOptions?.fetch ?? globalThis.fetch;
    const {signal, dispose} = createRequestSignal(this.timeout, abortSignal);
    let response: Response;
    let responseText: string;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(wireRequest),
        signal,
      });
      responseText = await response.text();
    } finally {
      dispose();
    }

    if (!response.ok) {
      let parsedError: unknown;
      try {
        parsedError = JSON.parse(responseText);
      } catch {
        parsedError = undefined;
      }
      const error = new Error(
        `Gemini Decisions request failed with HTTP ${response.status}.`,
      );
      Object.assign(error, {
        status: response.status,
        body: parsedError ?? responseText,
      });
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new Error('Gemini did not return valid JSON.');
    }
    if (!isPlainJsonObject(parsed)) {
      throw new Error('Gemini did not return a JSON object.');
    }
    return parsed as GeminiDecisionCreateResponse;
  }

  protected override async classifyImpl({
    input,
    questions,
    abortSignal,
  }: ClassifierRequest): Promise<ClassifierResponse> {
    if (!isPlainJsonObject(questions)) {
      throw new Error('classify() requires a questions object.');
    }
    const questionEntries = Object.entries(questions);
    if (questionEntries.length === 0) {
      throw new Error('classify() requires at least one question.');
    }
    if (questionEntries.length > MAX_QUESTIONS) {
      throw new Error(
        `Gemini accepts at most ${MAX_QUESTIONS} questions in one call; got ${questionEntries.length}.`,
      );
    }

    const validatedQuestions: Record<string, Question> = {};
    const wireQuestions: Record<string, GeminiDecisionWireQuestion> = {};
    for (const [name, question] of questionEntries) {
      const validated = validateQuestion(question);
      setOwnProperty(validatedQuestions, name, validated);
      setOwnProperty(wireQuestions, name, questionToWire(name, validated));
    }
    const wireInput = inputToWire(input);

    let responseData: GeminiDecisionCreateResponse;
    try {
      responseData = await this.sendDecisionRequest(
        {
          model: this.name,
          input: wireInput,
          questions: wireQuestions,
        },
        abortSignal,
      );
    } catch (error: unknown) {
      if (isBlockedError(error)) {
        return createRefusalResponse(validatedQuestions);
      }
      throw error;
    }

    const responseRecord: unknown = responseData;
    if (!isPlainJsonObject(responseRecord)) {
      throw new Error('Gemini did not return a JSON object.');
    }
    if (responseData.prompt_feedback?.block_reason) {
      return createRefusalResponse(validatedQuestions);
    }

    const rawAnswers = responseData.answers;
    if (!isPlainJsonObject(rawAnswers)) {
      throw new Error('Gemini returned no answers.');
    }

    const answers: Record<string, Answer> = {};
    for (const [name, question] of Object.entries(validatedQuestions)) {
      const raw = Object.hasOwn(rawAnswers, name)
        ? rawAnswers[name]
        : undefined;
      setOwnProperty(answers, name, parseDecisionAnswer(name, question, raw));
    }

    const modelVersion =
      typeof responseData.modelVersion === 'string'
        ? responseData.modelVersion
        : typeof responseData.model_version === 'string'
          ? responseData.model_version
          : typeof responseData.model === 'string'
            ? responseData.model
            : undefined;

    return createClassifierResponse({modelVersion, answers});
  }
}
