/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

/**
 * The parameters for creating a session.
 */
export interface CreateSessionParams {
  id: string;
  appName: string;
  userId: string;
  state?: Record<string, unknown>;
  events?: Event[];
  lastUpdateTime?: number;
}

/**
 * Represents a session in a conversation between agents and users.
 */
export class Session {
  /**
   * The unique identifier of the session.
   */
  id: string;

  /**
   * The name of the app.
   */
  appName: string;

  /**
   * The id of the user.
   */
  userId: string;

  /**
   * The state of the session.
   */
  state: Record<string, unknown>;

  /**
   * The events of the session, e.g. user input, model response, function
   * call/response, etc.
   */
  events: Event[];

  /**
   * The last update time of the session.
   */
  lastUpdateTime: number;

  constructor(params: CreateSessionParams) {
    this.id = params.id;
    this.appName = params.appName;
    this.userId = params.userId;
    this.state = params.state || {};
    this.events = params.events || [];
    this.lastUpdateTime = params.lastUpdateTime || 0;
  }
}