/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {
  AppendAgentEngineSessionEventConfig,
  AppendAgentEngineSessionEventRequestParameters,
  EventMetadata,
  Session as VertexAiSession,
  SessionEvent as VertexAiSessionEvent,
} from '@google-cloud/vertexai/build/src/genai/types.js';
import {Content, GenerateContentResponseUsageMetadata} from '@google/genai';
import {isCompactedEvent} from '../events/compacted_event.js';
import {experimental} from '../utils/experimental.js';

import {Event} from '../events/event.js';
import {EventActions} from '../events/event_actions.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';
import {logger} from '../utils/logger.js';
import {getExpressModeApiKey} from '../utils/vertex_ai_utils.js';

import {partialCopy} from '../utils/partial_copy.js';
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

const DEFAULT_MAX_ATTEMPTS = 30;
const GRPC_NOT_FOUND = 5;
const HTTP_NOT_FOUND = 404;

/**
 * Checks if the given URI is a Vertex AI session service URI.
 */
export function isVertexAiConnectionString(uri?: string): boolean {
  return uri?.startsWith('vertexai://') || false;
}

export interface VertexAiSessionServiceOptions {
  projectId?: string;
  location?: string;
  agentEngineId?: string;
  expressModeApiKey?: string;
  sessions?: Sessions;
}

/**
 * A session service implementation that integrates with Vertex AI Agent Engine Sessions.
 */
@experimental
export class VertexAiSessionService extends BaseSessionService {
  private sessions: Sessions;
  private agentEngineId?: string;
  private expressModeApiKey?: string;
  private projectId?: string;
  private location?: string;

  constructor(options: VertexAiSessionServiceOptions) {
    super();
    this.agentEngineId = options.agentEngineId;
    this.projectId = options.projectId;
    this.location = options.location;
    this.expressModeApiKey = getExpressModeApiKey(
      this.projectId,
      this.location,
      options.expressModeApiKey,
    );

    if (!options.sessions) {
      if (!this.expressModeApiKey && (!this.projectId || !this.location)) {
        throw new Error(
          'Either (Project ID and Location) or an expressModeApiKey is required.',
        );
      }
    }

    // sessions is primarily for testing to inject a mock client.
    if (options.sessions) {
      this.sessions = options.sessions;
    } else {
      const client = new Client({
        project: this.projectId,
        location: this.location,
      });
      this.sessions = client.agentEnginesInternal.sessions;
    }
  }

  private getReasoningEngineId(appName: string): string {
    if (this.agentEngineId) {
      return this.agentEngineId;
    }
    if (/^\d+$/.test(appName)) {
      return appName;
    }
    const pattern =
      /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;
    const match = appName.match(pattern);
    if (!match) {
      throw new Error(
        `App name ${appName} is not valid. It should either be the full ReasoningEngine resource name, or the reasoning engine id.`,
      );
    }
    return match[3];
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const reasoningEngineId = this.getReasoningEngineId(appName);
    let apiResponse = await this.sessions.createInternal({
      name: `reasoningEngines/${reasoningEngineId}`,
      userId: userId,
      config: {
        ...(state ? {sessionState: state} : {}),
        ...(sessionId ? {sessionId} : {}),
      },
    });

    const operationName = apiResponse.name!;

    let attempts = 0;
    while (!apiResponse.done && attempts < DEFAULT_MAX_ATTEMPTS) {
      const [nextResponse] = await Promise.all([
        this.sessions.getSessionOperationInternal({
          operationName: operationName,
        }),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      apiResponse = nextResponse;
      attempts++;
    }

    if (!apiResponse.done) {
      throw new Error(
        `Session creation operation ${operationName} did not complete in time.`,
      );
    }

    const getSessionResponse = apiResponse.response as VertexAiSession;
    const id = getSessionResponse.name?.split('/').pop() || '';

    return createSession({
      id,
      appName,
      userId,
      state: getSessionResponse.sessionState,
      events: [],
      lastUpdateTime: getSessionResponse.updateTime
        ? Date.parse(getSessionResponse.updateTime)
        : Date.now(),
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const reasoningEngineId = this.getReasoningEngineId(appName);
    const sessionResourceName = `reasoningEngines/${reasoningEngineId}/sessions/${sessionId}`;

    try {
      let getSessionResponse: VertexAiSession | undefined;
      let eventsIterator: VertexAiSessionEvent[] = [];

      if (config && config.numRecentEvents === 0) {
        getSessionResponse = (await this.sessions.get({
          name: sessionResourceName,
        })) as VertexAiSession;
      } else {
        const listConfig: Record<string, string> = {};
        if (config && config.afterTimestamp) {
          listConfig.filter = `timestamp>="${new Date(
            config.afterTimestamp,
          ).toISOString()}"`;
        }

        const [sessionRes, eventsRes] = await Promise.all([
          this.sessions.get({name: sessionResourceName}),
          this.sessions.events.listInternal({
            name: sessionResourceName,
            config: listConfig,
          }),
        ]);
        getSessionResponse = sessionRes as VertexAiSession;
        eventsIterator =
          (eventsRes as {sessionEvents?: VertexAiSessionEvent[]})
            .sessionEvents || [];
      }

      const sessionObj = getSessionResponse!;

      if (sessionObj.userId !== userId) {
        throw new Error(
          `Session ${sessionId} does not belong to user ${userId}.`,
        );
      }

      const session = createSession({
        id: sessionId,
        appName,
        userId,
        state: sessionObj.sessionState,
        events: [],
        lastUpdateTime: sessionObj.updateTime
          ? Date.parse(sessionObj.updateTime)
          : Date.now(),
      });

      for (const event of eventsIterator) {
        session.events.push(_fromApiEvent(event));
      }

      if (config && config.numRecentEvents) {
        session.events = session.events.slice(-config.numRecentEvents);
      }

      return session;
    } catch (error: unknown) {
      const err = error as {code?: number; message?: string};
      if (err.code === GRPC_NOT_FOUND || err.code === HTTP_NOT_FOUND) {
        return undefined;
      }
      logger.error(`Error getting session from Vertex AI: ${err.message}`);
      throw error;
    }
  }

  async listSessions({
    appName,
    userId,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const reasoningEngineId = this.getReasoningEngineId(appName);
    const adkSessions: Session[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response = await this.sessions.listInternal({
        name: `reasoningEngines/${reasoningEngineId}`,
        config: {
          ...(userId ? {filter: `user_id="${userId}"`} : {}),
          ...(pageToken ? {pageToken} : {}),
        },
      });

      const sessions =
        (response as {sessions?: VertexAiSession[]}).sessions || [];
      for (const sessionObj of sessions) {
        const id = sessionObj.name?.split('/').pop() || '';
        adkSessions.push(
          createSession({
            id,
            appName,
            userId: sessionObj.userId,
            state: sessionObj.sessionState,
            events: [],
            lastUpdateTime: sessionObj.updateTime
              ? new Date(sessionObj.updateTime).getTime()
              : Date.now(),
          }),
        );
      }
      pageToken = (response as {nextPageToken?: string}).nextPageToken;
    } while (pageToken);

    return {sessions: adkSessions};
  }

  async deleteSession({
    appName,
    userId: _userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const reasoningEngineId = this.getReasoningEngineId(appName);
    await this.sessions.delete({
      name: `reasoningEngines/${reasoningEngineId}/sessions/${sessionId}`,
    });
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await super.appendEvent({session, event});
    session.lastUpdateTime = event.timestamp;

    const reasoningEngineId = this.getReasoningEngineId(session.appName);

    const customMetadata: Record<string, unknown> = {...event.customMetadata};
    if (isCompactedEvent(event)) {
      customMetadata._compaction = {
        startTime: event.startTime,
        endTime: event.endTime,
        compactedContent: event.compactedContent,
      };
    }
    if (event.usageMetadata) {
      customMetadata._usage_metadata = event.usageMetadata;
    }

    const config = partialCopy<AppendAgentEngineSessionEventConfig>(event, [
      'content',
      'actions',
      'errorCode',
      'errorMessage',
    ]);

    config.eventMetadata = {
      ...partialCopy<EventMetadata>(event, [
        'partial',
        'turnComplete',
        'interrupted',
        'branch',
        'longRunningToolIds',
        'groundingMetadata',
      ]),
      customMetadata:
        Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
    };

    config.rawEvent = JSON.parse(JSON.stringify(event)) as Record<
      string,
      unknown
    >;

    const params: AppendAgentEngineSessionEventRequestParameters = {
      name: `reasoningEngines/${reasoningEngineId}/sessions/${session.id}`,
      author: event.author || 'user',
      invocationId: event.invocationId || `inv-${Date.now()}`,
      timestamp: new Date(event.timestamp).toISOString(),
      config,
    };

    try {
      await this.sessions.events.append(params);
    } catch (error) {
      logger.warn(
        'Failed to append event with rawEvent, falling back...',
        error,
      );
      delete config.rawEvent;
      await this.sessions.events.append({
        name: `reasoningEngines/${reasoningEngineId}/sessions/${session.id}`,
        author: event.author || 'user',
        invocationId: event.invocationId || `inv-${Date.now()}`,
        timestamp: new Date(event.timestamp).toISOString(),
        config,
      });
    }

    return event;
  }
}

interface ExtendedEventActions extends EventActions {
  compaction?: {
    startTime: number;
    endTime: number;
    compactedContent: string;
  };
}

interface ExtendedEvent extends Event {
  actions: ExtendedEventActions;
  isCompacted?: boolean;
  startTime?: number;
  endTime?: number;
  compactedContent?: string;
}

function _fromApiEvent(apiEventObj: VertexAiSessionEvent): Event {
  const rawEvent = apiEventObj.rawEvent;
  if (rawEvent) {
    const event = JSON.parse(JSON.stringify(rawEvent)) as Event;
    event.id = apiEventObj.name?.split('/').pop() || '';
    event.invocationId = apiEventObj.invocationId || '';
    event.author = apiEventObj.author;
    if (apiEventObj.timestamp) {
      event.timestamp = new Date(apiEventObj.timestamp).getTime();
    }
    return event;
  }

  const actions = apiEventObj.actions || {};
  const eventMetadata = apiEventObj.eventMetadata || {};

  let customMetadata = eventMetadata.customMetadata as
    | Record<string, unknown>
    | undefined;
  let compactionData: {
    startTime: number;
    endTime: number;
    compactedContent: string;
  } | null = null;
  let usageMetadataData = null;

  if (customMetadata) {
    if (customMetadata._compaction) {
      compactionData = customMetadata._compaction as {
        startTime: number;
        endTime: number;
        compactedContent: string;
      };
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

  const eventActions: ExtendedEventActions = {
    stateDelta: (actions['stateDelta'] as {[key: string]: unknown}) || {},
    artifactDelta: (actions['artifactDelta'] as {[key: string]: number}) || {},
    requestedAuthConfigs:
      (actions.requestedAuthConfigs as Record<string, unknown>) || {},
    requestedToolConfirmations:
      ((actions as Record<string, unknown>)[
        'requestedToolConfirmations'
      ] as Record<string, ToolConfirmation>) || {},
    skipSummarization: actions['skipSummarization'] as boolean | undefined,
    transferToAgent: actions['transferAgent'] as string | undefined,
    escalate: actions['escalate'] as boolean | undefined,
    compaction: compactionData || undefined,
  };

  const event: ExtendedEvent = {
    id: apiEventObj.name?.split('/').pop() || '',
    invocationId: apiEventObj.invocationId || '',
    author: apiEventObj.author,
    actions: eventActions,
    content: apiEventObj.content as unknown as Content,
    timestamp: apiEventObj.timestamp
      ? new Date(apiEventObj.timestamp).getTime()
      : Date.now(),
    errorCode: apiEventObj.errorCode?.toString(),
    errorMessage: apiEventObj.errorMessage,
    partial: eventMetadata['partial'] as boolean | undefined,
    turnComplete: eventMetadata['turnComplete'] as boolean | undefined,
    interrupted: eventMetadata['interrupted'] as boolean | undefined,
    branch: eventMetadata['branch'] as string | undefined,
    customMetadata,
    longRunningToolIds: eventMetadata['longRunningToolIds'] as
      | string[]
      | undefined,
    usageMetadata:
      usageMetadataData as unknown as GenerateContentResponseUsageMetadata,
  };

  if (compactionData) {
    event.isCompacted = true;
    event.startTime = compactionData.startTime;
    event.endTime = compactionData.endTime;
    event.compactedContent = compactionData.compactedContent;
  }

  return event;
}
