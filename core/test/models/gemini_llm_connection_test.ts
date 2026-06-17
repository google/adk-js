/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Blob,
  Content,
  GroundingMetadata,
  LiveServerGoAway,
  LiveServerMessage,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GeminiLlmConnection} from '../../src/models/gemini_llm_connection.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';

describe('GeminiLlmConnection', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSession: any;
  let messageQueue: AsyncQueue<LiveServerMessage>;

  beforeEach(() => {
    mockSession = {
      sendClientContent: vi.fn(),
      sendToolResponse: vi.fn(),
      sendRealtimeInput: vi.fn(),
      close: vi.fn(),
    };
    messageQueue = new AsyncQueue<LiveServerMessage>();
  });

  describe('sendHistory', () => {
    it('should send history with turnComplete based on role for non-Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const history: Content[] = [
        {role: 'user', parts: [{text: 'hello'}]},
        {role: 'model', parts: [{text: 'hi'}]},
      ];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: history,
        turnComplete: false, // last is model
      });
    });

    it('should send history with turnComplete=true for Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const history: Content[] = [
        {role: 'user', parts: [{text: 'hello'}]},
        {role: 'model', parts: [{text: 'hi'}]},
      ];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: history,
        turnComplete: true,
      });
    });

    it('should not send history if empty', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.sendHistory([]);
      expect(mockSession.sendClientContent).not.toHaveBeenCalled();
    });
  });

  describe('sendContent', () => {
    it('should send tool response if first part is functionResponse', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {
        parts: [
          {
            functionResponse: {
              name: 'tool_a',
              response: {result: 'ok'},
              id: '1',
            },
          },
        ],
      };

      await connection.sendContent(content);

      expect(mockSession.sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [content.parts![0].functionResponse],
      });
    });

    it('should use sendRealtimeInput for Gemini 3.x single-part text', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const content: Content = {
        parts: [{text: 'hello'}],
      };

      await connection.sendContent(content);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        text: 'hello',
      });
    });

    it('should use sendClientContent for non-Gemini 3.x single-part text', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {
        parts: [{text: 'hello'}],
      };

      await connection.sendContent(content);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [content],
        turnComplete: true,
      });
    });

    it('should throw error if content has no parts', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await expect(connection.sendContent({})).rejects.toThrow(
        'Content must have parts.',
      );
    });
  });

  describe('sendRealtime', () => {
    it('should use sendRealtimeInput with media for non-Gemini 3.x/non-Native-Audio', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const blob: Blob = {mimeType: 'audio/pcm', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        media: blob,
      });
    });

    it('should use sendRealtimeInput with audio for Gemini 3.x audio', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const blob: Blob = {mimeType: 'audio/pcm', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        audio: blob,
      });
    });

    it('should use sendRealtimeInput with video for Gemini 3.x image', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const blob: Blob = {mimeType: 'image/jpeg', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        video: blob,
      });
    });

    it('should use sendRealtimeInput with audio for Native Audio model audio', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash-preview-native-audio',
      );
      const blob: Blob = {mimeType: 'audio/pcm', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        audio: blob,
      });
    });

    it('should warn and not send if unknown mime type for Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const blob: Blob = {mimeType: 'text/plain', data: 'data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
    });
  });

  describe('sendActivityStart', () => {
    it('should send activityStart client message', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.sendActivityStart();
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        activityStart: {},
      });
    });
  });

  describe('sendActivityEnd', () => {
    it('should send activityEnd client message', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.sendActivityEnd();
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        activityEnd: {},
      });
    });
  });

  describe('close', () => {
    it('should close the session', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.close();
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('receive', () => {
    it('should throw error if message queue is not provided', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const generator = connection.receive();
      await expect(generator.next()).rejects.toThrow(
        'Message queue is not initialized.',
      );
    });

    it('should yield usage metadata', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      const usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };
      messageQueue.push({usageMetadata});
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        usageMetadata,
        modelVersion: 'gemini-2.5-flash',
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('should stream text and yield full response on turnComplete', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      // Chunk 1: partial text
      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Hello'}],
          },
        },
      });

      // Chunk 2: partial text and turnComplete with interrupted and groundingMetadata
      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{text: ' world!'}],
          },
          turnComplete: true,
          interrupted: false,
          groundingMetadata: {groundingChunks: []} as GroundingMetadata,
        },
      });

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Hello'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        content: {parts: [{text: ' world!'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
        interrupted: false,
      });

      // After turnComplete, it should flush the accumulated text first, including groundingMetadata
      const res3 = await generator.next();
      expect(res3.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Hello world!'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
        groundingMetadata: {groundingChunks: []},
      });

      // Then it yields the turnComplete status with interrupted and groundingMetadata
      const res4 = await generator.next();
      expect(res4.value).toEqual({
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
        interrupted: false,
        groundingMetadata: {groundingChunks: []},
      });

      messageQueue.close();
      expect((await generator.next()).done).toBe(true);
    });

    it('should flush text when transitioning between thought and non-thought', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      // Chunk 1: thought
      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Thinking...', thought: true}],
          },
        },
      });

      // Chunk 2: transition to text
      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Answer is 42.'}],
          },
        },
      });

      messageQueue.push({
        serverContent: {
          turnComplete: true,
        },
      });

      const res1 = await generator.next(); // yields partial thought
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Thinking...', thought: true}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res2 = await generator.next(); // transitions, flushes 'Thinking...' as full thought
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Thinking...', thought: true}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next(); // yields partial text 'Answer is 42.'
      expect(res3.value).toEqual({
        content: {parts: [{text: 'Answer is 42.'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res4 = await generator.next(); // turnComplete flushes 'Answer is 42.' as full text
      expect(res4.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Answer is 42.'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res5 = await generator.next(); // yields turnComplete
      expect(res5.value).toEqual({
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      });

      messageQueue.close();
      expect((await generator.next()).done).toBe(true);
    });

    it('should handle input transcription partial and finished', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        serverContent: {
          inputTranscription: {text: 'hello', finished: false},
        },
      });

      messageQueue.push({
        serverContent: {
          inputTranscription: {text: ' world', finished: true},
        },
      });

      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        inputTranscription: {text: 'hello', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        inputTranscription: {text: ' world', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next();
      expect(res3.value).toEqual({
        inputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should flush pending transcription on interrupted', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        serverContent: {
          inputTranscription: {text: 'hello', finished: false},
        },
      });

      messageQueue.push({
        serverContent: {
          interrupted: true,
        },
      });
      messageQueue.close();

      const res1 = await generator.next(); // partial transcription
      expect(res1.value.inputTranscription).toEqual({
        text: 'hello',
        finished: false,
      });

      const res2 = await generator.next(); // flush transcription on interrupted
      expect(res2.value).toEqual({
        inputTranscription: {text: 'hello', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next(); // interrupted status
      expect(res3.value).toEqual({
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield groundingMetadata on partial response if turnComplete is not true', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Partial text'}],
          },
          groundingMetadata: {
            groundingChunks: [
              {web: {uri: 'https://google.com', title: 'Google'}},
            ],
          } as GroundingMetadata,
        },
      });
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Partial text'}]},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
        groundingMetadata: {
          groundingChunks: [
            {web: {uri: 'https://google.com', title: 'Google'}},
          ],
        },
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield standalone groundingMetadata when content is empty and turnComplete is not true', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        serverContent: {
          groundingMetadata: {
            groundingChunks: [
              {web: {uri: 'https://google.com', title: 'Google'}},
            ],
          } as GroundingMetadata,
          turnComplete: false,
          interrupted: false,
        },
      });
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        groundingMetadata: {
          groundingChunks: [
            {web: {uri: 'https://google.com', title: 'Google'}},
          ],
        },
        interrupted: false,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should flush accumulated text when receiving a non-text modelTurn part', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      // Push text part
      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Hello'}],
          },
        },
      });

      // Push non-text part (e.g. functionCall inside modelTurn parts)
      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
          },
        },
      });
      messageQueue.close();

      // First yield: the partial response for 'Hello'
      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Hello'}]},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      // Second yield: should flush 'Hello' as a full text response
      const res2 = await generator.next();
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Hello'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      // Third yield: the modelTurn response with the functionCall
      const res3 = await generator.next();
      expect(res3.value).toEqual({
        content: {
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should buffer tool calls and yield at turnComplete for non-Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        toolCall: {
          functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
        },
      });

      messageQueue.push({
        serverContent: {
          turnComplete: true,
        },
      });

      // For non-Gemini 3.x, tool call is buffered.
      // So we don't get anything on toolCall message (except if there was text, but there isn't).
      // On turnComplete, it should yield the aggregated tool calls first, then turnComplete.
      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      });

      messageQueue.close();
      expect((await generator.next()).done).toBe(true);
    });

    it('should yield tool calls immediately for Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        toolCall: {
          functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
        },
      });

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-3.1-flash-live',
      });

      messageQueue.close();
      expect((await generator.next()).done).toBe(true);
    });

    it('should yield session resumption update', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      const resumptionUpdate = {resumed: true};
      messageQueue.push({sessionResumptionUpdate: resumptionUpdate});
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        liveSessionResumptionUpdate: resumptionUpdate,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield go away', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      const goAway = {goAway: true}; // mock
      messageQueue.push({goAway: goAway as LiveServerGoAway});
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        goAway,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield pending tool calls on queue close', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        toolCall: {
          functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
        },
      });
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('should handle undefined modelVersion in isGemini3xFlashLive check', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        undefined,
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        toolCall: {
          functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
        },
      });
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield accumulated text on interrupted', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Hello'}],
          },
        },
      });

      messageQueue.push({
        serverContent: {
          interrupted: true,
        },
      });
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Hello'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Hello'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield accumulated text on tool call', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Hello'}],
          },
        },
      });

      messageQueue.push({
        toolCall: {
          functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
        },
      });
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Hello'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Hello'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next();
      expect(res3.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should handle output transcription partial and finished', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        serverContent: {
          outputTranscription: {text: 'hello', finished: false},
        },
      });

      messageQueue.push({
        serverContent: {
          outputTranscription: {text: ' world', finished: true},
        },
      });

      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        outputTranscription: {text: 'hello', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        outputTranscription: {text: ' world', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next();
      expect(res3.value).toEqual({
        outputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should flush pending output transcription on interrupted', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({
        serverContent: {
          outputTranscription: {text: 'hello', finished: false},
        },
      });

      messageQueue.push({
        serverContent: {
          interrupted: true,
        },
      });
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value.outputTranscription).toEqual({
        text: 'hello',
        finished: false,
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        outputTranscription: {text: 'hello', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next();
      expect(res3.value).toEqual({
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });
  });
});
