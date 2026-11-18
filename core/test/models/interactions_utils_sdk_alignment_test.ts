/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FinishReason,
  GoogleGenAI,
  Interactions,
  Language,
  Outcome,
  Part,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  convertContentToSteps,
  convertInteractionEventToLlmResponse,
  convertInteractionToLlmResponse,
  ExtendedInteraction,
  ExtendedInteractionSSEEvent,
  generateContentViaInteractions,
} from '../../src/models/interactions_utils.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {logger} from '../../src/utils/logger.js';

describe('interactions_utils SDK alignment', () => {
  describe('convertInteractionToLlmResponse', () => {
    it('reads errors[0] from Interactions.Interaction on failed status', () => {
      const interaction = {
        id: 'int-failed-1',
        status: 'failed',
        errors: [
          {
            code: 'RESOURCE_EXHAUSTED',
            message: 'Rate limit exceeded',
          },
          {
            code: 'SECONDARY_ERROR',
            message: 'Ignored secondary error',
          },
        ],
      } as unknown as ExtendedInteraction;

      const response = convertInteractionToLlmResponse(interaction);

      expect(response).toEqual({
        errorCode: 'RESOURCE_EXHAUSTED',
        errorMessage: 'Rate limit exceeded',
        interactionId: 'int-failed-1',
      });
    });

    it('falls back to singular error when errors array is absent or empty', () => {
      const interaction = {
        id: 'int-failed-2',
        status: 'failed',
        errors: [],
        error: {
          code: 'INTERNAL',
          message: 'Legacy singular error',
        },
      } as unknown as ExtendedInteraction;

      const response = convertInteractionToLlmResponse(interaction);

      expect(response).toEqual({
        errorCode: 'INTERNAL',
        errorMessage: 'Legacy singular error',
        interactionId: 'int-failed-2',
      });
    });

    it('returns FinishReason.STOP for completed interactions', () => {
      const interaction = {
        id: 'int-ok-1',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [{type: 'text', text: 'Done'}],
          },
        ],
      } as unknown as ExtendedInteraction;

      const response = convertInteractionToLlmResponse(interaction);

      expect(response.finishReason).toBe(FinishReason.STOP);
      expect(response.turnComplete).toBe(true);
    });
  });

  describe('ExtendedInteractionSSEEvent', () => {
    it('accepts string arguments and omitted mime_type on delta', () => {
      const argsEvent: ExtendedInteractionSSEEvent = {
        event_type: 'step.delta',
        delta: {
          type: 'arguments_delta',
          arguments: '{"city":"NYC"}',
        },
      } as ExtendedInteractionSSEEvent;

      const parts: Part[] = [
        {
          functionCall: {id: 'call-1', name: 'get_weather', args: {}},
          partMetadata: {accumulatedArgs: '', isComplete: false},
        },
      ];
      convertInteractionEventToLlmResponse(argsEvent, parts, 'int-1');
      expect(parts[0].partMetadata?.['accumulatedArgs']).toBe('{"city":"NYC"}');

      const recordArgsEvent: ExtendedInteractionSSEEvent = {
        event_type: 'step.delta',
        delta: {
          type: 'arguments_delta',
          arguments: {city: 'NYC'},
        },
      } as ExtendedInteractionSSEEvent;
      expect(recordArgsEvent.delta?.mime_type).toBeUndefined();
    });

    it('returns FinishReason.STOP on interaction.completed and interaction.status_update', () => {
      const parts: Part[] = [{text: 'Hello'}];

      const completed = convertInteractionEventToLlmResponse(
        {event_type: 'interaction.completed'} as ExtendedInteractionSSEEvent,
        parts,
        'int-1',
      );
      expect(completed?.finishReason).toBe(FinishReason.STOP);

      const statusCompleted = convertInteractionEventToLlmResponse(
        {
          event_type: 'interaction.status_update',
          status: 'requires_action',
        } as ExtendedInteractionSSEEvent,
        parts,
        'int-1',
      );
      expect(statusCompleted?.finishReason).toBe(FinishReason.STOP);
    });
  });

  describe('convertContentToSteps code execution IDs and language', () => {
    it('forwards codeExecutionResult.id as call_id', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            codeExecutionResult: {
              id: 'exec-call-42',
              output: '42',
              outcome: Outcome.OUTCOME_OK,
            },
          },
        ],
      };

      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'code_execution_result',
          call_id: 'exec-call-42',
          result: '42',
          is_error: false,
        },
      ]);
    });

    it('forwards executableCode.id and keeps language as python', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            executableCode: {
              id: 'exec-call-42',
              code: 'print(42)',
              language: Language.PYTHON,
            },
          },
          {
            executableCode: {
              id: 'exec-call-43',
              code: 'x = 1',
              language: Language.LANGUAGE_UNSPECIFIED,
            },
          },
          {
            executableCode: {
              code: 'console.log(1)',
              language: 'JAVASCRIPT' as Language,
            },
          },
        ],
      };

      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'code_execution_call',
          id: 'exec-call-42',
          arguments: {
            code: 'print(42)',
            language: 'python',
          },
        },
        {
          type: 'code_execution_call',
          id: 'exec-call-43',
          arguments: {
            code: 'x = 1',
            language: 'python',
          },
        },
        {
          type: 'code_execution_call',
          id: '',
          arguments: {
            code: 'console.log(1)',
            language: 'python',
          },
        },
      ]);
    });
  });

  describe('generateContentViaInteractions', () => {
    it('resolves default model and logs camelCase previousInteractionId', async () => {
      const createMock = vi.fn().mockResolvedValue({
        id: 'int-123',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [{type: 'text', text: 'hi'}],
          } satisfies Interactions.ModelOutputStep,
        ],
      });
      const apiClient = {
        interactions: {create: createMock},
      } as unknown as GoogleGenAI;
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

      const llmRequest: LlmRequest = {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        liveConnectConfig: {},
        toolsDict: {},
        previousInteractionId: 'prev-int-1',
      };

      const outputs = [];
      for await (const res of generateContentViaInteractions(
        apiClient,
        llmRequest,
        false,
      )) {
        outputs.push(res);
      }

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-2.5-flash',
          previous_interaction_id: 'prev-int-1',
          stream: false,
        }),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('model: gemini-2.5-flash'),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('previousInteractionId: prev-int-1'),
      );
      expect(outputs).toHaveLength(1);
      expect(outputs[0].finishReason).toBe(FinishReason.STOP);

      infoSpy.mockRestore();
    });
  });
});
