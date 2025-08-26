/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CallbackContext} from '../agents/callback_context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthHandler} from '../auth/auth_handler.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {EventActions} from '../events/event_actions.js';
import {SearchMemoryResponse} from '../memory/base_memory_service.js';

/*
 * The context of the tool.
 *
 * This class provides the context for a tool invocation, including access to
 *  the invocation context, function call ID, event actions, and authentication
 *  response. It also provides methods for requesting credentials, retrieving
 *  authentication responses, listing artifacts, and searching memory.
 */
export class ToolContext extends CallbackContext {
  readonly functionCallId?: string;

  /**
   * @param params.invocationContext The invocation context of the tool.
   * @param params.eventActions The event actions of the current tool call.
   * @param params.functionCallId The function call id of the current tool call.
   *     This id was returned in the function call event from LLM to identify a
   *     function call. If LLM didn't return this id, ADK will assign one to it.
   *     This id is used to map function call response to the original function
   *     call.
   */
  constructor({
    invocationContext,
    eventActions,
    functionCallId,
  }: {
    invocationContext: InvocationContext,
    eventActions?: EventActions,
    functionCallId?: string,
  }) {
    super({invocationContext, eventActions});
    this.functionCallId = functionCallId;
  }

  get actions(): EventActions {
    return this.eventActions;
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
  getAuthResponse(authConfig: AuthConfig): AuthCredential|undefined {
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
}