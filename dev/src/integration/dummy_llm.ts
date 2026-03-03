/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';

export class DummyLlm extends BaseLlm {
  constructor() {
    super({model: 'dummy-llm'});
  }

  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'DummyLlm.connect should not be called during replay tests.',
    );
  }

  /* eslint-disable require-yield */
  async *generateContentAsync(
    request: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void, void> {
    throw new Error(
      `DummyLlm.generateContentAsync should not be called during replay tests. request: ${JSON.stringify(
        request,
      )}`,
    );
  }
  /* eslint-enable require-yield */
}
