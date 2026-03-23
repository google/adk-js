/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, createEvent, Event, InvocationContext} from '@google/adk';

class MultiHopBAgent extends BaseAgent {
  constructor() {
    super({name: 'multi_hop'});
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
            {text: 'agent B working...'},
            {
              functionCall: {
                name: 'request_approval',
                args: {},
                id: 'call-hop',
              },
            },
          ],
        },
        longRunningToolIds: ['call-hop'],
        partial: false,
      });
    } else {
      yield createEvent({
        author: this.name,
        content: {role: 'model', parts: [{text: 'Hop B complete!'}]},
        partial: false,
      });
    }
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

export const rootAgent = new MultiHopBAgent();
