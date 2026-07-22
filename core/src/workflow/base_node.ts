/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import type {ZodType} from 'zod';
import {createEvent, Event, isEvent} from '../events/event.js';
import type {NodeContext} from './node_context.js';
import {isRequestInput} from './request_input.js';
import {RetryConfig} from './retry_config.js';
import {createRequestInputEvent} from './utils/hitl_utils.js';

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

  /** Optional zod schema validating the node input. */
  inputSchema?: ZodType;

  /** Optional zod schema validating the node output. */
  outputSchema?: ZodType;

  /** Optional zod schema validating relevant session state. */
  stateSchema?: ZodType;
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
  readonly name: string;
  readonly description: string;
  readonly rerunOnResume: boolean;
  readonly waitForOutput: boolean;
  readonly retryConfig?: RetryConfig;
  readonly timeout?: number;
  readonly inputSchema?: ZodType;
  readonly outputSchema?: ZodType;
  readonly stateSchema?: ZodType;

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
    this.timeout = config.timeout;
    this.inputSchema = config.inputSchema;
    this.outputSchema = config.outputSchema;
    this.stateSchema = config.stateSchema;
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

  /** Validates node input against `inputSchema` (Content passes through). */
  protected validateInput(input: TInput): TInput {
    if (!this.inputSchema || isContent(input)) {
      return input;
    }
    return this.inputSchema.parse(input) as TInput;
  }

  /** Validates node output against `outputSchema` (Content passes through). */
  protected validateOutput(output: unknown): unknown {
    if (!this.outputSchema || isContent(output)) {
      return output;
    }
    return this.outputSchema.parse(output);
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
 */
export function toContent(val: unknown): Content | undefined {
  if (val === null || val === undefined) {
    return undefined;
  }
  if (typeof val === 'object' && 'role' in val && 'parts' in val) {
    return val as Content;
  }
  if (typeof val === 'string') {
    return {role: 'model', parts: [{text: val}]};
  }
  try {
    return {role: 'model', parts: [{text: JSON.stringify(val)}]};
  } catch {
    return {role: 'model', parts: [{text: String(val)}]};
  }
}
