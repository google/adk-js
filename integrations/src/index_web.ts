/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `Claude` is deliberately absent: it authenticates through
// `@anthropic-ai/vertex-sdk`, which needs Google Cloud credentials and the
// Node-only `google-auth-library`. `AnthropicLlm` is here, but a browser has
// nowhere safe to keep an API key, so it only works when handed a `client` the
// caller built with the Anthropic SDK's `dangerouslyAllowBrowser` option.
export type {AnthropicUsage} from './models/anthropic_converters.js';
export {AnthropicLlm} from './models/anthropic_llm.js';
export type {
  AnthropicClient,
  AnthropicLlmParams,
} from './models/anthropic_llm.js';
export {version} from './version.js';
