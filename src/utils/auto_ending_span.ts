/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Span} from '@opentelemetry/api';

/**
 * A wrapper around an OpenTelemetry Span that automatically ends the span
 * when the object is disposed of, for use with the 'using' keyword.
 */
export class AutoEndingSpan implements Disposable {
  constructor(private readonly span: Span) {}

  getSpan(): Span {
    return this.span;
  }

  [Symbol.dispose](): void {
    this.span.end();
  }
}
