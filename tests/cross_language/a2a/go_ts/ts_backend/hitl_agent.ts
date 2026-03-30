/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, createEvent, Event, InvocationContext} from '@google/adk';

class HitlAgent extends BaseAgent {
  constructor() {
    super({
      name: 'hitl_agent',
      description: 'A hitl TS agent for go integration test',
    });
  }

  async *runAsyncImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      content: {
        role: 'model',
        parts: [
          {text: 'need to request approval first!'},
          {
            functionCall: {
              name: 'request_approval',
              args: {},
              id: 'call-123',
            },
          },
        ],
      },
      longRunningToolIds: ['call-123'],
      partial: false,
    });
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

export const rootAgent = new HitlAgent();
