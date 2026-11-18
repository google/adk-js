/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  parseCreateSessionBody,
  validateAndNormalizeSessionEvents,
} from '../../src/server/session_event_utils.js';

describe('parseCreateSessionBody', () => {
  it('returns empty state and no events for an absent body', () => {
    expect(parseCreateSessionBody(undefined)).toEqual({state: {}, events: []});
  });

  it('prefers a non-blank sessionId over session_id and trims it', () => {
    expect(
      parseCreateSessionBody({sessionId: ' camel ', session_id: 'snake'})
        .sessionId,
    ).toBe('camel');
    expect(
      parseCreateSessionBody({sessionId: '', session_id: ' snake '}).sessionId,
    ).toBe('snake');
    expect(parseCreateSessionBody({sessionId: '  '}).sessionId).toBeUndefined();
  });

  it('throws InputValidationError for a non-string session_id', () => {
    expect(() => parseCreateSessionBody({session_id: ['id']})).toThrow(
      InputValidationError,
    );
  });
});

describe('validateAndNormalizeSessionEvents', () => {
  it('keeps LlmResponse and Event fields given in either case', () => {
    const [event] = validateAndNormalizeSessionEvents([
      {
        id: 'event-1',
        invocation_id: 'inv-1',
        author: 'agent',
        timestamp: 1234,
        finish_reason: 'STOP',
        model_version: 'model-1',
        interaction_id: 'interaction-1',
        liveSessionId: 'live-1',
        turn_complete: true,
        isolation_scope: 'scope-1',
        node_info: {
          path: 'wf.child',
          output_for: ['wf.child', 'wf'],
          message_as_output: true,
        },
        citation_metadata: {citations: [{start_index: 1, end_index: 2}]},
        input_transcription: {text: 'in', finished: true},
        output_transcription: {text: 'out'},
        usage_metadata: {prompt_token_count: 3, candidates_token_count: 4},
        grounding_metadata: {web_search_queries: ['q']},
        liveSessionResumptionUpdate: {new_handle: 'handle'},
        goAway: {time_left: '1s'},
      },
    ]);

    expect(event).toMatchObject({
      id: 'event-1',
      invocationId: 'inv-1',
      author: 'agent',
      timestamp: 1234,
      finishReason: 'STOP',
      modelVersion: 'model-1',
      interactionId: 'interaction-1',
      liveSessionId: 'live-1',
      turnComplete: true,
      isolationScope: 'scope-1',
      nodeInfo: {
        path: 'wf.child',
        outputFor: ['wf.child', 'wf'],
        messageAsOutput: true,
      },
      citationMetadata: {citations: [{startIndex: 1, endIndex: 2}]},
      inputTranscription: {text: 'in', finished: true},
      outputTranscription: {text: 'out'},
      usageMetadata: {promptTokenCount: 3, candidatesTokenCount: 4},
      groundingMetadata: {webSearchQueries: ['q']},
      liveSessionResumptionUpdate: {newHandle: 'handle'},
      goAway: {timeLeft: '1s'},
    });
  });

  it('converts nested part keys to camelCase', () => {
    const [event] = validateAndNormalizeSessionEvents([
      {
        content: {
          role: 'model',
          parts: [
            {inline_data: {mime_type: 'image/png', data: 'AAAA'}},
            {
              file_data: {
                file_uri: 'gs://bucket/file',
                mime_type: 'text/plain',
              },
            },
            {video_metadata: {start_offset: '1s', end_offset: '2s'}},
            {executable_code: {code: 'print(1)', language: 'PYTHON'}},
            {code_execution_result: {outcome: 'OUTCOME_OK', output: '1'}},
            {text: 'thinking', thought: true, thought_signature: 'sig'},
          ],
        },
      },
    ]);

    expect(event.content?.parts).toEqual([
      {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
      {fileData: {fileUri: 'gs://bucket/file', mimeType: 'text/plain'}},
      {videoMetadata: {startOffset: '1s', endOffset: '2s'}},
      {executableCode: {code: 'print(1)', language: 'PYTHON'}},
      {codeExecutionResult: {outcome: 'OUTCOME_OK', output: '1'}},
      {text: 'thinking', thought: true, thoughtSignature: 'sig'},
    ]);
  });

  it('leaves the keys of user-defined values unchanged', () => {
    const [event] = validateAndNormalizeSessionEvents([
      {
        custom_metadata: {user_key: {nested_key: 1}},
        output: {result_value: 2},
        route: 'next_node',
        content: {
          parts: [
            {
              function_call: {
                id: 'call-1',
                name: 'write_files',
                args: {file_path: 'a.txt'},
              },
            },
            {
              function_response: {
                id: 'call-1',
                name: 'write_files',
                response: {bytes_written: 3},
              },
            },
          ],
        },
      },
    ]);

    expect(event.customMetadata).toEqual({user_key: {nested_key: 1}});
    expect(event.output).toEqual({result_value: 2});
    expect(event.route).toBe('next_node');
    expect(event.content?.parts?.[0]?.functionCall).toEqual({
      id: 'call-1',
      name: 'write_files',
      args: {file_path: 'a.txt'},
    });
    expect(event.content?.parts?.[1]?.functionResponse).toEqual({
      id: 'call-1',
      name: 'write_files',
      response: {bytes_written: 3},
    });
  });

  it('accepts default event actions and replaces them with fresh defaults', () => {
    const [event] = validateAndNormalizeSessionEvents([
      {actions: {state_delta: {}, artifactDelta: {}}, longRunningToolIds: []},
    ]);

    expect(event.actions.stateDelta).toEqual({});
    expect(event.longRunningToolIds).toEqual([]);
  });

  it('rejects a function response with an ADK protocol name', () => {
    expect(() =>
      validateAndNormalizeSessionEvents([
        {
          content: {
            parts: [
              {
                function_response: {
                  name: 'adk_request_credential',
                  response: {},
                },
              },
            ],
          },
        },
      ]),
    ).toThrow('Session initialization event 0 cannot include ADK protocol');
  });

  it('rejects a top-level field with the wrong type', () => {
    expect(() =>
      validateAndNormalizeSessionEvents([{}, {invocation_id: 7}]),
    ).toThrow('Invalid session initialization event 1: invocationId');
  });
});
