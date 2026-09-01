/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mounting every channel's webhook on an HTTP server.
 *
 * Express-shaped but not Express-dependent: the handler only touches
 * `req.method`, `req.url`, `req.body` and `req.headers`, so it works with any
 * server that offers those. Express stays an optional peer dependency.
 */

import type {ChannelAdapter} from '../types.js';

/** The bits of a request this router reads. */
export interface RouterRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body. Mount a JSON body parser ahead of this. */
  body?: unknown;
}

/** The bits of a response this router writes. */
export interface RouterResponse {
  statusCode: number;
  end(body?: string): void;
  setHeader(name: string, value: string): void;
}

/** An Express-compatible middleware. */
export type RouterMiddleware = (
  req: RouterRequest,
  res: RouterResponse,
  next: () => void,
) => void;

/**
 * Builds middleware serving the webhook path of every channel that has one.
 *
 * Requests for any other path are passed straight on.
 */
export function createRouter(
  channels: readonly ChannelAdapter[],
): RouterMiddleware {
  const routes = new Map<string, ChannelAdapter>();
  for (const channel of channels) {
    if (channel.webhook) {
      routes.set(normalizePath(channel.webhook.path), channel);
    }
  }

  return (req, res, next) => {
    if (req.method !== 'POST') {
      next();
      return;
    }

    const channel = routes.get(normalizePath(pathOf(req.url)));
    if (!channel?.webhook) {
      next();
      return;
    }

    void channel.webhook
      .handle({body: req.body, headers: req.headers})
      .then((result) => {
        res.statusCode = result.status;
        if (result.body === undefined) {
          res.end();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result.body));
      })
      .catch(() => {
        // A 500 makes Telegram redeliver, which is what we want for a
        // transient failure and harmless for a permanent one (it gives up).
        res.statusCode = 500;
        res.end();
      });
  };
}

function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0];
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
