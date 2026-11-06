/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from '../../../../utils/error_utils.js';
import {logger} from '../../../../utils/logger.js';

/**
 * The process-global slot that holds the model-call start hook.
 *
 * The request-driven metric reader in `telemetry/export` sets this slot when a
 * `MeterProvider` registers it, and clears it on shutdown. That module may not
 * import this one, so the two meet at this key, which is repeated there and
 * must stay identical. A `Symbol.for` key on `globalThis` also lets two copies
 * of this package in one process share the slot, as `@opentelemetry/api` does
 * for its own globals.
 */
const INFERENCE_START_HOOK_KEY = Symbol.for(
  'google.adk.telemetry.inferenceStartHook',
);

/**
 * Tells the installed metric reader, if any, that a model call has started.
 *
 * Never throws: a failure in the hook is logged and does not reach the model
 * call that triggered it.
 */
export function notifyInferenceStart(): void {
  const hook: unknown = Reflect.get(globalThis, INFERENCE_START_HOOK_KEY);
  if (typeof hook !== 'function') {
    return;
  }
  try {
    hook();
  } catch (error: unknown) {
    logger.warn(`Model-call metric hook failed: ${formatError(error)}`);
  }
}
