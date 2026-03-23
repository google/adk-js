/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, createEvent, Event} from '@google/adk';

class StreamingSuccessAgent extends BaseAgent {
  constructor() {
    super({name: 'streaming_success'});
  }

  async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: 'Hello, '}]},
      partial: true,
    });
    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: 'I am '}]},
      partial: true,
    });
    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: 'a streaming agent!'}]},
      partial: false,
    });
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

export const rootAgent = new StreamingSuccessAgent();
