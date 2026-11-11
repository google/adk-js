/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content} from '@google/genai';

/**
 * Maximum nesting depth allowed for {@link JSONContent}, matching the limit in
 * the Python, Kotlin, and Java ADK classifier implementations.
 */
export const MAX_JSON_CONTENT_DEPTH = 200;

const PART_KEYS = new Set([
  'text',
  'inlineData',
  'fileData',
  'functionCall',
  'functionResponse',
  'executableCode',
  'codeExecutionResult',
  'videoMetadata',
  'thought',
  'thoughtSignature',
  'partMetadata',
  'mediaResolution',
  'mediaProcessing',
  'speechMetadata',
  'toolCall',
  'toolResponse',
  'audioTranscription',
]);

const UNAMBIGUOUS_PART_KEYS = new Set([
  'inlineData',
  'fileData',
  'functionCall',
  'functionResponse',
  'executableCode',
  'codeExecutionResult',
  'videoMetadata',
  'thought',
  'thoughtSignature',
  'partMetadata',
  'mediaResolution',
  'mediaProcessing',
  'speechMetadata',
  'toolCall',
  'toolResponse',
  'audioTranscription',
]);

const QUESTION_ALLOWED_KEYS = new Set(['type', 'instructions', 'criteria']);
const CHOICE_ANSWER_ALLOWED_KEYS = new Set([
  'type',
  'choice',
  'probabilities',
  'confidence',
]);
const BINARY_ANSWER_ALLOWED_KEYS = new Set([
  'type',
  'probability',
  'confidence',
]);
const SCORE_ANSWER_ALLOWED_KEYS = new Set([
  'type',
  'score',
  'probabilities',
  'confidence',
]);
const REFUSAL_ANSWER_ALLOWED_KEYS = new Set(['type']);
const RESPONSE_WIRE_ALLOWED_KEYS = new Set(['answers', 'model_version']);
const NON_NEGATIVE_INTEGER_KEY_REGEX = /^(0|[1-9]\d*)$/;

/** A JSON-serializable value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | {readonly [key: string]: JsonValue}
  | readonly JsonValue[];

/**
 * Text, or a JSON-serializable plain object or array.
 */
export type JSONContent =
  string | {readonly [key: string]: JsonValue} | readonly JsonValue[];

/**
 * The input a classifier answers questions about: text, JSON, or a multimodal
 * `Content` object.
 */
export type ClassifierInput = JSONContent | Content;

/**
 * Asks a classifier to pick one of two or more named labels.
 */
export interface Choice {
  /** Discriminator identifying a choice question. */
  readonly type: 'choice';
  /** What to decide, for example `"Which department should handle this?"`. */
  readonly instructions?: JSONContent;
  /**
   * Maps each label (at least two) to an optional description of when it applies.
   *
   * Note that JavaScript objects iterate non-negative integer-index keys
   * (`"0"`, `"1"`, ...) in ascending numeric order before other string keys in
   * insertion order.
   */
  readonly criteria: Readonly<Record<string, JSONContent | null | undefined>>;
}

/** Parameters for {@link createChoice}. */
export interface CreateChoiceParams {
  /** What to decide, for example `"Which department should handle this?"`. */
  readonly instructions?: JSONContent;
  /** Maps each label (at least two) to an optional description of when it applies. */
  readonly criteria: Readonly<Record<string, JSONContent | null | undefined>>;
}

/**
 * Asks a classifier for the calibrated probability that a statement is true.
 */
export interface Binary {
  /** Discriminator identifying a binary question. */
  readonly type: 'binary';
  /** The yes/no question, for example `"Does this action delete user data?"`. */
  readonly instructions?: JSONContent;
  /** Optional description of what counts as true; anything else counts as false. */
  readonly criteria?: JSONContent;
}

/** Parameters for {@link createBinary}. */
export interface CreateBinaryParams {
  /** The yes/no question, for example `"Does this action delete user data?"`. */
  readonly instructions?: JSONContent;
  /** Optional description of what counts as true; anything else counts as false. */
  readonly criteria?: JSONContent;
}

/**
 * Asks a classifier to place an input on an ordered rubric starting at level 0.
 */
export interface Score {
  /** Discriminator identifying a score question. */
  readonly type: 'score';
  /** What to rate, for example `"How urgent is this ticket?"`. */
  readonly instructions?: JSONContent;
  /** One description per rubric level (at least two), starting at level 0. */
  readonly criteria: readonly JSONContent[];
}

/** Parameters for {@link createScore}. */
export interface CreateScoreParams {
  /** What to rate, for example `"How urgent is this ticket?"`. */
  readonly instructions?: JSONContent;
  /** One description per rubric level (at least two), starting at level 0. */
  readonly criteria: readonly JSONContent[];
}

/**
 * A typed question answered by a classifier: {@link Choice}, {@link Binary},
 * or {@link Score}.
 */
export type Question = Choice | Binary | Score;

/**
 * The answer to a {@link Choice} question.
 */
export interface ChoiceAnswer {
  /** Discriminator identifying a choice answer. */
  readonly type: 'choice';
  /** The most likely label. */
  readonly choice: string;
  /** Maps each label in the question to its probability in `[0, 1]`. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The provider's confidence in `[0, 1]`, when reported. */
  readonly confidence?: number;
}

/** Parameters for {@link createChoiceAnswer}. */
export interface CreateChoiceAnswerParams {
  /** The most likely label. */
  readonly choice: string;
  /** Maps each label in the question to its probability in `[0, 1]`. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The provider's confidence in `[0, 1]`, when reported. */
  readonly confidence?: number;
}

/**
 * The answer to a {@link Binary} question.
 */
export interface BinaryAnswer {
  /** Discriminator identifying a binary answer. */
  readonly type: 'binary';
  /** The probability in `[0, 1]` that the statement is true. */
  readonly probability: number;
  /** The provider's confidence in `[0, 1]`, when reported. */
  readonly confidence?: number;
}

/** Parameters for {@link createBinaryAnswer}. */
export interface CreateBinaryAnswerParams {
  /** The probability in `[0, 1]` that the statement is true. */
  readonly probability: number;
  /** The provider's confidence in `[0, 1]`, when reported. */
  readonly confidence?: number;
}

/**
 * The answer to a {@link Score} question.
 */
export interface ScoreAnswer {
  /** Discriminator identifying a score answer. */
  readonly type: 'score';
  /** The expected rubric level, weighted by {@link probabilities}. */
  readonly score: number;
  /** Maps each 0-based rubric level to its probability in `[0, 1]`. */
  readonly probabilities: Readonly<Record<number, number>>;
  /** The provider's confidence in `[0, 1]`, when reported. */
  readonly confidence?: number;
}

/** Parameters for {@link createScoreAnswer}. */
export interface CreateScoreAnswerParams {
  /** The expected rubric level, weighted by {@link probabilities}. */
  readonly score: number;
  /** Maps each 0-based rubric level to its probability in `[0, 1]`. */
  readonly probabilities: Readonly<Record<number, number>>;
  /** The provider's confidence in `[0, 1]`, when reported. */
  readonly confidence?: number;
}

/**
 * Takes the place of an answer the model declined to give.
 */
export interface RefusalAnswer {
  /** Discriminator identifying a refusal answer. */
  readonly type: 'refusal';
}

/**
 * A classifier's answer to a {@link Question}: {@link ChoiceAnswer},
 * {@link BinaryAnswer}, {@link ScoreAnswer}, or {@link RefusalAnswer}.
 */
export type Answer = ChoiceAnswer | BinaryAnswer | ScoreAnswer | RefusalAnswer;

/**
 * A request to a classifier to answer one or more typed questions about an input.
 */
export interface ClassifierRequest {
  /** What the questions are about: text, JSON, or multimodal `Content`. */
  readonly input: ClassifierInput;
  /** Maps a caller-chosen name to each question; the response uses the same names. */
  readonly questions: Readonly<Record<string, Question>>;
  /** Optional cancellation signal for the request. */
  readonly abortSignal?: AbortSignal;
}

/**
 * The answers produced by one classifier `classify` call.
 */
export interface ClassifierResponse {
  /**
   * Maps each question name to its {@link Answer}, or to a
   * {@link RefusalAnswer} when the model declined to answer it.
   */
  readonly answers: Readonly<Record<string, Answer>>;
  /** The model version that produced the answers, when reported by the provider. */
  readonly modelVersion?: string;
}

/** Parameters for {@link createClassifierResponse}. */
export type CreateClassifierResponseParams = ClassifierResponse;

/**
 * Defines an own enumerable property on `target` without invoking
 * `Object.prototype.__proto__` when `key === '__proto__'`.
 */
export function setOwnProperty<T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Returns whether `value` is a plain JSON object (prototype is `Object.prototype`
 * or `null`).
 */
export function isPlainJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPartObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainJsonObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => PART_KEYS.has(key));
}

function isUnambiguousPartObject(value: unknown): boolean {
  if (!isPartObject(value)) {
    return false;
  }
  return Object.keys(value).some((key) => UNAMBIGUOUS_PART_KEYS.has(key));
}

/**
 * Returns whether `value` is a genai `Content` object rather than plain
 * {@link JSONContent}.
 */
export function isClassifierContentInput(value: unknown): value is Content {
  if (!isPlainJsonObject(value) || !Array.isArray(value['parts'])) {
    return false;
  }
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'parts' || key === 'role')) {
    return false;
  }
  const role = value['role'];
  if (role !== undefined && typeof role !== 'string') {
    return false;
  }
  const parts = value['parts'];
  if (parts.length > 0) {
    return parts.every(isPartObject);
  }
  return role === 'user' || role === 'model';
}

function normalizeJsonValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): JsonValue {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('JSON content numbers must be finite.');
    }
    return value + 0;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_CONTENT_DEPTH) {
      throw new Error(
        `JSON content exceeds maximum nesting depth of ${MAX_JSON_CONTENT_DEPTH}.`,
      );
    }
    if (seen.has(value)) {
      throw new Error('JSON content must not contain circular references.');
    }
    seen.add(value);
    try {
      return value.map((item) => normalizeJsonValue(item, depth + 1, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (isPlainJsonObject(value)) {
    if (depth >= MAX_JSON_CONTENT_DEPTH) {
      throw new Error(
        `JSON content exceeds maximum nesting depth of ${MAX_JSON_CONTENT_DEPTH}.`,
      );
    }
    if (seen.has(value)) {
      throw new Error('JSON content must not contain circular references.');
    }
    if (
      depth > 0 &&
      (isClassifierContentInput(value) || isUnambiguousPartObject(value))
    ) {
      throw new Error(
        'GenAI Content and Part objects are not valid inside JSON content; pass a single top-level Content or serialize them to text.',
      );
    }
    seen.add(value);
    try {
      const copy: Record<string, JsonValue> = {};
      for (const [key, entry] of Object.entries(value)) {
        setOwnProperty(copy, key, normalizeJsonValue(entry, depth + 1, seen));
      }
      return copy;
    } finally {
      seen.delete(value);
    }
  }
  throw new Error('Value is not valid JSON content.');
}

/**
 * Validates that `content` is a string, a JSON-serializable plain object, or a
 * JSON-serializable array, returning a normalized copy.
 */
export function validateJSONContent(content: unknown): JSONContent {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content) && !isPlainJsonObject(content)) {
    throw new Error(
      'Expected string, plain object, or array for JSON content.',
    );
  }
  if (isPlainJsonObject(content) && isUnambiguousPartObject(content)) {
    throw new Error(
      'GenAI Part objects are not valid JSON content; pass a top-level Content instead.',
    );
  }
  return normalizeJsonValue(content, 0, new Set<object>()) as JSONContent;
}

/**
 * Validates that `input` is a valid {@link ClassifierInput}: {@link JSONContent}
 * or a top-level genai `Content` object.
 */
export function validateClassifierInput(input: unknown): ClassifierInput {
  if (input === null || input === undefined) {
    throw new Error('Classifier input must not be null or undefined.');
  }
  if (isClassifierContentInput(input)) {
    return input;
  }
  return validateJSONContent(input);
}

/**
 * Renders {@link JSONContent} as a string: returns a string unchanged and
 * serializes a JSON object or array with `JSON.stringify`.
 */
export function renderJSONContent(content: JSONContent): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function validateProbability(field: string, value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`${field} must be a finite number in [0, 1].`);
  }
  return value + 0;
}

function validateConfidence(confidence: unknown): number | undefined {
  if (confidence === undefined || confidence === null) {
    return undefined;
  }
  return validateProbability('confidence', confidence);
}

function checkAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  kind: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field in ${kind}.`);
    }
  }
}

/**
 * Creates a validated {@link Choice} question.
 */
export function createChoice(params: CreateChoiceParams): Choice {
  if (!isPlainJsonObject(params.criteria)) {
    throw new Error('Choice criteria must be a plain object.');
  }
  const entries = Object.entries(params.criteria);
  if (entries.length < 2) {
    throw new Error(
      `Choice requires at least 2 criteria labels, got ${entries.length}.`,
    );
  }
  const criteria: Record<string, JSONContent | null> = {};
  for (const [label, description] of entries) {
    setOwnProperty(
      criteria,
      label,
      description === undefined || description === null
        ? null
        : validateJSONContent(description),
    );
  }
  return {
    type: 'choice',
    ...(params.instructions !== undefined && params.instructions !== null
      ? {instructions: validateJSONContent(params.instructions)}
      : {}),
    criteria,
  };
}

/** Type guard for {@link Choice}. */
export function isChoice(value: unknown): value is Choice {
  return (
    isPlainJsonObject(value) &&
    value['type'] === 'choice' &&
    isPlainJsonObject(value['criteria'])
  );
}

/**
 * Creates a validated {@link Binary} question.
 */
export function createBinary(params: CreateBinaryParams = {}): Binary {
  return {
    type: 'binary',
    ...(params.instructions !== undefined && params.instructions !== null
      ? {instructions: validateJSONContent(params.instructions)}
      : {}),
    ...(params.criteria !== undefined && params.criteria !== null
      ? {criteria: validateJSONContent(params.criteria)}
      : {}),
  };
}

/** Type guard for {@link Binary}. */
export function isBinary(value: unknown): value is Binary {
  return (
    isPlainJsonObject(value) &&
    value['type'] === 'binary' &&
    !('probability' in value)
  );
}

/**
 * Creates a validated {@link Score} question.
 */
export function createScore(params: CreateScoreParams): Score {
  if (!Array.isArray(params.criteria)) {
    throw new Error('Score criteria must be an array.');
  }
  if (params.criteria.length < 2) {
    throw new Error(
      `Score requires at least 2 criteria levels, got ${params.criteria.length}.`,
    );
  }
  const criteria = params.criteria.map((level) => {
    if (level === null || level === undefined) {
      throw new Error('Score criteria levels must not be null or undefined.');
    }
    return validateJSONContent(level);
  });
  return {
    type: 'score',
    ...(params.instructions !== undefined && params.instructions !== null
      ? {instructions: validateJSONContent(params.instructions)}
      : {}),
    criteria,
  };
}

/** Type guard for {@link Score}. */
export function isScore(value: unknown): value is Score {
  return (
    isPlainJsonObject(value) &&
    value['type'] === 'score' &&
    Array.isArray(value['criteria'])
  );
}

/** Type guard for {@link Question}. */
export function isQuestion(value: unknown): value is Question {
  return isChoice(value) || isBinary(value) || isScore(value);
}

/**
 * Validates a {@link Question} and returns a normalized copy.
 */
export function validateQuestion(question: unknown): Question {
  if (!isPlainJsonObject(question)) {
    throw new Error('Question must be an object.');
  }
  checkAllowedKeys(question, QUESTION_ALLOWED_KEYS, 'question');
  const rawInstructions = question['instructions'];
  const instructions =
    rawInstructions === undefined || rawInstructions === null
      ? undefined
      : validateJSONContent(rawInstructions);
  const rawCriteria = question['criteria'];
  switch (question['type']) {
    case 'choice': {
      if (!isPlainJsonObject(rawCriteria)) {
        throw new Error('Choice criteria must be a plain object.');
      }
      const criteria: Record<string, JSONContent | null> = {};
      for (const [label, desc] of Object.entries(rawCriteria)) {
        setOwnProperty(
          criteria,
          label,
          desc === undefined || desc === null
            ? null
            : validateJSONContent(desc),
        );
      }
      return createChoice({instructions, criteria});
    }
    case 'binary':
      return createBinary({
        instructions,
        criteria:
          rawCriteria === undefined || rawCriteria === null
            ? undefined
            : validateJSONContent(rawCriteria),
      });
    case 'score': {
      if (!Array.isArray(rawCriteria)) {
        throw new Error('Score criteria must be an array.');
      }
      const criteria = rawCriteria.map((level) => {
        if (level === null || level === undefined) {
          throw new Error(
            'Score criteria levels must not be null or undefined.',
          );
        }
        return validateJSONContent(level);
      });
      return createScore({instructions, criteria});
    }
    default:
      throw new Error('Unsupported question type.');
  }
}

/**
 * Creates a validated {@link ChoiceAnswer}.
 */
export function createChoiceAnswer(
  params: CreateChoiceAnswerParams,
): ChoiceAnswer {
  if (typeof params.choice !== 'string') {
    throw new Error('ChoiceAnswer choice must be a string.');
  }
  if (!isPlainJsonObject(params.probabilities)) {
    throw new Error('ChoiceAnswer probabilities must be an object.');
  }
  const entries = Object.entries(params.probabilities);
  if (entries.length === 0) {
    throw new Error('ChoiceAnswer probabilities must not be empty.');
  }
  const probabilities: Record<string, number> = {};
  for (const [label, prob] of entries) {
    setOwnProperty(
      probabilities,
      label,
      validateProbability('ChoiceAnswer probability', prob),
    );
  }
  const confidence = validateConfidence(params.confidence);
  return {
    type: 'choice',
    choice: params.choice,
    probabilities,
    ...(confidence !== undefined ? {confidence} : {}),
  };
}

/** Type guard for {@link ChoiceAnswer}. */
export function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
  return (
    isPlainJsonObject(value) &&
    value['type'] === 'choice' &&
    typeof value['choice'] === 'string' &&
    isPlainJsonObject(value['probabilities'])
  );
}

/**
 * Creates a validated {@link BinaryAnswer}.
 */
export function createBinaryAnswer(
  params: CreateBinaryAnswerParams,
): BinaryAnswer {
  const probability = validateProbability('probability', params.probability);
  const confidence = validateConfidence(params.confidence);
  return {
    type: 'binary',
    probability,
    ...(confidence !== undefined ? {confidence} : {}),
  };
}

/** Type guard for {@link BinaryAnswer}. */
export function isBinaryAnswer(value: unknown): value is BinaryAnswer {
  return (
    isPlainJsonObject(value) &&
    value['type'] === 'binary' &&
    typeof value['probability'] === 'number'
  );
}

/**
 * Creates a validated {@link ScoreAnswer}.
 */
export function createScoreAnswer(
  params: CreateScoreAnswerParams,
): ScoreAnswer {
  if (
    typeof params.score !== 'number' ||
    !Number.isFinite(params.score) ||
    params.score < 0
  ) {
    throw new Error('ScoreAnswer score must be a finite non-negative number.');
  }
  if (!isPlainJsonObject(params.probabilities)) {
    throw new Error('ScoreAnswer probabilities must be an object.');
  }
  const entries = Object.entries(params.probabilities);
  if (entries.length === 0) {
    throw new Error('ScoreAnswer probabilities must not be empty.');
  }
  const probabilities: Record<number, number> = {};
  for (const [rawLevel, prob] of entries) {
    if (!NON_NEGATIVE_INTEGER_KEY_REGEX.test(rawLevel)) {
      throw new Error(
        'ScoreAnswer probability keys must be non-negative integers.',
      );
    }
    const level = Number(rawLevel);
    if (!Number.isSafeInteger(level)) {
      throw new Error('ScoreAnswer probability key is out of range.');
    }
    probabilities[level] = validateProbability('ScoreAnswer probability', prob);
  }
  const confidence = validateConfidence(params.confidence);
  return {
    type: 'score',
    score: params.score + 0,
    probabilities,
    ...(confidence !== undefined ? {confidence} : {}),
  };
}

/** Type guard for {@link ScoreAnswer}. */
export function isScoreAnswer(value: unknown): value is ScoreAnswer {
  return (
    isPlainJsonObject(value) &&
    value['type'] === 'score' &&
    typeof value['score'] === 'number' &&
    isPlainJsonObject(value['probabilities'])
  );
}

/**
 * Creates a {@link RefusalAnswer}.
 */
export function createRefusalAnswer(): RefusalAnswer {
  return {type: 'refusal'};
}

/** Type guard for {@link RefusalAnswer}. */
export function isRefusalAnswer(value: unknown): value is RefusalAnswer {
  return isPlainJsonObject(value) && value['type'] === 'refusal';
}

/** Type guard for {@link Answer}. */
export function isAnswer(value: unknown): value is Answer {
  return (
    isChoiceAnswer(value) ||
    isBinaryAnswer(value) ||
    isScoreAnswer(value) ||
    isRefusalAnswer(value)
  );
}

/**
 * Validates an {@link Answer} and returns a normalized copy.
 */
export function validateAnswer(answer: unknown): Answer {
  if (!isPlainJsonObject(answer)) {
    throw new Error('Answer must be an object.');
  }
  const confidence = validateConfidence(answer['confidence']);
  switch (answer['type']) {
    case 'choice': {
      checkAllowedKeys(answer, CHOICE_ANSWER_ALLOWED_KEYS, 'ChoiceAnswer');
      const choice = answer['choice'];
      if (typeof choice !== 'string') {
        throw new Error('ChoiceAnswer choice must be a string.');
      }
      const rawProbs = answer['probabilities'];
      if (!isPlainJsonObject(rawProbs)) {
        throw new Error('ChoiceAnswer probabilities must be an object.');
      }
      const probabilities: Record<string, number> = {};
      for (const [label, prob] of Object.entries(rawProbs)) {
        setOwnProperty(
          probabilities,
          label,
          validateProbability('ChoiceAnswer probability', prob),
        );
      }
      return createChoiceAnswer({choice, probabilities, confidence});
    }
    case 'binary':
      checkAllowedKeys(answer, BINARY_ANSWER_ALLOWED_KEYS, 'BinaryAnswer');
      return createBinaryAnswer({
        probability: validateProbability('probability', answer['probability']),
        confidence,
      });
    case 'score': {
      checkAllowedKeys(answer, SCORE_ANSWER_ALLOWED_KEYS, 'ScoreAnswer');
      const score = answer['score'];
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
        throw new Error(
          'ScoreAnswer score must be a finite non-negative number.',
        );
      }
      const rawProbs = answer['probabilities'];
      if (!isPlainJsonObject(rawProbs)) {
        throw new Error('ScoreAnswer probabilities must be an object.');
      }
      const probabilities: Record<number, number> = {};
      for (const [rawLevel, prob] of Object.entries(rawProbs)) {
        if (!NON_NEGATIVE_INTEGER_KEY_REGEX.test(rawLevel)) {
          throw new Error(
            'ScoreAnswer probability keys must be non-negative integers.',
          );
        }
        const level = Number(rawLevel);
        if (!Number.isSafeInteger(level)) {
          throw new Error('ScoreAnswer probability key is out of range.');
        }
        probabilities[level] = validateProbability(
          'ScoreAnswer probability',
          prob,
        );
      }
      return createScoreAnswer({score, probabilities, confidence});
    }
    case 'refusal':
      checkAllowedKeys(answer, REFUSAL_ANSWER_ALLOWED_KEYS, 'RefusalAnswer');
      return createRefusalAnswer();
    default:
      throw new Error('Unsupported answer type.');
  }
}

/**
 * Creates a validated {@link ClassifierResponse}.
 */
export function createClassifierResponse(
  params: CreateClassifierResponseParams,
): ClassifierResponse {
  if (!isPlainJsonObject(params.answers)) {
    throw new Error('ClassifierResponse answers must be an object.');
  }
  if (
    params.modelVersion !== undefined &&
    params.modelVersion !== null &&
    typeof params.modelVersion !== 'string'
  ) {
    throw new Error('ClassifierResponse modelVersion must be a string.');
  }
  const answers: Record<string, Answer> = {};
  for (const [name, answer] of Object.entries(params.answers)) {
    setOwnProperty(answers, name, validateAnswer(answer));
  }
  return {
    answers,
    ...(typeof params.modelVersion === 'string'
      ? {modelVersion: params.modelVersion}
      : {}),
  };
}

/** Type guard for {@link ClassifierResponse}. */
export function isClassifierResponse(
  value: unknown,
): value is ClassifierResponse {
  return isPlainJsonObject(value) && isPlainJsonObject(value['answers']);
}

/**
 * Validates a {@link ClassifierResponse} and returns a normalized copy.
 */
export function validateClassifierResponse(
  response: unknown,
): ClassifierResponse {
  if (!isPlainJsonObject(response)) {
    throw new Error('ClassifierResponse must be an object.');
  }
  const rawAnswers = response['answers'];
  if (!isPlainJsonObject(rawAnswers)) {
    throw new Error('ClassifierResponse answers must be an object.');
  }
  const rawModelVersion = response['modelVersion'];
  if (
    rawModelVersion !== undefined &&
    rawModelVersion !== null &&
    typeof rawModelVersion !== 'string'
  ) {
    throw new Error('ClassifierResponse modelVersion must be a string.');
  }
  const answers: Record<string, Answer> = {};
  for (const [name, answer] of Object.entries(rawAnswers)) {
    setOwnProperty(answers, name, validateAnswer(answer));
  }
  return createClassifierResponse({
    answers,
    modelVersion:
      typeof rawModelVersion === 'string' ? rawModelVersion : undefined,
  });
}

function parseJsonObjectInput(
  json: string | Record<string, unknown>,
  kind: string,
): Record<string, unknown> {
  let parsed: unknown = json;
  if (typeof json === 'string') {
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(`Malformed ${kind} JSON.`);
    }
  }
  if (!isPlainJsonObject(parsed)) {
    throw new Error(`Expected ${kind} JSON to be an object.`);
  }
  return parsed;
}

/**
 * Parses and validates a {@link Question} from a JSON string or plain object.
 */
export function parseQuestionJson(
  json: string | Record<string, unknown>,
): Question {
  return validateQuestion(parseJsonObjectInput(json, 'question'));
}

/**
 * Serializes a {@link Question} to a wire-compatible JSON object matching the
 * Python, Go, Java, and Kotlin ADKs.
 */
export function serializeQuestion(question: Question): Record<string, unknown> {
  const validated = validateQuestion(question);
  switch (validated.type) {
    case 'choice': {
      const criteria: Record<string, JSONContent | null> = {};
      for (const [label, desc] of Object.entries(validated.criteria)) {
        setOwnProperty(criteria, label, desc ?? null);
      }
      return {
        type: 'choice',
        instructions: validated.instructions ?? null,
        criteria,
      };
    }
    case 'binary':
      return {
        type: 'binary',
        instructions: validated.instructions ?? null,
        criteria: validated.criteria ?? null,
      };
    case 'score':
      return {
        type: 'score',
        instructions: validated.instructions ?? null,
        criteria: [...validated.criteria],
      };
    default: {
      const exhaustive: never = validated;
      throw new Error(`Unknown question: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Parses and validates an {@link Answer} from a JSON string or plain object.
 */
export function parseAnswerJson(
  json: string | Record<string, unknown>,
): Answer {
  return validateAnswer(parseJsonObjectInput(json, 'answer'));
}

/**
 * Serializes an {@link Answer} to a wire-compatible JSON object matching the
 * Python, Go, Java, and Kotlin ADKs.
 */
export function serializeAnswer(answer: Answer): Record<string, unknown> {
  const validated = validateAnswer(answer);
  switch (validated.type) {
    case 'choice': {
      const probabilities: Record<string, number> = {};
      for (const [label, prob] of Object.entries(validated.probabilities)) {
        setOwnProperty(probabilities, label, prob);
      }
      return {
        type: 'choice',
        choice: validated.choice,
        probabilities,
        confidence: validated.confidence ?? null,
      };
    }
    case 'binary':
      return {
        type: 'binary',
        probability: validated.probability,
        confidence: validated.confidence ?? null,
      };
    case 'score': {
      const probabilities: Record<string, number> = {};
      for (const [level, prob] of Object.entries(validated.probabilities)) {
        setOwnProperty(probabilities, String(level), prob);
      }
      return {
        type: 'score',
        score: validated.score,
        probabilities,
        confidence: validated.confidence ?? null,
      };
    }
    case 'refusal':
      return {type: 'refusal'};
    default: {
      const exhaustive: never = validated;
      throw new Error(`Unknown answer: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Parses and validates a {@link ClassifierResponse} from a JSON string or
 * plain object.
 */
export function parseClassifierResponseJson(
  json: string | Record<string, unknown>,
): ClassifierResponse {
  const raw = parseJsonObjectInput(json, 'classifier response');
  checkAllowedKeys(raw, RESPONSE_WIRE_ALLOWED_KEYS, 'ClassifierResponse');
  const rawModelVersion = raw['model_version'];
  if (
    rawModelVersion !== undefined &&
    rawModelVersion !== null &&
    typeof rawModelVersion !== 'string'
  ) {
    throw new Error('ClassifierResponse model_version must be a string.');
  }
  const rawAnswers = raw['answers'];
  if (!isPlainJsonObject(rawAnswers)) {
    throw new Error('ClassifierResponse answers must be an object.');
  }
  const answers: Record<string, Answer> = {};
  for (const [name, rawAnswer] of Object.entries(rawAnswers)) {
    if (!isPlainJsonObject(rawAnswer)) {
      throw new Error('Each answer in ClassifierResponse must be an object.');
    }
    setOwnProperty(answers, name, validateAnswer(rawAnswer));
  }
  return {
    answers,
    ...(typeof rawModelVersion === 'string'
      ? {modelVersion: rawModelVersion}
      : {}),
  };
}

/**
 * Serializes a {@link ClassifierResponse} to a wire-compatible JSON object
 * matching the Python, Go, Java, and Kotlin ADKs.
 */
export function serializeClassifierResponse(
  response: ClassifierResponse,
): Record<string, unknown> {
  const validated = validateClassifierResponse(response);
  const answers: Record<string, Record<string, unknown>> = {};
  for (const [name, answer] of Object.entries(validated.answers)) {
    setOwnProperty(answers, name, serializeAnswer(answer));
  }
  return {
    answers,
    model_version: validated.modelVersion ?? null,
  };
}
