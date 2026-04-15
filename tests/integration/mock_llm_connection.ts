/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlmConnection, LlmResponse} from '@google/adk';

export class MockLlmConnection implements BaseLlmConnection {
  async sendHistory(): Promise<void> {
    return Promise.resolve();
  }
  async sendContent(): Promise<void> {}
  async sendRealtime(): Promise<void> {}
  async *receive(): AsyncGenerator<LlmResponse, void, void> {}
  async close(): Promise<void> {}
}
