/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, createEvent, Event, InvocationContext} from '@google/adk';

class ToolConfirmationAgent extends BaseAgent {
  constructor() {
    super({name: 'tool_confirmation'});
  }

  async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const userMsg = ctx.session.events[ctx.session.events.length - 1];
    const hasConfirmation = userMsg?.content?.parts?.some(
      (p) =>
        p.functionResponse?.name === 'adk_request_confirmation' &&
        p.functionResponse.response?.confirmed === true,
    );
    if (!hasConfirmation) {
      yield createEvent({
        author: this.name,
        content: {
          role: 'model',
          parts: [
            {text: 'creating ticket...'},
            {
              functionCall: {
                name: 'adk_request_confirmation',
                args: {
                  originalFunctionCall: {
                    name: 'create_ticket',
                    args: {title: 'Bug'},
                    id: 'call-abc',
                  },
                  toolConfirmation: {hint: 'Confirm creation?'},
                },
                id: 'confirm-xyz',
              },
            },
          ],
        },
        longRunningToolIds: ['confirm-xyz'],
        partial: false,
      });
    } else {
      yield createEvent({
        author: this.name,
        content: {role: 'model', parts: [{text: 'Ticket created!'}]},
        partial: false,
      });
    }
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

export const rootAgent = new ToolConfirmationAgent();
