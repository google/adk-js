/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, createEvent, Event, InvocationContext} from '@google/adk';

class LongRunningToolAgent extends BaseAgent {
  constructor() {
    super({name: 'long_running_tool'});
  }

  async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const userMsg = ctx.session.events[ctx.session.events.length - 1];
    const hasApproval = userMsg?.content?.parts?.some(
      (p) =>
        p.functionResponse?.name === 'request_approval' &&
        p.functionResponse.response?.status === 'approved',
    );
    if (!hasApproval) {
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
    } else {
      yield createEvent({
        author: this.name,
        content: {role: 'model', parts: [{text: 'Task complete!'}]},
        partial: false,
      });
    }
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

export const rootAgent = new LongRunningToolAgent();
