/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {EventActions} from '../events/event_actions.js';
import {State} from '../sessions/state.js';

import {InvocationContext} from './invocation_context.js';
import {ReadonlyContext} from './readonly_context.js';

/**
 * The context of various callbacks within an agent run.
 */
export class CallbackContext extends ReadonlyContext {
  private readonly _state: State;

  readonly eventActions: EventActions;

  constructor({invocationContext, eventActions}: {
    invocationContext: InvocationContext,
    eventActions?: EventActions,
  }) {
    super(invocationContext);
    this.eventActions = eventActions || new EventActions();
    this._state = new State(
        invocationContext.session.state,
        this.eventActions.stateDelta,
    );
  }

  /**
   * The delta-aware state of the current session.
   */
  override get state() {
    return this._state;
  }

  /**
   * Loads an artifact attached to the current session.
   *
   * @param filename The filename of the artifact.
   * @param version The version of the artifact. If not provided, the latest
   *     version will be used.
   * @return A promise that resolves to the loaded artifact.
   */
  loadArtifact(filename: string, version?: number): Promise<Part|undefined> {
    if (!this.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.invocationContext.artifactService.loadArtifact(
        this.invocationContext.appName,
        this.invocationContext.userId,
        this.invocationContext.session.id,
        filename,
        version,
    );
  }

  /**
   * Saves an artifact attached to the current session.
   *
   * @param filename The filename of the artifact.
   * @param artifact The artifact to save.
   * @return A promise that resolves to the version of the saved artifact.
   */
  async saveArtifact(filename: string, artifact: Part): Promise<number> {
    if (!this.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    const version = await this.invocationContext.artifactService.saveArtifact(
        this.invocationContext.appName,
        this.invocationContext.userId,
        this.invocationContext.session.id,
        filename,
        artifact,
    );
    this.eventActions.artifactDelta[filename] = version;

    return version;
  }
}
