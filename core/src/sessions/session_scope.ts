/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A scope identifying a user within an application context.
 */
export interface UserScope {
  /** The application name. */
  appName: string;
  /** The user ID. */
  userId: string;
}

/**
 * A composite key/scope identifying a specific session within an application and user context.
 */
export interface SessionScope extends UserScope {
  /** The session ID. */
  sessionId: string;
}

/**
 * A scope for session creation where sessionId is optional (generated if omitted).
 */
export interface CreateSessionScope extends UserScope {
  /** The optional session ID. */
  sessionId?: string;
}
