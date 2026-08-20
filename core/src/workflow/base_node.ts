/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createModelContent, PartListUnion} from '@google/genai';
import {createEvent, Event, isEvent} from '../events/event.js';
import {parseWithSchema, SchemaLike} from '../utils/schema.js';
import {NodeSchemaValidationError} from './errors.js';
import type {NodeContext} from './node_context.js';
import {isRequestInput} from './request_input.js';
import {
  PreparedRetryConfig,
  prepareRetryConfig,
  RetryConfig,
} from './retry_config.js';
import {createRequestInputEvent} from './utils/hitl_utils.js';

/**
 * A unique symbol branding {@link BaseNode} instances.
 *
 * Guards match on this brand rather than `instanceof` so a node stays
 * recognisable when it crosses a package boundary (two copies of adk-js in one
 * runtime would fail an `instanceof` check between them) — mirroring the
 * `Symbol.for('google.adk.*')` brands used across ADK (`isBaseAgent`,
 * `isBaseTool`, `isEvent`).
 */
const BASE_NODE_SIGNATURE_SYMBOL = Symbol.for('google.adk.workflow.baseNode');

/**
 * Configuration shared by all workflow nodes.
 *
 * Mirrors the fields of `google/adk-python` `workflow/_base_node.py::BaseNode`.
 */
export interface BaseNodeConfig {
  /** Canonical, unique-within-a-graph node name. */
  name: string;

  /** Human-readable description (used when a node is exposed as a tool). */
  description?: string;

  /**
   * If true, the node re-executes when a workflow resumes even if it already
   * completed in a prior turn. Default false.
   */
  rerunOnResume?: boolean;

  /**
   * If true, the node only produces its output once all of its predecessors
   * have triggered it (fan-in / join semantics). Default false.
   */
  waitForOutput?: boolean;

  /** Optional retry configuration for transient failures. */
  retryConfig?: RetryConfig;

  /** Maximum time, in seconds, for this node to complete. */
  timeout?: number;

  /** Optional schema validating the node input (Zod v3/v4 or genai `Schema`). */
  inputSchema?: SchemaLike;

  /** Optional schema validating the node output (Zod v3/v4 or genai `Schema`). */
  outputSchema?: SchemaLike;

  /** Optional schema validating relevant session state (Zod v3/v4 or genai `Schema`). */
  stateSchema?: SchemaLike;

  /**
   * Runs this node's subtree in an isolated conversation scope: an agent inside
   * it sees only session events carrying the same scope, plus untagged ones.
   * `true` derives a scope per node run; a string is an explicit shared tag.
   */
  isolationScope?: string | true;
}

/**
 * Abstract base class for all nodes in an ADK workflow.
 *
 * A node is a discrete unit of execution. Subclasses implement {@link runImpl},
 * which may yield {@link Event}s, raw values (boxed into an event), or
 * `null`/`undefined` (skipped). {@link run} normalizes those into a stream of
 * {@link Event}s consumed by the engine.
 */
export abstract class BaseNode<TInput = unknown, TOutput = unknown> {
  /** Brand identifying this object as a {@link BaseNode} (see `isBaseNode`). */
  readonly [BASE_NODE_SIGNATURE_SYMBOL] = true;

  readonly name: string;
  readonly description: string;
  readonly rerunOnResume: boolean;
  readonly waitForOutput: boolean;
  readonly retryConfig?: RetryConfig;
  /**
   * The retry config with its exception filter normalized once, up front (see
   * {@link prepareRetryConfig}). Used by the node runner so the retry hot path
   * never re-normalizes or throws on a malformed config mid-retry.
   */
  readonly preparedRetryConfig?: PreparedRetryConfig;
  readonly timeout?: number;
  readonly inputSchema?: SchemaLike;
  readonly outputSchema?: SchemaLike;
  readonly stateSchema?: SchemaLike;
  readonly isolationScope?: string | true;

  constructor(config: BaseNodeConfig) {
    if (
      !config.name ||
      typeof config.name !== 'string' ||
      config.name.trim().length === 0
    ) {
      throw new Error('Node name must be a non-empty string.');
    }
    this.name = config.name.trim();
    this.description = config.description ?? '';
    this.rerunOnResume = config.rerunOnResume ?? false;
    this.waitForOutput = config.waitForOutput ?? false;
    this.retryConfig = config.retryConfig;
    this.preparedRetryConfig = config.retryConfig
      ? prepareRetryConfig(config.retryConfig)
      : undefined;
    this.timeout = config.timeout;
    this.inputSchema = config.inputSchema;
    this.outputSchema = config.outputSchema;
    this.stateSchema = config.stateSchema;
    this.isolationScope = config.isolationScope;
  }

  /**
   * Whether this node must wait for ALL of its predecessors to trigger before
   * it runs (fan-in barrier). Overridden by `JoinNode`.
   */
  get requiresAllPredecessors(): boolean {
    return false;
  }

  /**
   * Core execution contract. Subclasses yield one of:
   *  - an {@link Event} (emitted as-is),
   *  - a raw value (boxed into an event whose `output` is that value),
   *  - `null`/`undefined` (skipped).
   */
  protected abstract runImpl(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event | TOutput | unknown, void, void>;

  /**
   * Runs the node, normalizing every yielded item into an {@link Event}. This
   * is what the engine (and `ctx.runNode()`) consumes. Validates the input
   * against `inputSchema` once, up front (skipping genai `Content`, which nodes
   * coerce themselves).
   */
  async *run(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event, void, void> {
    const validatedInput = this.validateInput(input);
    for await (const item of this.runImpl(ctx, validatedInput)) {
      if (isRequestInput(item)) {
        // HITL: convert a request-for-input into an interrupt event.
        yield createRequestInputEvent(item);
        continue;
      }
      const event = this.toEvent(ctx, item);
      if (event) {
        yield event;
      }
    }
  }

  /**
   * Validates node input against `inputSchema` (Content passes through). Only
   * enforced for Zod schemas; a genai `Schema` is left unvalidated (see
   * `parseWithSchema`).
   */
  protected validateInput(input: TInput): TInput {
    if (isContent(input)) {
      return input;
    }
    try {
      return parseWithSchema(this.inputSchema, input);
    } catch (e) {
      throw new NodeSchemaValidationError({
        nodeName: this.name,
        direction: 'input',
        cause: e,
      });
    }
  }

  /**
   * Validates node output against `outputSchema` (Content passes through). Only
   * enforced for Zod schemas; a genai `Schema` is left unvalidated (see
   * `parseWithSchema`).
   */
  protected validateOutput(output: unknown): unknown {
    if (isContent(output)) {
      return output;
    }
    try {
      return parseWithSchema(this.outputSchema, output);
    } catch (e) {
      throw new NodeSchemaValidationError({
        nodeName: this.name,
        direction: 'output',
        cause: e,
      });
    }
  }

  /**
   * Normalizes a single yielded item into an {@link Event} (or `null` to skip).
   * Subclasses may override for richer coercion (e.g. `FunctionNode`).
   */
  protected toEvent(ctx: NodeContext, data: unknown): Event | null {
    if (data === null || data === undefined) {
      return null;
    }
    if (isEvent(data)) {
      const event = data as Event;
      if (event.output !== undefined) {
        event.output = this.validateOutput(event.output);
      }
      return event;
    }
    const output = this.validateOutput(data);
    return createEvent({
      author: this.name,
      invocationId: ctx.invocationContext.invocationId,
      branch: ctx.branch,
      content: toContent(output),
      output,
    });
  }
}

/**
 * Type guard for {@link BaseNode}.
 *
 * Matches on the {@link BASE_NODE_SIGNATURE_SYMBOL} brand rather than
 * `instanceof` so it stays correct across package copies (see the brand's doc).
 */
export function isBaseNode(value: unknown): value is BaseNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    BASE_NODE_SIGNATURE_SYMBOL in value &&
    value[BASE_NODE_SIGNATURE_SYMBOL] === true
  );
}

/** Returns whether a value looks like a genai `Content` object. */
export function isContent(value: unknown): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parts' in value &&
    Array.isArray((value as {parts?: unknown}).parts)
  );
}

/**
 * The sentinel node marking the entry point of a workflow graph. It is never
 * executed — the orchestrator seeds triggers for its successors directly.
 *
 * Mirrors `google/adk-python` `START = BaseNode(name='__START__')`.
 */
class StartNode extends BaseNode {
  // eslint-disable-next-line require-yield
  protected async *runImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('START node is never executed.');
  }
}

/** The workflow entry-point sentinel node (name `__START__`). */
export const START: BaseNode = new StartNode({name: '__START__'});

/**
 * Best-effort conversion of an arbitrary value to genai `Content` for display.
 *
 * Strings, `Part`s, and arrays of them are converted via `createModelContent`.
 * Any other value (a plain object, number, boolean, …) is not a valid genai
 * part list, so it is serialized to text rather than throwing.
 */
export function toContent(val: unknown): Content | undefined {
  if (val === null || val === undefined) {
    return undefined;
  }

  if (isContent(val)) {
    return val;
  }

  try {
    return createModelContent(val as PartListUnion);
  } catch {
    return createModelContent(valueToText(val));
  }
}

/** Serializes an arbitrary value to a text string for display. */
function valueToText(val: unknown): string {
  if (typeof val === 'string') {
    return val;
  }
  try {
    // JSON.stringify returns undefined for functions/symbols; fall back to
    // String() there (and for non-serializable values like circular refs).
    return JSON.stringify(val) ?? String(val);
  } catch {
    return String(val);
  }
}
