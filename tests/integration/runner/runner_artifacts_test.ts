/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

class SimulatedGcsArtifactService extends InMemoryArtifactService {
  override async getArtifactVersion(request: {
    appName: string;
    userId: string;
    sessionId: string;
    filename: string;
    version?: number;
  }) {
    const versionMeta = await super.getArtifactVersion(request);
    if (!versionMeta) {
      return undefined;
    }
    return {
      ...versionMeta,
      canonicalUri: `gs://simulated-gcs-bucket/${request.appName}/${request.userId}/${request.sessionId}/${request.filename}/v${versionMeta.version}`,
    };
  }
}

class RecordingMockAgent extends LlmAgent {
  public receivedHistory: Content[] = [];

  constructor(name: string) {
    super({
      name,
      model: 'gemini-2.5-flash',
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Record what history was in the session when this agent ran
    this.receivedHistory = (context.session?.events || [])
      .map((e) => e.content)
      .filter((c): c is Content => !!c);

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: `Response from ${this.name}`}]},
    });
  }
}

describe('Integration: Runner Artifact Saving & LLM Exposure', () => {
  it('should save inline blobs, replace with bracketed token and fileData, and maintain clean conversation history across turns', async () => {
    const sessionService = new InMemorySessionService();
    const artifactService = new SimulatedGcsArtifactService();
    const agent = new RecordingMockAgent('test_agent');
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
      artifactService,
    });

    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });

    // Turn 1: User sends message with inline PDF document
    const turn1Message: Content = {
      role: 'user',
      parts: [
        {text: 'Here is the quarterly financial report:'},
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'JVBERi0xLjQ...',
            displayName: 'quarterly_report.pdf',
          },
        } as unknown as Part,
      ],
    };

    const turn1Events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: turn1Message,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      turn1Events.push(event);
    }

    // Check session events right after Turn 1
    const updatedSession = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });

    expect(updatedSession).not.toBeNull();
    const userEvent = updatedSession!.events.find((e) => e.author === 'user');
    expect(userEvent).toBeDefined();

    // Verify the parts in session event
    const userParts = userEvent!.content!.parts!;
    expect(userParts[0]).toEqual({
      text: 'Here is the quarterly financial report:',
    });
    expect(userParts[1]).toEqual({
      text: '[Uploaded Artifact: "quarterly_report.pdf"]',
    });
    expect(userParts[2]).toEqual({
      fileData: {
        fileUri:
          'gs://simulated-gcs-bucket/test_app/test_user/test_session/quarterly_report.pdf/v0',
        mimeType: 'application/pdf',
        displayName: 'quarterly_report.pdf',
      },
    });

    // Verify no legacy "It is saved into artifacts" strings exist anywhere in session history
    const sessionHistoryText = JSON.stringify(updatedSession!.events);
    expect(sessionHistoryText).not.toContain('It is saved into artifacts');

    // Turn 2: User asks follow-up question
    const turn2Message: Content = {
      role: 'user',
      parts: [{text: 'What was the revenue mentioned in the report above?'}],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: turn2Message,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // Consume stream
    }

    // Check the history that the agent received during Turn 2
    expect(agent.receivedHistory.length).toBeGreaterThanOrEqual(2);
    const firstTurnHistory = agent.receivedHistory.find(
      (c) =>
        c.role === 'user' &&
        c.parts?.some((p) => p.text?.includes('quarterly_report.pdf')),
    );
    expect(firstTurnHistory).toBeDefined();

    const historyParts = firstTurnHistory!.parts!;
    expect(historyParts[1]).toEqual({
      text: '[Uploaded Artifact: "quarterly_report.pdf"]',
    });
    expect(historyParts[2].fileData?.fileUri).toContain(
      'gs://simulated-gcs-bucket/',
    );
  });
});
