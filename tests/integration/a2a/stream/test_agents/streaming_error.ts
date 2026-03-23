/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, createEvent, Event} from '@google/adk';

class StreamingErrorAgent extends BaseAgent {
  constructor() {
    super({name: 'streaming_error'});
  }

  async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: 'Hello, '}]},
      partial: true,
    });
    throw new Error('Mid-stream connection failure!');
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

export const rootAgent = new StreamingErrorAgent();
