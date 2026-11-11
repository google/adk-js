/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP error types conforming to OpenTelemetry semantics.
 *
 * The string values populate the `error.type` span attribute, so they are
 * observable outside the process and must stay identical to the adk-python
 * `ToolErrorType` members.
 */
export enum ToolErrorType {
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  BAD_GATEWAY = 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',
}

/**
 * Represents an error that occurs during the execution of a tool.
 */
export class ToolExecutionError extends Error {
  /**
   * @param message A message describing the error.
   * @param errorType The semantic error type (e.g.
   *   {@link ToolErrorType.REQUEST_TIMEOUT} or `'500'`). Used to populate the
   *   `error.type` span attribute in OpenTelemetry traces.
   */
  constructor(
    message: string,
    readonly errorType?: ToolErrorType | string,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}
