/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude: extended thinking
 *
 * ADK's `thinkingConfig.thinkingBudget` maps onto Claude's own thinking modes:
 * `0` disables thinking, a positive value is a manual token budget (Anthropic
 * requires at least 1024, and less than the response ceiling), and `-1` hands
 * the choice of depth to the model. Anthropic accepts no default here, so a
 * `thinkingConfig` with no budget is rejected rather than guessed at.
 *
 * The reasoning arrives as parts flagged `thought`, kept apart from the answer,
 * and Claude ignores temperature and the other sampling knobs while it reasons.
 *
 * REQUIRES an Anthropic API key. Set ANTHROPIC_API_KEY, then:
 *   npm run sample -- samples/claude/extended_thinking/agent.ts
 *
 * Try: "I have 17 apples and give away a third, rounded up. How many are left?"
 */

import {LlmAgent} from '@google/adk';
import {AnthropicLlm} from '@google/adk-integrations';

export const rootAgent = new LlmAgent({
  name: 'claude_thinking_agent',
  model: new AnthropicLlm({
    model: 'claude-sonnet-4-5-20250929',
    // The budget has to fit inside the response ceiling.
    maxTokens: 8192,
  }),
  description: 'A careful reasoner powered by Claude extended thinking.',
  instruction:
    'Work the problem through, then state the answer on its own line.',
  generateContentConfig: {
    thinkingConfig: {thinkingBudget: 2048},
  },
});
