/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude: get started
 *
 * The smallest Claude agent. Importing `@google/adk-integrations` registers the
 * Anthropic provider with the model registry, so a bare `claude-*` name is all
 * the `model` field needs — there is nothing else to wire up.
 *
 * REQUIRES an Anthropic API key. Set ANTHROPIC_API_KEY, then:
 *   npm run sample -- samples/claude/get_started/agent.ts
 */

import {LlmAgent} from '@google/adk';
import '@google/adk-integrations';

export const rootAgent = new LlmAgent({
  name: 'claude_agent',
  model: 'claude-sonnet-4-5-20250929',
  description: 'A concise general-purpose assistant powered by Claude.',
  instruction:
    'You are a helpful assistant. Answer in at most three sentences.',
});
