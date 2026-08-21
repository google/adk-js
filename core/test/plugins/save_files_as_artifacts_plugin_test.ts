/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {ArtifactVersion} from '../../src/artifacts/base_artifact_service.js';
import {InMemoryArtifactService} from '../../src/artifacts/in_memory_artifact_service.js';
import {SessionArtifactService} from '../../src/artifacts/session_artifact_service.js';
import {createEvent} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {
  SaveFilesAsArtifactsPlugin,
  SaveFilesAsArtifactsPluginOptions,
} from '../../src/plugins/save_files_as_artifacts_plugin.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {createSession, Session} from '../../src/sessions/session.js';

describe('SaveFilesAsArtifactsPlugin', () => {
  let plugin: SaveFilesAsArtifactsPlugin;
  let mockArtifactService: SessionArtifactService;
  let mockSession: Session;
  let mockContext: InvocationContext;

  beforeEach(() => {
    plugin = new SaveFilesAsArtifactsPlugin();

    mockSession = createSession({
      id: 'test_session',
      appName: 'test_app',
      userId: 'test_user',
      state: {},
      events: [],
    });

    mockArtifactService = {
      saveArtifact: vi.fn().mockResolvedValue(0),
      loadArtifact: vi.fn(),
      listArtifactKeys: vi.fn().mockResolvedValue([]),
      deleteArtifact: vi.fn().mockResolvedValue(undefined),
      listVersions: vi.fn().mockResolvedValue([0]),
      listArtifactVersions: vi.fn().mockResolvedValue([]),
      getArtifactVersion: vi.fn().mockImplementation(
        async ({
          filename,
          version,
        }: {
          filename: string;
          version?: number;
        }): Promise<ArtifactVersion> => ({
          version: version ?? 0,
          canonicalUri: `gs://mock-bucket/${filename}/versions/${version ?? 0}`,
          mimeType: 'application/pdf',
        }),
      ),
    };

    mockContext = {
      invocationId: 'test_invocation_123',
      appName: 'test_app',
      userId: 'test_user',
      session: mockSession,
      artifactService: mockArtifactService,
    } as unknown as InvocationContext;
  });

  it('test_save_files_with_display_name', async () => {
    const originalPart: Part = {
      inlineData: {
        displayName: 'test_document.pdf',
        data: 'test data',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {
      role: 'user',
      parts: [originalPart],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
      filename: 'test_document.pdf',
      artifact: originalPart,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test_document.pdf"]',
    );
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![1].fileData!.fileUri).toBe(
      'gs://mock-bucket/test_document.pdf/versions/0',
    );
    expect(result!.parts![1].fileData!.displayName).toBe('test_document.pdf');
    expect(result!.parts![1].fileData!.mimeType).toBe('application/pdf');
  });

  it('test_attach_file_reference_false', async () => {
    const customPlugin = new SaveFilesAsArtifactsPlugin({
      attachFileReference: false,
    });

    const originalPart: Part = {
      inlineData: {
        displayName: 'test_document.pdf',
        data: 'test data',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {
      role: 'user',
      parts: [originalPart],
    };

    const result = await customPlugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
      filename: 'test_document.pdf',
      artifact: originalPart,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test_document.pdf"]',
    );
  });

  it('test_save_files_without_display_name', async () => {
    const originalPart: Part = {
      inlineData: {
        displayName: undefined,
        data: 'test data',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {
      role: 'user',
      parts: [originalPart],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    const expectedFilename = 'artifact_test_invocation_123_0';
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
      filename: expectedFilename,
      artifact: originalPart,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![0].text).toBe(
      `[Uploaded Artifact: "${expectedFilename}"]`,
    );
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![1].fileData!.fileUri).toBe(
      `gs://mock-bucket/${expectedFilename}/versions/0`,
    );
    expect(result!.parts![1].fileData!.displayName).toBe(expectedFilename);
  });

  it('test_multiple_files_in_message', async () => {
    const inlineData1 = {
      displayName: 'file1.txt',
      data: 'file1 content',
      mimeType: 'text/plain',
    };
    const inlineData2 = {
      displayName: 'file2.jpg',
      data: 'file2 content',
      mimeType: 'image/jpeg',
    };

    vi.mocked(mockArtifactService.getArtifactVersion).mockImplementation(
      async ({filename, version}) => ({
        version: version ?? 0,
        canonicalUri: `gs://mock-bucket/${filename}/versions/${version ?? 0}`,
        mimeType: filename.endsWith('.txt') ? 'text/plain' : 'image/jpeg',
      }),
    );

    const userMessage: Content = {
      role: 'user',
      parts: [
        {inlineData: inlineData1},
        {text: 'Some text between files'},
        {inlineData: inlineData2},
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(2);
    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(5);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "file1.txt"]');
    expect(result!.parts![1].fileData!.fileUri).toBe(
      'gs://mock-bucket/file1.txt/versions/0',
    );
    expect(result!.parts![1].fileData!.displayName).toBe('file1.txt');
    expect(result!.parts![2].text).toBe('Some text between files');
    expect(result!.parts![3].text).toBe('[Uploaded Artifact: "file2.jpg"]');
    expect(result!.parts![4].fileData!.fileUri).toBe(
      'gs://mock-bucket/file2.jpg/versions/0',
    );
    expect(result!.parts![4].fileData!.displayName).toBe('file2.jpg');
  });

  it('test_no_artifact_service', async () => {
    const contextWithoutArtifactService = {
      ...mockContext,
      artifactService: undefined,
    } as unknown as InvocationContext;

    const inlineData = {
      displayName: 'test.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: contextWithoutArtifactService,
      userMessage,
    });

    expect(result).toBe(userMessage);
    expect(result!.parts![0].inlineData).toEqual(inlineData);
    expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
  });

  it('test_no_parts_in_message', async () => {
    const userMessage: Content = {
      role: 'user',
      parts: [],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
  });

  it('test_parts_without_inline_data', async () => {
    const userMessage: Content = {
      role: 'user',
      parts: [{text: 'Hello world'}, {text: 'No files here'}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
  });

  it('test_save_artifact_failure', async () => {
    vi.mocked(mockArtifactService.saveArtifact).mockRejectedValueOnce(
      new Error('Storage error'),
    );

    const inlineData = {
      displayName: 'test.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
  });

  it('test_mixed_success_and_failure', async () => {
    let callCount = 0;
    vi.mocked(mockArtifactService.saveArtifact).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Storage error on second file');
      }
      return 0;
    });

    const inlineData1 = {
      displayName: 'success.pdf',
      data: 'success data',
      mimeType: 'application/pdf',
    };
    const inlineData2 = {
      displayName: 'failure.pdf',
      data: 'failure data',
      mimeType: 'application/pdf',
    };

    const originalPart2: Part = {inlineData: inlineData2};
    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData: inlineData1}, originalPart2],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(3);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "success.pdf"]');
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![2]).toEqual(originalPart2);
    expect(result!.parts![2].inlineData).toEqual(inlineData2);
  });

  it('test_placeholder_text_format', async () => {
    const inlineData = {
      displayName: 'test file with spaces.docx',
      data: 'document data',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test file with spaces.docx"]',
    );
    expect(result!.parts![1].fileData).toBeDefined();
  });

  it('test_plugin_name_default_and_custom', () => {
    const defaultPlugin = new SaveFilesAsArtifactsPlugin();
    expect(defaultPlugin.name).toBe('save_files_as_artifacts_plugin');

    const customStringPlugin = new SaveFilesAsArtifactsPlugin('custom_saver');
    expect(customStringPlugin.name).toBe('custom_saver');

    const options: SaveFilesAsArtifactsPluginOptions = {
      name: 'options_saver',
      attachFileReference: false,
    };
    const customOptionsPlugin = new SaveFilesAsArtifactsPlugin(options);
    expect(customOptionsPlugin.name).toBe('options_saver');
  });

  it('test_file_size_exceeds_limit', async () => {
    // Create a file larger than 20MB (21 MB)
    const largeFileData = 'x'.repeat(21 * 1024 * 1024);
    const inlineData = {
      displayName: 'large_file.pdf',
      data: largeFileData,
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toContain('[Upload Error:');
    expect(result!.parts![0].text).toContain('large_file.pdf');
    expect(result!.parts![0].text).toContain(
      'exceeds the maximum supported size of 20MB',
    );
  });

  it('test_file_size_at_limit', async () => {
    // Exactly 20MB
    const fileData = 'x'.repeat(20 * 1024 * 1024);
    const inlineData = {
      displayName: 'max_size_file.pdf',
      data: fileData,
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "max_size_file.pdf"]',
    );
    expect(result!.parts![1].fileData).toBeDefined();
  });

  it('test_file_size_just_over_limit', async () => {
    // 20MB + 1 byte
    const largeFileData = 'x'.repeat(20 * 1024 * 1024 + 1);
    const inlineData = {
      displayName: 'slightly_too_large.pdf',
      data: largeFileData,
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toContain('[Upload Error:');
    expect(result!.parts![0].text).toContain('slightly_too_large.pdf');
    expect(result!.parts![0].text).toContain(
      'exceeds the maximum supported size of 20MB',
    );
  });

  it('test_mixed_file_sizes', async () => {
    const smallFileData = 'x'.repeat(5 * 1024 * 1024); // 5 MB
    const largeFileData = 'x'.repeat(25 * 1024 * 1024); // 25 MB

    const smallInlineData = {
      displayName: 'small.pdf',
      data: smallFileData,
      mimeType: 'application/pdf',
    };
    const largeInlineData = {
      displayName: 'large.pdf',
      data: largeFileData,
      mimeType: 'application/pdf',
    };

    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData: smallInlineData}, {inlineData: largeInlineData}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    // Should only save the small file
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
      filename: 'small.pdf',
      artifact: {inlineData: smallInlineData},
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(3); // [small placeholder, small file_data, large error]
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "small.pdf"]');
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![2].text).toContain('[Upload Error:');
    expect(result!.parts![2].text).toContain('large.pdf');
  });

  it('test_non_model_accessible_uri_does_not_attach_file_data', async () => {
    vi.mocked(mockArtifactService.getArtifactVersion).mockResolvedValueOnce({
      version: 0,
      canonicalUri: 'file:///tmp/artifacts/local_file.pdf',
      mimeType: 'application/pdf',
    });

    const originalPart: Part = {
      inlineData: {
        displayName: 'local_file.pdf',
        data: 'test data',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {
      role: 'user',
      parts: [originalPart],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "local_file.pdf"]',
    );
  });

  it('test_artifact_delta_reporting_multi_turn', async () => {
    const mockAgent = {name: 'test_agent'} as BaseAgent;

    // 1. First Turn - Trigger user message callback
    const blob1 = {
      displayName: 'blob1.pdf',
      data: 'test data 1',
      mimeType: 'application/pdf',
    };
    const userMessage1: Content = {
      role: 'user',
      parts: [{inlineData: blob1}],
    };

    await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage: userMessage1,
    });

    // Verify state is updated
    const key = 'save_files_as_artifacts_plugin:pending_delta';
    expect(mockContext.session.state[key]).toEqual({'blob1.pdf': 0});

    // 2. First Turn - Trigger before agent callback
    const eventActions1 = createEventActions();
    const callbackContext1 = new Context({
      invocationContext: mockContext,
      eventActions: eventActions1,
    });

    await plugin.beforeAgentCallback({
      agent: mockAgent,
      callbackContext: callbackContext1,
    });

    // Verify artifactDelta is updated and pending delta state is cleared
    expect(callbackContext1.actions.artifactDelta).toEqual({'blob1.pdf': 0});
    expect(mockContext.session.state[key]).toEqual({});

    // 3. Second Turn - Trigger user message callback
    const blob2 = {
      displayName: 'blob2.pdf',
      data: 'test data 2',
      mimeType: 'application/pdf',
    };
    const userMessage2: Content = {
      role: 'user',
      parts: [{inlineData: blob2}],
    };

    await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage: userMessage2,
    });

    // Verify state is updated for turn 2
    expect(mockContext.session.state[key]).toEqual({'blob2.pdf': 0});

    // 4. Second Turn - Trigger before agent callback
    const eventActions2 = createEventActions();
    const callbackContext2 = new Context({
      invocationContext: mockContext,
      eventActions: eventActions2,
    });

    await plugin.beforeAgentCallback({
      agent: mockAgent,
      callbackContext: callbackContext2,
    });

    // Verify artifactDelta is updated for turn 2 and state is cleared
    expect(callbackContext2.actions.artifactDelta).toEqual({'blob2.pdf': 0});
    expect(mockContext.session.state[key]).toEqual({});
  });

  it('test_runner_end_to_end_integration', async () => {
    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();

    class TestAgent extends LlmAgent {
      constructor() {
        super({
          name: 'test_agent',
          model: 'gemini-2.5-flash',
        });
      }

      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<import('../../src/events/event.js').Event, void, void> {
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {role: 'model', parts: [{text: 'Done processing file'}]},
        });
      }
    }

    const testAgent = new TestAgent();
    const saveFilesPlugin = new SaveFilesAsArtifactsPlugin();

    const runner = new Runner({
      appName: 'test_app',
      agent: testAgent,
      sessionService,
      artifactService,
      plugins: [saveFilesPlugin],
    });

    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });

    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'JVBERi0xLjQ...',
            displayName: 'upload.pdf',
          },
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage,
    })) {
      // Consume stream
    }

    const updatedSession = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });

    expect(updatedSession).toBeDefined();
    // User event was transformed by plugin
    const userEvent = updatedSession!.events[0];
    expect(userEvent.content!.parts![0].text).toBe(
      '[Uploaded Artifact: "upload.pdf"]',
    );
    // Agent event carries the artifactDelta flushed via beforeAgentCallback
    const agentDeltaEvent = updatedSession!.events.find(
      (e) =>
        e.actions?.artifactDelta &&
        Object.keys(e.actions.artifactDelta).length > 0,
    );
    expect(agentDeltaEvent).toBeDefined();
    expect(agentDeltaEvent!.actions!.artifactDelta).toEqual({'upload.pdf': 0});
  });
});
