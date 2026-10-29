/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, type Context, trace, type Tracer} from '@opentelemetry/api';

import {version} from '../../../../version.js';
import {GEN_AI_SYSTEM_VALUE} from '../common/attributes.js';

/**
 * Returns the OpenTelemetry tracer for ADK spans from the active global
 * tracer provider.
 *
 * Resolved on each call rather than cached at module load time so that
 * tests and callers that replace the global `TracerProvider` after import
 * (via `trace.disable()` and `trace.setGlobalTracerProvider(...)`) are
 * observed instead of latching onto the first provider's `ProxyTracer`
 * delegate.
 */
export function getTracer(): Tracer {
  return trace.getTracer(GEN_AI_SYSTEM_VALUE, version);
}

/**
 * Binds an async generator to OpenTelemetry context for trace propagation.
 *
 * @param ctx The OpenTelemetry context to bind the generator to.
 * @param generator The async generator to be bound to the context.
 * @returns A new async generator that executes all operations within the provided context.
 */
export function bindOtelContextToAsyncGenerator<T>(
  ctx: Context,
  generator: AsyncGenerator<T, void, void>,
): AsyncGenerator<T, void, void> {
  return {
    next: context.bind(ctx, generator.next.bind(generator)),
    return: context.bind(ctx, generator.return.bind(generator)),
    throw: context.bind(ctx, generator.throw.bind(generator)),
    [Symbol.asyncIterator]() {
      return bindOtelContextToAsyncGenerator(
        ctx,
        generator[Symbol.asyncIterator](),
      );
    },
  };
}
