/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiClient, NodeAuth, NodeDownloader, NodeUploader} from '@google/genai/vertex_internal';
// @ts-ignore - The module may not be published yet
import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {isCompactedEvent} from '../events/compacted_event.js';

import {Event} from '../events/event.js';
import {logger} from '../utils/logger.js';

import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
} from './base_session_service.js';
import {createSession, Session} from './session.js';

/**
 * Checks if the given URI is a Vertex AI session service URI.
 */
export function isVertexAiSessionServiceConnectionString(uri?: string): boolean {
  return uri?.startsWith('vertexai://') || false;
}

export interface VertexAiSessionServiceOptions {
  projectId?: string;
  location?: string;
  agentEngineId?: string;
  expressModeApiKey?: string;
  client?: Sessions;
}

/**
 * A session service implementation that integrates with Vertex AI Agent Engine Sessions.
 */
export class VertexAiSessionService extends BaseSessionService {
  private client: any;
  private agentEngineId?: string;
  private expressModeApiKey?: string;
  private projectId?: string;
  private location?: string;

  constructor(options?: VertexAiSessionServiceOptions) {
    super();
    this.agentEngineId = options?.agentEngineId;
    this.expressModeApiKey = options?.expressModeApiKey;
    this.projectId = options?.projectId;
    this.location = options?.location;

    if (!options?.client && (!this.projectId || !this.location)) {
      throw new Error('Project ID and Location are required if no client instance is provided.');
    }

    if (options?.client) {
      this.client = options.client;
    } else {
      const auth = new NodeAuth({
        googleAuthOptions: {
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      });
      const uploader = new NodeUploader();
      const downloader = new NodeDownloader();
      const apiClient = new ApiClient({
        auth,
        uploader,
        downloader,
        project: this.projectId,
        location: this.location,
        vertexai: true,
        userAgentExtra: `vertex-genai-modules/1.10.4`,
      });
      this.client = new Sessions(apiClient);
    }
  }

  private _getReasoningEngineId(appName: string): string {
    if (this.agentEngineId) {
      return this.agentEngineId;
    }
    if (/^\d+$/.test(appName)) {
      return appName;
    }
    const pattern = /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;
    const match = appName.match(pattern);
    if (!match) {
      throw new Error(`App name ${appName} is not valid. It should either be the full ReasoningEngine resource name, or the reasoning engine id.`);
    }
    return match[3];
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    if (sessionId) {
      throw new Error('User-provided Session id is not supported for VertexAISessionService.');
    }

    const reasoningEngineId = this._getReasoningEngineId(appName);
    let apiResponse = await this.client.createInternal({
      name: `reasoningEngines/${reasoningEngineId}`,
      userId: userId,
      config: state ? {sessionState: state} : {},
    });

    const operationName = apiResponse.name;
    
    // Poll for operation completion
    let attempts = 0;
    while (!apiResponse.done && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      apiResponse = await this.client.getSessionOperationInternal({
        operationName: operationName,
      });
      attempts++;
    }

    if (!apiResponse.done) {
      throw new Error(`Session creation operation ${operationName} did not complete in time.`);
    }

    const getSessionResponse = apiResponse.response;
    const id = getSessionResponse.name.split('/').pop() || '';

    return createSession({
      id,
      appName,
      userId,
      state: getSessionResponse.session_state || {},
      events: [],
      lastUpdateTime: getSessionResponse.update_time?.timestamp || Date.now(),
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const reasoningEngineId = this._getReasoningEngineId(appName);
    const sessionResourceName = `reasoningEngines/${reasoningEngineId}/sessions/${sessionId}`;

    try {
      let getSessionResponse: any;
      let eventsIterator: any[] = [];

      if (config && config.numRecentEvents === 0) {
        getSessionResponse = await this.client.get({ name: sessionResourceName });
      } else {
        const listConfig: any = {};
        if (config && config.afterTimestamp) {
          listConfig.filter = `timestamp>="${new Date(config.afterTimestamp).toISOString()}"`;
        }

        const [sessionRes, eventsRes] = await Promise.all([
          this.client.get({ name: sessionResourceName }),
          this.client.events.listInternal({
            name: sessionResourceName,
            config: listConfig,
          }),
        ]);
        getSessionResponse = sessionRes;
        eventsIterator = eventsRes.sessionEvents || [];
      }

      if (getSessionResponse.userId !== userId) {
        throw new Error(`Session ${sessionId} does not belong to user ${userId}.`);
      }

      const session = createSession({
        id: sessionId,
        appName,
        userId,
        state: getSessionResponse.sessionState || {},
        events: [],
        lastUpdateTime: getSessionResponse.updateTime ? Date.parse(getSessionResponse.updateTime) : Date.now(),
      });

      for (const event of eventsIterator) {
        session.events.push(_fromApiEvent(event));
      }

      if (config && config.numRecentEvents) {
        session.events = session.events.slice(-config.numRecentEvents);
      }

      return session;

    } catch (error: any) {
      if (error.code === 5 || error.code === 404) {
        return undefined;
      }
      logger.error(`Error getting session from Vertex AI: ${error.message}`);
      throw error;
    }
  }

  async listSessions({
    appName,
    userId,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const reasoningEngineId = this._getReasoningEngineId(appName);
    const response = await this.client.listInternal({
      name: `reasoningEngines/${reasoningEngineId}`,
      config: userId ? {filter: `userId="${userId}"`} : {},
    });

    const sessions = response.sessions || [];
    const adkSessions = sessions.map((s: any) => {
      const id = s.name.split('/').pop() || '';
      return createSession({
        id,
        appName,
        userId: s.userId,
        state: s.sessionState || {},
        events: [],
        lastUpdateTime: s.updateTime ? Date.parse(s.updateTime) : Date.now(),
      });
    });

    return {sessions: adkSessions};
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const reasoningEngineId = this._getReasoningEngineId(appName);
    await this.client.delete({
      name: `reasoningEngines/${reasoningEngineId}/sessions/${sessionId}`,
    });
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await super.appendEvent({session, event});
    session.lastUpdateTime = event.timestamp;

    const reasoningEngineId = this._getReasoningEngineId(session.appName);

    const customMetadata: Record<string, any> = {...event.customMetadata};
    if (isCompactedEvent(event)) {
      customMetadata._compaction = {
        startTime: event.startTime,
        endTime: event.endTime,
        compactedContent: event.compactedContent,
      };
    }
    if ((event as any).usageMetadata) {
      customMetadata._usage_metadata = (event as any).usageMetadata;
    }

    const response = await this.client.events.append({
      name: `reasoningEngines/${reasoningEngineId}/sessions/${session.id}`,
      author: event.author || 'user',
      invocationId: event.invocationId || `inv-${Date.now()}`,
      timestamp: new Date(event.timestamp).toISOString(),
      config: {
        content: event.content,
        actions: event.actions ? {
          skipSummarization: event.actions.skipSummarization,
          stateDelta: event.actions.stateDelta,
          artifactDelta: event.actions.artifactDelta,
          transferAgent: event.actions.transferToAgent,
          escalate: event.actions.escalate,
          requestedAuthConfigs: event.actions.requestedAuthConfigs,
        } : undefined,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        eventMetadata: {
          partial: event.partial,
          turnComplete: event.turnComplete,
          interrupted: event.interrupted,
          branch: event.branch,
          customMetadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
          longRunningToolIds: event.longRunningToolIds,
          groundingMetadata: event.groundingMetadata,
        },
      },
    });

    return event;
  }
}

function _fromApiEvent(apiEventObj: any): Event {
  const actions = apiEventObj.actions || {};
  const eventMetadata = apiEventObj.eventMetadata || {};
  
  let customMetadata = eventMetadata.customMetadata;
  let compactionData = null;
  let usageMetadataData = null;

  if (customMetadata) {
    if (customMetadata._compaction) {
      compactionData = customMetadata._compaction;
      delete customMetadata._compaction;
    }
    if (customMetadata._usage_metadata) {
      usageMetadataData = customMetadata._usage_metadata;
      delete customMetadata._usage_metadata;
    }
    if (Object.keys(customMetadata).length === 0) {
      customMetadata = undefined;
    }
  }

  const eventActions = {
    skipSummarization: actions.skipSummarization,
    stateDelta: actions.stateDelta,
    artifactDelta: actions.artifactDelta,
    transferToAgent: actions.transferAgent,
    escalate: actions.escalate,
    requestedAuthConfigs: actions.requestedAuthConfigs,
    compaction: compactionData,
  };

  const event: any = {
    id: apiEventObj.name.split('/').pop() || '',
    invocationId: apiEventObj.invocationId,
    author: apiEventObj.author,
    actions: eventActions as any,
    content: apiEventObj.content,
    timestamp: apiEventObj.timestamp ? new Date(apiEventObj.timestamp).getTime() : Date.now(),
    errorCode: apiEventObj.errorCode,
    errorMessage: apiEventObj.errorMessage,
    partial: eventMetadata.partial,
    turnComplete: eventMetadata.turnComplete,
    interrupted: eventMetadata.interrupted,
    branch: eventMetadata.branch,
    customMetadata,
    longRunningToolIds: eventMetadata.longRunningToolIds,
    usageMetadata: usageMetadataData,
  };

  if (compactionData) {
    event.isCompacted = true;
    event.startTime = compactionData.startTime;
    event.endTime = compactionData.endTime;
    event.compactedContent = compactionData.compactedContent;
  }

  return event as Event;
}
