/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ZodType} from 'zod';
import {randomUUID} from '../utils/env_aware_utils.js';

/** Parameters for constructing a {@link RequestInput}. */
export interface RequestInputParams {
  /** The interrupt id (usually a function-call id). Auto-generated if omitted. */
  interruptId?: string;
  /** Custom payload provided for resuming. */
  payload?: unknown;
  /** A message to display to the user when requesting input. */
  message?: string;
  /** The expected schema of the response. */
  responseSchema?: ZodType;
}

/**
 * A request for input from the user, yielded/returned by a node to pause a
 * workflow (Human-in-the-Loop). The framework converts it to an interrupt
 * event; the workflow surfaces the interrupt id to the caller, which later
 * resumes by providing `resumeInputs[interruptId]`.
 *
 * Ported from `google/adk-python` `events/request_input.py`.
 */
export class RequestInput {
  readonly interruptId: string;
  readonly payload?: unknown;
  readonly message?: string;
  readonly responseSchema?: ZodType;

  constructor(params: RequestInputParams = {}) {
    this.interruptId = params.interruptId ?? randomUUID();
    this.payload = params.payload;
    this.message = params.message;
    this.responseSchema = params.responseSchema;
  }
}

/** Type guard for {@link RequestInput}. */
export function isRequestInput(value: unknown): value is RequestInput {
  return value instanceof RequestInput;
}
