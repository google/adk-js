/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {objectSchemaFields, SchemaLike} from '../utils/schema.js';
import {recordStateWrite} from './state_write_order.js';

/** Raised when a state mutation violates the declared state schema. */
export class StateSchemaError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'StateSchemaError';
    Object.setPrototypeOf(this, StateSchemaError.prototype);
  }
}

/** Type guard for {@link StateSchemaError}. */
export function isStateSchemaError(e: unknown): e is StateSchemaError {
  return e instanceof Error && e.name === 'StateSchemaError';
}

/**
 * A state mapping that maintains the current value and the pending-commit
 * delta.
 */
export class State {
  static readonly APP_PREFIX = 'app:';
  static readonly USER_PREFIX = 'user:';
  static readonly TEMP_PREFIX = 'temp:';

  constructor(
    /** The current value of the state. */
    private value: Record<string, unknown> = {},
    /** The delta change to the current value that hasn't been committed. */
    private delta: Record<string, unknown> = {},
    /**
     * Declares the keys this state may hold and their types. When set, every
     * mutation is checked against it; prefixed keys are exempt.
     */
    readonly schema?: SchemaLike,
  ) {}

  /**
   * Checks a whole delta against {@link schema}, for writes that reach the
   * session without passing through this object — a node emitting an event
   * that carries its own `stateDelta`.
   */
  validateDelta(delta: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(delta)) {
      this.validate(key, value);
    }
  }

  /**
   * Checks one key/value pair against {@link schema}, throwing
   * {@link StateSchemaError} when the key is undeclared or its value does not
   * match the declared type.
   *
   * Prefixed keys (`app:`, `user:`, `temp:`, or any other namespace) belong to
   * a scope wider than this state and are never validated — the same carve-out
   * adk-python makes.
   */
  private validate(key: string, value: unknown): void {
    if (this.schema === undefined || key.includes(':')) {
      return;
    }
    const fields = objectSchemaFields(this.schema);
    if (!fields) {
      return;
    }
    if (!fields.has(key)) {
      throw new StateSchemaError(
        `Key '${key}' is not declared in the state schema. Declared fields: ` +
          JSON.stringify([...fields.keys()].sort()),
      );
    }
    const field = fields.get(key);
    if (!field) {
      return;
    }
    const parsed = field.safeParse(value);
    if (!parsed.success) {
      throw new StateSchemaError(
        `Value for '${key}' does not match the type declared in the state ` +
          `schema: ${parsed.error.message}`,
      );
    }
  }

  /**
   * Returns the value of the state dict for the given key.
   *
   * @param key The key to get the value for.
   * @param defaultValue The default value to return if the key is not found.
   * @return The value of the state for the given key, or the default value if
   *     not found.
   */
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (key in this.delta) {
      return this.delta[key] as T;
    }

    if (key in this.value) {
      return this.value[key] as T;
    }

    return defaultValue;
  }

  /**
   * Sets the value of the state dict for the given key.
   *
   * @param key The key to set the value for.
   * @param value The value to set.
   */
  set(key: string, value: unknown) {
    this.validate(key, value);
    this.value[key] = value;
    this.delta[key] = value;
    // Stamp the write so that committing this delta later cannot roll the key
    // back over a newer write. See `state_write_order.ts`.
    recordStateWrite(this.value, this.delta, key);
  }

  /**
   * Whether the state has pending delta.
   */
  has(key: string): boolean {
    return key in this.value || key in this.delta;
  }

  /**
   * Whether the state has pending delta.
   */
  hasDelta(): boolean {
    return Object.keys(this.delta).length > 0;
  }

  /**
   * Updates the state dict with the given delta.
   *
   * @param delta The delta to update the state with.
   */
  update(delta: Record<string, unknown>) {
    this.validateDelta(delta);
    // This should be revised while working on the parallel tool execution.
    Object.assign(this.delta, delta);
    Object.assign(this.value, delta);
    for (const key of Object.keys(delta)) {
      recordStateWrite(this.value, this.delta, key);
    }
  }

  /**
   * Returns the state as a plain JSON object.
   */
  toRecord(): Record<string, unknown> {
    return {...this.value, ...this.delta};
  }
}
