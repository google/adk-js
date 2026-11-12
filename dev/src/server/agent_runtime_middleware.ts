/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AgentRuntimeRequestHooks, Logger} from '@google/adk';
import type {NextFunction, Request, RequestHandler, Response} from 'express';

type EndCallback = () => void;

type ByteLengthEncoding = Parameters<typeof Buffer.byteLength>[1];

interface EndArgs {
  readonly chunk?: unknown;
  readonly encoding?: ByteLengthEncoding;
  readonly callback?: EndCallback;
}

/** Options for {@link createAgentRuntimeMiddleware}. */
export interface AgentRuntimeMiddlewareOptions {
  /** The hooks to run around every request. */
  readonly hooks: AgentRuntimeRequestHooks;
  /** Where hook failures are reported. */
  readonly logger: Logger;
}

/**
 * Normalizes the `(cb?)`, `(chunk, cb?)` and `(chunk, encoding, cb?)`
 * overloads of `res.end`.
 */
function normalizeEndArgs(args: readonly unknown[]): EndArgs {
  const [first, second, third] = args;
  if (typeof first === 'function') {
    return {callback: first as EndCallback};
  }
  if (typeof second === 'function') {
    return {chunk: first, callback: second as EndCallback};
  }
  return {
    chunk: first,
    encoding:
      typeof second === 'string' && Buffer.isEncoding(second)
        ? second
        : undefined,
    callback: typeof third === 'function' ? (third as EndCallback) : undefined,
  };
}

/**
 * Returns Express middleware that runs the request hooks around every request.
 *
 * `onRequestStart` runs when the request arrives. `onRequestEnd` runs when the
 * handler ends the response: the final chunk is written at once (setting
 * `Content-Length` when headers have not been sent yet so a single-chunk
 * `res.end(chunk)` is not forced to chunked transfer encoding, and writing no
 * body for `HEAD`), so the client does not wait for it, but the response is
 * completed only after
 * `onRequestEnd` resolves, while the request still holds the CPU. That is
 * before Express's `finish` event. Any callbacks passed to `res.end` (including
 * a duplicate `res.end(cb)` while `onRequestEnd` is pending) are queued and
 * invoked when the underlying response ends. If the client goes away before the
 * handler ends the response, `onRequestEnd` runs when the connection closes.
 * `onRequestEnd` runs exactly once per request, and a hook failure is logged
 * and never breaks the request.
 */
export function createAgentRuntimeMiddleware({
  hooks,
  logger,
}: AgentRuntimeMiddlewareOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      hooks.onRequestStart();
    } catch (error: unknown) {
      logger.warn('Telemetry request-start hook failed.', error);
    }

    let requestEnded = false;
    let endPending = false;
    const pendingCallbacks: EndCallback[] = [];
    const endRequest = async (): Promise<void> => {
      if (requestEnded) {
        return;
      }
      requestEnded = true;
      try {
        await hooks.onRequestEnd();
      } catch (error: unknown) {
        logger.warn('Telemetry request-end hook failed.', error);
      }
    };

    const originalEnd = res.end;
    // `res.end` is overloaded; this wrapper accepts every overload and
    // forwards to the original, so the cast only restores the declared type.
    res.end = function (...args: unknown[]): Response {
      if (endPending) {
        const {callback} = normalizeEndArgs(args);
        if (callback) {
          pendingCallbacks.push(callback);
        }
        return res;
      }
      if (requestEnded) {
        return Reflect.apply(originalEnd, res, args);
      }
      const {chunk, encoding, callback} = normalizeEndArgs(args);
      if (callback) {
        pendingCallbacks.push(callback);
      }
      if (chunk !== undefined && chunk !== null) {
        if (
          !res.headersSent &&
          res.statusCode !== 204 &&
          res.statusCode !== 304 &&
          !res.hasHeader('content-length') &&
          !res.hasHeader('transfer-encoding') &&
          (typeof chunk === 'string' ||
            Buffer.isBuffer(chunk) ||
            chunk instanceof Uint8Array)
        ) {
          const byteLength =
            typeof chunk === 'string'
              ? Buffer.byteLength(chunk, encoding)
              : chunk.byteLength;
          res.setHeader('Content-Length', String(byteLength));
        }
        // A HEAD response carries no body. `res.end(chunk)` drops the chunk on
        // its own, but an explicit `res.write` would send it.
        if (req.method !== 'HEAD') {
          Reflect.apply(
            res.write,
            res,
            encoding === undefined ? [chunk] : [chunk, encoding],
          );
        }
      }
      endPending = true;
      void endRequest()
        .then(() => {
          endPending = false;
          const runCallbacks: EndCallback | undefined =
            pendingCallbacks.length > 0
              ? () => {
                  for (const cb of pendingCallbacks.splice(0)) {
                    cb();
                  }
                }
              : undefined;
          Reflect.apply(originalEnd, res, runCallbacks ? [runCallbacks] : []);
        })
        .catch((error: unknown) => {
          logger.warn('Ending the response failed.', error);
        });
      return res;
    } as Response['end'];

    res.once('close', () => {
      void endRequest();
    });

    next();
  };
}
