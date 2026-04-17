/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {AuthCredential} from '../auth/auth_credential.js';
import {AuthHandler} from '../auth/auth_handler.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {createEventActions, EventActions} from '../events/event_actions.js';
import {SearchMemoryResponse} from '../memory/base_memory_service.js';
import {State} from '../sessions/state.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';

import {InvocationContext} from './invocation_context.js';
import {ReadonlyContext} from './readonly_context.js';

/**
 * The context of various callbacks within an agent run.
 *
 * This class provides the context for callbacks and tool invocations, including
 * access to the invocation context, function call ID, event actions, and
 * authentication response. It also provides methods for requesting credentials,
 * retrieving authentication responses, loading and saving artifacts, and
 * searching memory.
 */
export class Context extends ReadonlyContext {
  private readonly _state: State;

  readonly eventActions: EventActions;
  readonly functionCallId?: string;
  toolConfirmation?: ToolConfirmation;
  readonly abortSignal?: AbortSignal;

  /**
   * @param options The configuration options for the Context.
   * @param options.invocationContext The invocation context.
   * @param options.eventActions The event actions of the current call.
   * @param options.functionCallId The function call id of the current tool call.
   *     This id was returned in the function call event from LLM to identify a
   *     function call. If LLM didn't return this id, ADK will assign one to it.
   *     This id is used to map function call response to the original function
   *     call.
   * @param options.toolConfirmation The tool confirmation of the current tool
   *     call.
   */
  constructor(options: {
    invocationContext: InvocationContext;
    eventActions?: EventActions;
    functionCallId?: string;
    toolConfirmation?: ToolConfirmation;
  }) {
    super(options.invocationContext);
    this.eventActions = options.eventActions || createEventActions();
    this._state = new State(
      options.invocationContext.session.state,
      this.eventActions.stateDelta,
    );
    this.functionCallId = options.functionCallId;
    this.toolConfirmation = options.toolConfirmation;
    this.abortSignal = options.invocationContext.abortSignal;
  }

  /**
   * The delta-aware state of the current session.
   */
  override get state() {
    return this._state;
  }

  get actions(): EventActions {
    return this.eventActions;
  }

  /**
   * Loads an artifact attached to the current session.
   *
   * @param filename The filename of the artifact.
   * @param version The version of the artifact. If not provided, the latest
   *     version will be used.
   * @return A promise that resolves to the loaded artifact.
   */
  loadArtifact(filename: string, version?: number): Promise<Part | undefined> {
    if (!this.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.invocationContext.artifactService.loadArtifact({
      appName: this.invocationContext.appName,
      userId: this.invocationContext.userId,
      sessionId: this.invocationContext.session.id,
      filename,
      version,
    });
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

    const version = await this.invocationContext.artifactService.saveArtifact({
      appName: this.invocationContext.appName,
      userId: this.invocationContext.userId,
      sessionId: this.invocationContext.session.id,
      filename,
      artifact,
    });
    this.eventActions.artifactDelta[filename] = version;

    return version;
  }

  requestCredential(authConfig: AuthConfig) {
    if (!this.functionCallId) {
      throw new Error('functionCallId is not set.');
    }

    const authHandler = new AuthHandler(authConfig);
    this.eventActions.requestedAuthConfigs[this.functionCallId] =
      authHandler.generateAuthRequest();
  }

  /**
   * Gets the auth credential for the given auth config.
   *
   * @param authConfig The auth config to get the auth credential for.
   * @return The auth credential for the given auth config.
   */
  getAuthResponse(authConfig: AuthConfig): AuthCredential | undefined {
    const authHandler = new AuthHandler(authConfig);

    return authHandler.getAuthResponse(this.state);
  }

  /**
   * Lists the filenames of the artifacts attached to the current session.
   *
   * @return A promise that resolves to a list of artifact filenames.
   */
  listArtifacts(): Promise<string[]> {
    if (!this.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.invocationContext.artifactService.listArtifactKeys({
      appName: this.invocationContext.session.appName,
      userId: this.invocationContext.session.userId,
      sessionId: this.invocationContext.session.id,
    });
  }

  /**
   * Searches the memory of the current user.
   *
   * @param query The query to search memory for.
   * @return A promise that resolves to SearchMemoryResponse containing the
   *     matching memories.
   */
  searchMemory(query: string): Promise<SearchMemoryResponse> {
    if (!this.invocationContext.memoryService) {
      throw new Error('Memory service is not initialized.');
    }

    return this.invocationContext.memoryService.searchMemory({
      appName: this.invocationContext.session.appName,
      userId: this.invocationContext.session.userId,
      query,
    });
  }

  /**
   * Requests confirmation for the current tool call.
   */
  requestConfirmation({hint, payload}: {hint?: string; payload?: unknown}) {
    if (!this.functionCallId) {
      throw new Error('functionCallId is not set.');
    }
    this.eventActions.requestedToolConfirmations[this.functionCallId] =
      new ToolConfirmation({
        hint: hint,
        confirmed: false,
        payload: payload,
      });
  }
}
