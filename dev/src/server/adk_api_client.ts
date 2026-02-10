/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '@google/adk';
import {Session} from '@google/adk';
import {Content, createUserContent} from '@google/genai';

/**
 * ADK web client config interface.
 */
export interface AdkApiClientConfig {
  backendUrl: string;
}

/**
 * Run agent request interface.
 */
export interface RunAgentRequest {
  appName: string;
  userId: string;
  sessionId: string;
  newMessage: Content | string;
  streaming: boolean;
  stateDelta: Record<string, unknown>;
}

/**
 * ADK web client class.
 */
export class AdkApiClient {
  private readonly backendUrl: string;

  constructor(config: AdkApiClientConfig) {
    this.backendUrl = config.backendUrl;
  }

  async listApps(): Promise<string[]> {
    return this.fetch<string[]>(`${this.backendUrl}/list-apps`);
  }

  async getSession(params: {
    appName: string;
    userId: string;
    sessionId: string;
  }): Promise<Session> {
    return this.fetch<Session>(
      `${this.backendUrl}/apps/${params.appName}/users/${params.userId}/sessions/${params.sessionId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }

  async createSession(params: {
    appName: string;
    userId: string;
    sessionId?: string;
    state?: Record<string, unknown>;
  }): Promise<Session> {
    let url = `${this.backendUrl}/apps/${params.appName}/users/${params.userId}/sessions`;
    if (params.sessionId) {
      url += `/${params.sessionId}`;
    }
    return this.fetch<Session>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: params.state,
      }),
    });
  }

  async deleteSession(params: {
    appName: string;
    userId: string;
    sessionId: string;
  }): Promise<void> {
    return this.fetch<void>(
      `${this.backendUrl}/apps/${params.appName}/users/${params.userId}/sessions/${params.sessionId}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }

  async listAllSessions(params: {userId: string}): Promise<Session[]> {
    const apps = await this.listApps();

    return Promise.all(
      apps.map((appName) =>
        this.listSessions({appName, userId: params.userId}),
      ),
    ).then((sessions) => sessions.flat());
  }

  async listSessions(params: {
    appName: string;
    userId: string;
  }): Promise<Session[]> {
    const sessions = await this.fetch<Session[] | {sessions: Session[]}>(
      `${this.backendUrl}/apps/${params.appName}/users/${params.userId}/sessions`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    if ('sessions' in sessions) {
      return sessions.sessions;
    }

    return sessions;
  }

  async *runAsync(
    params: RunAgentRequest,
  ): AsyncGenerator<Event, void, undefined> {
    const response = await fetch(`${this.backendUrl}/run_sse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appName: params.appName,
        userId: params.userId,
        sessionId: params.sessionId,
        streaming: params.streaming,
        stateDelta: params.stateDelta,
        newMessage:
          typeof params.newMessage === 'string'
            ? createUserContent(params.newMessage)
            : params.newMessage,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        error.error || `Request failed with status ${response.status}`,
      );
    }

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? ''; // The last part might be incomplete.

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.substring('data: '.length));

          if ((data as {error: string}).error) {
            throw new Error((data as {error: string}).error);
          }

          yield data as Event;
        }
      }
    }
  }

  async listArtifacts(params: {
    appName: string;
    userId: string;
    sessionId: string;
  }): Promise<Array<{filename: string}>> {
    return this.fetch<Array<{filename: string}>>(
      `${this.backendUrl}/apps/${params.appName}/users/${params.userId}/sessions/${params.sessionId}/artifacts`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }

  async loadArtifact(params: {
    appName: string;
    userId: string;
    sessionId: string;
    artifactName: string;
    version?: number;
  }): Promise<unknown> {
    let url = `${this.backendUrl}/apps/${params.appName}/users/${params.userId}/sessions/${params.sessionId}/artifacts/${params.artifactName}`;
    if (params.version !== undefined) {
      url += `/versions/${params.version}`;
    }
    return this.fetch<unknown>(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async listArtifactVersions(params: {
    appName: string;
    userId: string;
    sessionId: string;
    artifactName: string;
  }): Promise<number[]> {
    const url = `${this.backendUrl}/apps/${params.appName}/users/${params.userId}/sessions/${params.sessionId}/artifacts/${params.artifactName}/versions`;
    return this.fetch<number[]>(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async deleteArtifact(params: {
    appName: string;
    userId: string;
    sessionId: string;
    artifactName: string;
  }): Promise<void> {
    const url = `${this.backendUrl}/apps/${params.appName}/users/${params.userId}/sessions/${params.sessionId}/artifacts/${params.artifactName}`;
    return this.fetch<void>(url, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private async fetch<T = unknown>(
    url: string,
    // eslint-disable-next-line no-undef
    options?: RequestInit,
  ): Promise<T> {
    const response = await fetch(url, options);

    if (!response.ok) {
      let error;
      try {
        error = await response.json();
      } catch (_e: unknown) {
        // Body is not json or empty
      }
      throw new Error(
        error?.error ?? `Request failed with status ${response.status}`,
      );
    }

    return response.json();
  }
}
