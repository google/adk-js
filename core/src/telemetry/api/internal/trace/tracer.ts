/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  context,
  type Context,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';

import {version} from '../../../../version.js';
import {GEN_AI_SYSTEM_VALUE, SCHEMA_URL} from '../common/attributes.js';
import {resolveErrorType} from '../common/error.js';

/**
 * Returns the ADK tracer from the global `TracerProvider`.
 *
 * Resolved on every call rather than once at import, like the logger, so the
 * tracer carries the schema URL whichever provider the application registers
 * and whenever it registers it.
 */
export function getTracer(): Tracer {
  return trace
    .getTracerProvider()
    .getTracer(GEN_AI_SYSTEM_VALUE, version, {schemaUrl: SCHEMA_URL});
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

/**
 * Records a failure on a span: the exception and an ERROR status.
 *
 * The status message is the error type rather than the error message, which
 * can carry user data that the content capture setting does not gate. Only an
 * `Error` instance is recorded as an exception; any other thrown value is
 * recorded by its type alone.
 */
export function setSpanError(span: Span, error: unknown): void {
  const errorType = resolveErrorType(error);
  let exception: Error | string;
  try {
    exception = error instanceof Error ? error : errorType;
  } catch {
    // A hostile thrown value (for example, a Proxy with a throwing prototype
    // trap) must not replace the original error with a telemetry error.
    exception = errorType;
  }
  span.recordException(exception);
  span.setStatus({code: SpanStatusCode.ERROR, message: errorType});
}
