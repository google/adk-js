/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../events/event.js';
import {carryDeltaStamp} from '../sessions/state_write_order.js';
import {experimental} from '../utils/experimental.js';
import {BaseNode, BaseNodeConfig} from '../workflow/base_node.js';
import {WorkflowDataError} from '../workflow/errors.js';
import {DEFAULT_ROUTE, Edge, RouteValue} from '../workflow/graph.js';
import type {NodeContext} from '../workflow/node_context.js';
import {
  BaseClassifier,
  checkClassifierEnabled,
  isBaseClassifier,
} from './base_classifier.js';
import {
  Answer,
  Binary,
  Choice,
  ClassifierInput,
  isClassifierContentInput,
  JsonValue,
  MAX_JSON_CONTENT_DEPTH,
  Question,
  serializeAnswer,
  setOwnProperty,
  validateAnswer,
  validateClassifierInput,
  validateQuestion,
} from './types.js';

const CLASSIFIER_NODE_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.classifiers.classifierNode',
);

const ROUTE_QUESTION_NAME = 'route';

/**
 * Default probability threshold for {@link Binary} questions on
 * {@link ClassifierNode}.
 */
export const DEFAULT_CLASSIFIER_THRESHOLD = 0.5;

/**
 * Configuration for constructing a {@link ClassifierNode}.
 */
export interface ClassifierNodeConfig extends BaseNodeConfig {
  /** The classifier that answers {@link question}. */
  readonly classifier: BaseClassifier;
  /**
   * The {@link Choice} or {@link Binary} question whose answer picks the route.
   * {@link Score} questions are rejected because scores are continuous rather
   * than discrete route labels.
   */
  readonly question: Question;
  /**
   * For a {@link Binary} question, the probability in `[0, 1]` at or above
   * which the route is `true`. Defaults to `0.5`. Setting it for a
   * {@link Choice} question is an error.
   */
  readonly threshold?: number;
  /**
   * If set, the session state key under which the full serialized answer is
   * stored.
   */
  readonly answerKey?: string;
}

/**
 * Type guard to check if an object is an instance of {@link ClassifierNode}.
 */
export function isClassifierNode(obj: unknown): obj is ClassifierNode {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    CLASSIFIER_NODE_SIGNATURE_SYMBOL in obj &&
    obj[CLASSIFIER_NODE_SIGNATURE_SYMBOL] === true
  );
}

function formatRoutes(routes: Iterable<RouteValue>): string {
  const formatted = [...routes].map((route) => JSON.stringify(route)).sort();
  return `[${formatted.join(', ')}]`;
}

function isNonDataObjectInstance(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Promise ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function convertNodeValueToJson(
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
  if (typeof value !== 'object') {
    throw new Error(`Unsupported value of type ${typeof value} in JSON input.`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Invalid Date in JSON input.');
    }
    return value.toISOString();
  }
  if (isNonDataObjectInstance(value)) {
    throw new Error(
      `Unsupported ${value.constructor?.name ?? 'object'} instance in JSON input.`,
    );
  }
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
    if (Array.isArray(value)) {
      return value.map((item) => convertNodeValueToJson(item, depth + 1, seen));
    }
    const copy: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      setOwnProperty(copy, key, convertNodeValueToJson(entry, depth + 1, seen));
    }
    return copy;
  } finally {
    seen.delete(value);
  }
}

function toClassifierInput(
  nodeName: string,
  nodeInput: unknown,
): ClassifierInput {
  if (nodeInput === null || nodeInput === undefined) {
    throw new WorkflowDataError(
      `ClassifierNode '${nodeName}' received no input to classify.`,
    );
  }
  if (typeof nodeInput === 'string' || isClassifierContentInput(nodeInput)) {
    try {
      return validateClassifierInput(nodeInput);
    } catch (error: unknown) {
      throw new WorkflowDataError(
        `ClassifierNode '${nodeName}' received an invalid input.`,
        {cause: error},
      );
    }
  }
  if (typeof nodeInput === 'object' && !isNonDataObjectInstance(nodeInput)) {
    try {
      const converted = convertNodeValueToJson(nodeInput, 0, new Set<object>());
      return validateClassifierInput(converted);
    } catch (error: unknown) {
      throw new WorkflowDataError(
        `ClassifierNode '${nodeName}' received an input that is not valid JSON content.`,
        {cause: error},
      );
    }
  }
  throw new WorkflowDataError(
    `ClassifierNode '${nodeName}' requires text, a JSON object or array, or Content input.`,
  );
}

/**
 * Routes a workflow by asking a {@link BaseClassifier} one {@link Choice} or
 * {@link Binary} question about its input.
 *
 * The node classifies its input and emits the answer as the route: the chosen
 * label for a {@link Choice}, or `true`/`false` for a {@link Binary} decided by
 * {@link threshold}. Its output is the unchanged input, so the routed-to node
 * receives what the classifier saw.
 *
 * When the node has routed outgoing edges, workflow graph validation checks
 * that every route is a possible answer and that every possible answer has an
 * edge, unless a `DEFAULT_ROUTE` or unconditional edge catches the rest.
 */
@experimental
export class ClassifierNode extends BaseNode {
  readonly [CLASSIFIER_NODE_SIGNATURE_SYMBOL] = true;

  /** The classifier that answers {@link question}. */
  readonly classifier: BaseClassifier;
  /** The question whose answer picks the route. */
  readonly question: Choice | Binary;
  /** The probability at or above which a {@link Binary} routes `true`. */
  readonly threshold: number;
  /** The state key under which the full serialized answer is stored, if set. */
  readonly answerKey?: string;

  constructor(config: ClassifierNodeConfig) {
    super(config);
    checkClassifierEnabled();
    if (!isBaseClassifier(config.classifier)) {
      throw new Error(
        `ClassifierNode '${this.name}' requires a BaseClassifier instance.`,
      );
    }
    const validatedQuestion = validateQuestion(config.question);
    if (validatedQuestion.type === 'score') {
      throw new Error(
        `ClassifierNode '${this.name}' cannot route on a Score question; use a Choice or a Binary.`,
      );
    }
    if (validatedQuestion.type === 'choice') {
      if (config.threshold !== undefined) {
        throw new Error(
          'threshold only applies to Binary questions. A Choice always routes to the label the classifier chose.',
        );
      }
      if (Object.hasOwn(validatedQuestion.criteria, DEFAULT_ROUTE)) {
        throw new Error(
          `ClassifierNode '${this.name}' cannot route on the label "${DEFAULT_ROUTE}", which is reserved for DEFAULT_ROUTE.`,
        );
      }
    } else if (
      config.threshold !== undefined &&
      (typeof config.threshold !== 'number' ||
        !Number.isFinite(config.threshold) ||
        config.threshold < 0 ||
        config.threshold > 1)
    ) {
      throw new Error(
        `ClassifierNode '${this.name}' needs a threshold in [0, 1].`,
      );
    }
    if (
      config.answerKey !== undefined &&
      config.answerKey.trim().length === 0
    ) {
      throw new Error(
        `ClassifierNode '${this.name}' answerKey must not be empty when set.`,
      );
    }

    this.classifier = config.classifier;
    this.question = validatedQuestion;
    this.threshold = config.threshold ?? DEFAULT_CLASSIFIER_THRESHOLD;
    this.answerKey = config.answerKey;
  }

  private validRoutes(): Set<RouteValue> {
    if (this.question.type === 'choice') {
      return new Set<RouteValue>(Object.keys(this.question.criteria));
    }
    return new Set<RouteValue>([true, false]);
  }

  private routeFor(answer: Answer): RouteValue {
    if (answer.type === 'refusal') {
      throw new WorkflowDataError(
        `Classifier for node '${this.name}' declined to answer, so the node has no route to take.`,
      );
    }
    if (this.question.type === 'choice' && answer.type === 'choice') {
      if (!Object.hasOwn(this.question.criteria, answer.choice)) {
        throw new WorkflowDataError(
          `Classifier for node '${this.name}' chose a label that is not one of its question's labels: ${formatRoutes(this.validRoutes())}.`,
        );
      }
      return answer.choice;
    }
    if (this.question.type === 'binary' && answer.type === 'binary') {
      return answer.probability >= this.threshold;
    }
    throw new WorkflowDataError(
      `Classifier for node '${this.name}' returned a ${answer.type} answer to a ${this.question.type} question.`,
    );
  }

  override validateOutgoingEdges(edges: readonly Edge[]): void {
    const edgeRoutes = new Set<RouteValue>();
    let hasUnroutedEdge = false;
    for (const edge of edges) {
      if (edge.route === null || edge.route === undefined) {
        hasUnroutedEdge = true;
        continue;
      }
      if (Array.isArray(edge.route)) {
        for (const route of edge.route) {
          edgeRoutes.add(route);
        }
      } else {
        edgeRoutes.add(edge.route);
      }
    }
    if (edgeRoutes.size === 0) {
      return;
    }

    // Binary questions emit boolean routes (`true`/`false`). A routing map
    // `{true: a, false: b}` is normalized to boolean keys by `graph_parser.ts`,
    // whereas an explicit `new Edge(gate, a, 'true')` with a string route is
    // rejected here to match Python, Java, Kotlin, and Go ClassifierNode
    // validation. Choice questions emit string labels, and because
    // `graph_parser.ts` normalizes numeric/boolean-looking object keys in a
    // routing map (`{'1': n}` -> `1`), a Choice route matches if
    // `String(route)` is a declared label in `criteria`.
    const routes = this.validRoutes();
    const matchedRoutes = new Set<RouteValue>();
    const unknown: RouteValue[] = [];
    for (const route of edgeRoutes) {
      if (route === DEFAULT_ROUTE) {
        continue;
      }
      if (this.question.type === 'choice') {
        const key = String(route);
        if (Object.hasOwn(this.question.criteria, key)) {
          matchedRoutes.add(key);
        } else {
          unknown.push(route);
        }
      } else if (routes.has(route)) {
        matchedRoutes.add(route);
      } else {
        unknown.push(route);
      }
    }
    if (unknown.length > 0) {
      throw new Error(
        `Graph validation failed. ClassifierNode '${this.name}' has edges for routes it never emits: ${formatRoutes(unknown)}. Its routes are ${formatRoutes(routes)}.`,
      );
    }

    const missing: RouteValue[] = [];
    for (const route of routes) {
      if (!matchedRoutes.has(route)) {
        missing.push(route);
      }
    }
    // An unrouted edge always fires, so a missing label still continues there.
    if (
      missing.length > 0 &&
      !edgeRoutes.has(DEFAULT_ROUTE) &&
      !hasUnroutedEdge
    ) {
      throw new Error(
        `Graph validation failed. ClassifierNode '${this.name}' has no edge for routes ${formatRoutes(missing)}, so the branch would end when the classifier picks one. Add an edge for each, or a DEFAULT_ROUTE or unrouted edge.`,
      );
    }
  }

  protected override async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<Event, void, void> {
    const classifierInput = toClassifierInput(this.name, input);
    const response = await this.classifier.classify({
      input: classifierInput,
      questions: {[ROUTE_QUESTION_NAME]: this.question},
      abortSignal: ctx.abortSignal,
    });
    const rawAnswer =
      response &&
      typeof response === 'object' &&
      response.answers &&
      typeof response.answers === 'object' &&
      Object.hasOwn(response.answers, ROUTE_QUESTION_NAME)
        ? response.answers[ROUTE_QUESTION_NAME]
        : undefined;
    if (rawAnswer === undefined) {
      throw new WorkflowDataError(
        `Classifier for node '${this.name}' returned no answer.`,
      );
    }

    let answer: Answer;
    try {
      answer = validateAnswer(rawAnswer);
    } catch (error: unknown) {
      throw new WorkflowDataError(
        `Classifier for node '${this.name}' returned an invalid answer.`,
        {cause: error},
      );
    }

    const route = this.routeFor(answer);
    if (this.answerKey !== undefined) {
      ctx.state.set(this.answerKey, serializeAnswer(answer));
    }
    let stateDelta: Record<string, unknown> | undefined;
    const keys = Object.keys(ctx.actions.stateDelta);
    if (keys.length > 0) {
      stateDelta = {};
      for (const key of keys) {
        setOwnProperty(stateDelta, key, ctx.actions.stateDelta[key]);
        carryDeltaStamp(ctx.actions.stateDelta, stateDelta, key);
      }
    }
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      output: input,
      route,
      actions: stateDelta ? {stateDelta} : undefined,
    });
  }
}
