/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {State} from '../sessions/state.js';

import {InvocationContext} from './invocation_context.js';

/**
 * A readonly context represents the data of a single invocation of an agent.
 */
export class ReadonlyContext {
  constructor(readonly invocationContext: InvocationContext) {}

  /**
   * The user content that started this invocation.
   */
  get userContent(): Content|undefined {
    return this.invocationContext.userContent;
  }

  /**
   * The current invocation id.
   */
  get invocationId(): string {
    return this.invocationContext.invocationId;
  }

  /**
   * The current agent name.
   */
  get agentName(): string {
    return this.invocationContext.agent.name;
  }

  /**
   * The state of the current session.
   */
  get state(): Readonly<State> {
    return new State(this.invocationContext.session.state, {}) as
        Readonly<State>;
  }
}
