/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, CreateEventParams, Event} from '../events/event.js';
import {errorName} from './utils/retry_utils.js';

export interface NodeErrorEvent extends Event {
  readonly isNodeError: true;

  errorType: string;

  attemptCount: number;
}

export interface CreateNodeErrorEventParams extends CreateEventParams {
  error: unknown;

  attemptCount?: number;
}

export function isNodeErrorEvent(event: Event): event is NodeErrorEvent {
  return 'isNodeError' in event && event.isNodeError === true;
}

const reportedInvocationIds = new WeakMap<object, string>();

export function claimNodeErrorReport(
  error: unknown,
  invocationId: string,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return true;
  }
  if (reportedInvocationIds.get(error) === invocationId) {
    return false;
  }
  reportedInvocationIds.set(error, invocationId);
  return true;
}

export function createNodeErrorEvent(
  params: CreateNodeErrorEventParams,
): NodeErrorEvent {
  const {error, attemptCount, ...eventParams} = params;
  return {
    ...createEvent(eventParams),
    isNodeError: true,
    errorType: errorName(error),
    errorCode: eventParams.errorCode ?? errorCodeOf(error),
    errorMessage: eventParams.errorMessage ?? errorMessageOf(error),
    attemptCount: attemptCount ?? 1,
  };
}

function errorCodeOf(error: unknown): string {
  const code = (error as {code?: unknown} | null | undefined)?.code;
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  return 'UNKNOWN_ERROR';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
