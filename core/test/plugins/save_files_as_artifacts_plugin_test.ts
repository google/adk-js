/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createEvent,
  createSession,
  DeleteArtifactRequest,
  Event,
  InMemoryArtifactService,
  InvocationContext,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LlmAgent,
  LoadArtifactRequest,
  PluginManager,
  SaveArtifactRequest,
  SaveFilesAsArtifactsPlugin,
  Session,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

function makeMockLogger() {
  const infoCalls: string[] = [];
  const warnCalls: string[] = [];
  const errorCalls: string[] = [];
  const mockLogger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: (...args: unknown[]) => {
      infoCalls.push(args.map((a) => String(a)).join(' '));
    },
    warn: (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(' '));
    },
    error: (...args: unknown[]) => {
      errorCalls.push(args.map((a) => String(a)).join(' '));
    },
  };
  return {mockLogger, infoCalls, warnCalls, errorCalls};
}

class MockAgent extends LlmAgent {
  constructor(name = 'mock_agent') {
    super({
      name,
      model: 'gemini-2.5-flash',
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Done'}]},
    });
  }
}

describe('SaveFilesAsArtifactsPlugin', () => {
  let infoCalls: string[];
  let warnCalls: string[];
  let errorCalls: string[];

  const mockAgent = new MockAgent('test_agent');
  let mockSession: Session;

  let baseArtifactService: InMemoryArtifactService;
  let scopedArtifactService: ScopedArtifactService;
  let invocationContext: InvocationContext;
  let callbackContext: Context;

  beforeEach(() => {
    const {
      mockLogger,
      infoCalls: callsInfo,
      warnCalls: callsWarn,
      errorCalls: callsError,
    } = makeMockLogger();
    infoCalls = callsInfo;
    warnCalls = callsWarn;
    errorCalls = callsError;
    setLogger(mockLogger);

    mockSession = createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'user-1',
    });

    baseArtifactService = new InMemoryArtifactService();
    const wrappedArtifactService = {
      saveArtifact: (req: SaveArtifactRequest) =>
        baseArtifactService.saveArtifact(req),
      loadArtifact: (req: LoadArtifactRequest) =>
        baseArtifactService.loadArtifact(req),
      listArtifactKeys: (req: ListArtifactKeysRequest) =>
        baseArtifactService.listArtifactKeys(req),
      deleteArtifact: (req: DeleteArtifactRequest) =>
        baseArtifactService.deleteArtifact(req),
      listVersions: (req: ListVersionsRequest) =>
        baseArtifactService.listVersions(req),
      listArtifactVersions: (req: ListVersionsRequest) =>
        baseArtifactService.listArtifactVersions(req),
      getArtifactVersion: async (req: LoadArtifactRequest) => {
        const v = await baseArtifactService.getArtifactVersion(req);
        if (v) {
          return {
            ...v,
            canonicalUri: `gs://bucket/${req.filename}/versions/${v.version}`,
            mimeType: 'application/pdf',
          };
        }
        return v;
      },
    } as unknown as InMemoryArtifactService;

    scopedArtifactService = new ScopedArtifactService(
      wrappedArtifactService,
      'test-app',
      'user-1',
      'session-1',
    );

    invocationContext = new InvocationContext({
      invocationId: 'inv-1',
      session: mockSession,
      agent: mockAgent,
      pluginManager: new PluginManager(),
      artifactService: scopedArtifactService,
    });

    callbackContext = new Context({
      invocationContext,
    });
  });

  afterEach(() => {
    resetLogger();
    vi.restoreAllMocks();
  });

  it('testSaveFilesWithDisplayName', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    const userMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'YmFzZTY0ZGF0YQ==',
            displayName: 'report.pdf',
          },
        },
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.role).toBe('user');
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![0]).toEqual({
      text: '[Uploaded Artifact: "report.pdf"]',
    });
    expect(result!.parts![1].fileData).toEqual({
      fileUri: 'gs://bucket/report.pdf/versions/0',
      mimeType: 'application/pdf',
      displayName: 'report.pdf',
    });

    const saved = await scopedArtifactService.loadArtifact({
      filename: 'report.pdf',
    });
    expect(saved).toBeDefined();
    expect(saved!.inlineData!.displayName).toBe('report.pdf');
  });

  it('testSaveFilesWithoutDisplayName', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    const userMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'aW1hZ2VkYXRh',
          },
        },
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeDefined();
    const expectedFilename = 'artifact_inv-1_0';
    expect(result!.parts![0]).toEqual({
      text: `[Uploaded Artifact: "${expectedFilename}"]`,
    });
    expect(infoCalls.some((c) => c.includes('No displayName found'))).toBe(
      true,
    );

    const saved = await scopedArtifactService.loadArtifact({
      filename: expectedFilename,
    });
    expect(saved).toBeDefined();
  });

  it('testAttachFileReferenceFalse', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin({
      attachFileReference: false,
    });
    const userMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'YmFzZTY0ZGF0YQ==',
            displayName: 'report.pdf',
          },
        },
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0]).toEqual({
      text: '[Uploaded Artifact: "report.pdf"]',
    });
  });

  it('testMultipleFilesInMessage', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    const userMessage: Content = {
      role: 'user',
      parts: [
        {text: 'Here is document 1 and 2:'},
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'ZG9jMQ==',
            displayName: 'doc1.pdf',
          },
        },
        {text: 'and'},
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'ZG9jMg==',
            displayName: 'doc2.pdf',
          },
        },
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(6);
    expect(result!.parts![0]).toEqual({text: 'Here is document 1 and 2:'});
    expect(result!.parts![1]).toEqual({
      text: '[Uploaded Artifact: "doc1.pdf"]',
    });
    expect(result!.parts![2].fileData?.displayName).toBe('doc1.pdf');
    expect(result!.parts![3]).toEqual({text: 'and'});
    expect(result!.parts![4]).toEqual({
      text: '[Uploaded Artifact: "doc2.pdf"]',
    });
    expect(result!.parts![5].fileData?.displayName).toBe('doc2.pdf');
  });

  it('testArtifactServiceMissing', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    const ctxNoArtifact = new InvocationContext({
      invocationId: 'inv-1',
      session: mockSession,
      agent: mockAgent,
      pluginManager: new PluginManager(),
      artifactService: undefined,
    });

    const userMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'ZGF0YQ==',
            displayName: 'doc.pdf',
          },
        },
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: ctxNoArtifact,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(
      warnCalls.some((c) => c.includes('Artifact service is not set')),
    ).toBe(true);
  });

  it('testSaveArtifactFailure', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    vi.spyOn(scopedArtifactService, 'saveArtifact').mockRejectedValueOnce(
      new Error('Storage full'),
    );

    const inlinePart: Part = {
      inlineData: {
        mimeType: 'application/pdf',
        data: 'ZGF0YQ==',
        displayName: 'broken.pdf',
      },
    };
    const userMessage: Content = {
      role: 'user',
      parts: [{text: 'file below'}, inlinePart],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(
      errorCalls.some((c) =>
        c.includes('Failed to save artifact for part 1: Error: Storage full'),
      ),
    ).toBe(true);
  });

  it('testBeforeAgentCallbackDeltaMerge', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    const userMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'ZGF0YQ==',
            displayName: 'report.pdf',
          },
        },
      ],
    };

    await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    const pendingKey = `${plugin.name}:pending_delta`;
    expect(mockSession.state[pendingKey]).toEqual({'report.pdf': 0});

    await plugin.beforeAgentCallback({
      agent: mockAgent,
      callbackContext,
    });

    expect(callbackContext.actions.artifactDelta).toEqual({'report.pdf': 0});
    expect(mockSession.state[pendingKey]).toEqual({});
  });

  it('testEmptyOrMissingParts', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    const resEmpty = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: {role: 'user', parts: []},
    });
    expect(resEmpty).toBeUndefined();

    const resNoParts = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: {role: 'user'} as unknown as Content,
    });
    expect(resNoParts).toBeUndefined();
  });

  it('testBuildFileReferencePartFailureAndInaccessibleUri', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    vi.spyOn(scopedArtifactService, 'getArtifactVersion')
      .mockRejectedValueOnce(new Error('Resolve error'))
      .mockResolvedValueOnce({
        version: 0,
        canonicalUri: 'file:///local/path',
        mimeType: 'application/pdf',
      })
      .mockResolvedValueOnce({
        version: 0,
        canonicalUri: 'not-a-valid-url',
        mimeType: 'application/pdf',
      })
      .mockResolvedValueOnce({
        version: 0,
      })
      .mockResolvedValueOnce({
        version: 0,
        canonicalUri: 'gs://bucket/doc5.pdf/versions/0',
        mimeType: 'application/octet-stream',
      });

    const userMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'ZGF0YQ==',
            displayName: 'doc1.pdf',
          },
        },
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'ZGF0YQ==',
            displayName: 'doc2.pdf',
          },
        },
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'ZGF0YQ==',
            displayName: 'doc3.pdf',
          },
        },
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'ZGF0YQ==',
            displayName: 'doc4.pdf',
          },
        },
        {
          inlineData: {
            mimeType: '' as unknown as string,
            data: 'ZGF0YQ==',
            displayName: 'doc5.pdf',
          },
        },
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });
    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(6);
    expect(result!.parts![5].fileData?.mimeType).toBe(
      'application/octet-stream',
    );
    expect(
      warnCalls.some((c) =>
        c.includes('Failed to resolve artifact version for doc1.pdf'),
      ),
    ).toBe(true);
  });
});
