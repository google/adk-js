/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, createEvent, Event, InvocationContext} from '@google/adk';

class BasicAgent extends BaseAgent {
  constructor() {
    super({
      name: 'basic_agent',
      description: 'A simple TS agent for go integration test',
    });
  }

  async *runAsyncImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: 'Hello from TS basic agent'}],
      },
      partial: false,
    });
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

export const rootAgent = new BasicAgent();
