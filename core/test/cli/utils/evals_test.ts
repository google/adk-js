/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  convertSessionToEvalFormat,
  convertSessionToEvalInvocations,
  createEmptyState,
  createEvent,
  createSession,
  LlmAgent,
  SequentialAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('cli/utils/evals', () => {
  describe('convertSessionToEvalFormat', () => {
    it('returns an empty list when session is undefined or has no events', () => {
      expect(convertSessionToEvalFormat(undefined)).toEqual([]);
      expect(
        convertSessionToEvalFormat(
          createSession({id: 's1', appName: 'app', userId: 'u1', events: []}),
        ),
      ).toEqual([]);
    });

    it('converts a multi-turn session with tool calls and intermediate agent responses', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Roll a 6-sided die'}]},
          }),
          createEvent({
            author: 'router_agent',
            content: {
              role: 'model',
              parts: [{text: 'Routing to roll_agent.'}],
            },
          }),
          createEvent({
            author: 'roll_agent',
            content: {
              role: 'model',
              parts: [{functionCall: {name: 'roll_die', args: {sides: 6}}}],
            },
          }),
          createEvent({
            author: 'roll_agent',
            content: {
              role: 'user',
              parts: [
                {functionResponse: {name: 'roll_die', response: {result: 4}}},
              ],
            },
          }),
          createEvent({
            author: 'roll_agent',
            content: {
              role: 'model',
              parts: [{text: 'You rolled a '}, {text: '4.'}],
            },
          }),
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Thanks!'}]},
          }),
          createEvent({
            author: 'roll_agent',
            content: {role: 'model', parts: [{text: 'You are welcome!'}]},
          }),
        ],
      });

      const evalItems = convertSessionToEvalFormat(session);

      expect(evalItems).toEqual([
        {
          query: 'Roll a 6-sided die',
          expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
          expected_intermediate_agent_responses: [
            ['router_agent', [{text: 'Routing to roll_agent.'}]],
          ],
          reference: 'You rolled a 4.',
        },
        {
          query: 'Thanks!',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'You are welcome!',
        },
      ]);
    });

    it('skips leading non-user events and handles user turn with no model response', () => {
      const session = createSession({
        id: 's2',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'system_agent',
            content: {role: 'model', parts: [{text: 'Welcome'}]},
          }),
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Unanswered question'}]},
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'Unanswered question',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: '',
        },
      ]);
    });
  });

  describe('createEmptyState', () => {
    it('extracts {var} placeholders recursively across sub-agents and applies initializedStates overrides', () => {
      const child1 = new LlmAgent({
        name: 'child1',
        instruction: 'Use {city} and {units} to check weather.',
      });
      const child2 = new LlmAgent({
        name: 'child2',
        instruction: () => 'Dynamic instruction provider with {ignored_var}',
      });
      const root = new LlmAgent({
        name: 'root',
        instruction: 'Hello {user_name}, welcome to {app_title}.',
        subAgents: [
          new SequentialAgent({
            name: 'seq',
            subAgents: [child1, child2],
          }),
        ],
      });

      const state = createEmptyState(root, {
        user_name: 'Alice',
        extra_key: 42,
      });

      expect(state).toEqual({
        city: '',
        units: '',
        user_name: 'Alice',
        app_title: '',
        extra_key: 42,
      });
    });
  });

  describe('convertSessionToEvalFormat edge cases', () => {
    it('converts a single-turn session with only a text response', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'What is the time?'}]},
          }),
          createEvent({
            author: 'root_agent',
            content: {role: 'model', parts: [{text: 'It is 3 PM.'}]},
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'What is the time?',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'It is 3 PM.',
        },
      ]);
    });

    it('converts a single-turn session with only a tool call and leaves reference empty', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {
              role: 'user',
              parts: [{text: 'Get weather for Seattle'}],
            },
          }),
          createEvent({
            author: 'root_agent',
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    args: {city: 'Seattle'},
                  },
                },
              ],
            },
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'Get weather for Seattle',
          expected_tool_use: [
            {tool_name: 'get_weather', tool_input: {city: 'Seattle'}},
          ],
          expected_intermediate_agent_responses: [],
          reference: '',
        },
      ]);
    });

    it('converts a single-turn session with multiple tool calls and intermediate text responses', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Do task A then task B'}]},
          }),
          createEvent({
            author: 'root_agent',
            content: {role: 'model', parts: [{text: 'Okay, starting task A.'}]},
          }),
          createEvent({
            author: 'root_agent',
            content: {
              role: 'model',
              parts: [{functionCall: {name: 'task_A', args: {param: 1}}}],
            },
          }),
          createEvent({
            author: 'root_agent',
            content: {
              role: 'model',
              parts: [{text: 'Task A done. Now starting task B.'}],
            },
          }),
          createEvent({
            author: 'another_agent',
            content: {
              role: 'model',
              parts: [{functionCall: {name: 'task_B', args: {}}}],
            },
          }),
          createEvent({
            author: 'root_agent',
            content: {role: 'model', parts: [{text: 'All tasks completed.'}]},
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'Do task A then task B',
          expected_tool_use: [
            {tool_name: 'task_A', tool_input: {param: 1}},
            {tool_name: 'task_B', tool_input: {}},
          ],
          expected_intermediate_agent_responses: [
            ['root_agent', [{text: 'Okay, starting task A.'}]],
            ['root_agent', [{text: 'Task A done. Now starting task B.'}]],
          ],
          reference: 'All tasks completed.',
        },
      ]);
    });

    it('defaults missing tool name, tool args, and agent author to empty values', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Call tools'}]},
          }),
          createEvent({
            author: 'agent',
            content: {
              role: 'model',
              parts: [{functionCall: {name: undefined, args: {a: 1}}}],
            },
          }),
          createEvent({
            author: 'agent',
            content: {
              role: 'model',
              parts: [{functionCall: {name: 'tool_B', args: undefined}}],
            },
          }),
          createEvent({
            content: {
              role: 'model',
              parts: [{functionCall: undefined, text: 'some text'}],
            },
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Done'}]},
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'Call tools',
          expected_tool_use: [
            {tool_name: '', tool_input: {a: 1}},
            {tool_name: 'tool_B', tool_input: {}},
          ],
          expected_intermediate_agent_responses: [
            ['', [{functionCall: undefined, text: 'some text'}]],
          ],
          reference: 'Done',
        },
      ]);
    });

    it('defaults user query to empty string when the first part has undefined or empty text', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: undefined}]},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Response 1'}]},
          }),
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: ''}]},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Response 2'}]},
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: '',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'Response 1',
        },
        {
          query: '',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'Response 2',
        },
      ]);
    });

    // reference: test_convert_agent_event_multiple_parts
    it('extracts both text and tool calls when an agent event has multiple parts', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Do something complex'}]},
          }),
          createEvent({
            author: 'agent',
            content: {
              role: 'model',
              parts: [
                {text: 'Okay, doing it.'},
                {
                  functionCall: {
                    name: 'complex_tool',
                    args: {value: true},
                  },
                },
              ],
            },
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Finished.'}]},
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'Do something complex',
          expected_tool_use: [
            {tool_name: 'complex_tool', tool_input: {value: true}},
          ],
          expected_intermediate_agent_responses: [
            ['agent', [{text: 'Okay, doing it.'}]],
          ],
          reference: 'Finished.',
        },
      ]);
    });

    // reference: test_convert_handles_missing_content_or_parts
    it('skips user and agent events that have missing content or empty parts', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Query 1'}]},
          }),
          createEvent({author: 'agent', content: undefined}),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Response 1'}]},
          }),
          createEvent({author: 'user', content: undefined}),
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Query 2'}]},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: []},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Response 2'}]},
          }),
          createEvent({
            author: 'user',
            content: {role: 'user', parts: undefined},
          }),
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Query 3'}]},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Response 3'}]},
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'Query 1',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'Response 1',
        },
        {
          query: 'Query 2',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'Response 2',
        },
        {
          query: 'Query 3',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'Response 3',
        },
      ]);
    });

    // reference: test_convert_handles_empty_agent_text
    it('ignores agent text parts that contain an empty string', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Query'}]},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Okay'}]},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: ''}]},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: 'Done'}]},
          }),
          createEvent({
            author: 'agent',
            content: {role: 'model', parts: [{text: ''}]},
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'Query',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [['agent', [{text: 'Okay'}]]],
          reference: 'Done',
        },
      ]);
    });

    // reference: test_convert_complex_sample_session
    it('converts a multi-agent session with transfers and combined text-and-tool events', () => {
      const session = createSession({
        id: 'some_id',
        appName: 'hello_world_ma',
        userId: 'user',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'What can you do?'}]},
          }),
          createEvent({
            author: 'root_agent',
            content: {
              role: 'model',
              parts: [
                {text: 'I can roll dice and check if numbers are prime. \n'},
              ],
            },
          }),
          createEvent({
            author: 'user',
            content: {
              role: 'user',
              parts: [
                {
                  text: 'Roll a 8 sided dice and then check if 90 is a prime number or not.',
                },
              ],
            },
          }),
          createEvent({
            author: 'root_agent',
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'transfer_to_agent',
                    args: {agent_name: 'roll_agent'},
                  },
                },
              ],
            },
          }),
          createEvent({
            author: 'roll_agent',
            content: {
              role: 'model',
              parts: [{functionCall: {name: 'roll_die', args: {sides: 8}}}],
            },
          }),
          createEvent({
            author: 'roll_agent',
            content: {
              role: 'model',
              parts: [
                {text: "I rolled a 2. Now, I'll check if 90 is prime. \n\n"},
                {
                  functionCall: {
                    name: 'transfer_to_agent',
                    args: {agent_name: 'prime_agent'},
                  },
                },
              ],
            },
          }),
          createEvent({
            author: 'prime_agent',
            content: {
              role: 'model',
              parts: [
                {functionCall: {name: 'check_prime', args: {nums: [90]}}},
              ],
            },
          }),
          createEvent({
            author: 'prime_agent',
            content: {
              role: 'model',
              parts: [{text: '90 is not a prime number. \n'}],
            },
          }),
        ],
      });

      expect(convertSessionToEvalFormat(session)).toEqual([
        {
          query: 'What can you do?',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'I can roll dice and check if numbers are prime. \n',
        },
        {
          query:
            'Roll a 8 sided dice and then check if 90 is a prime number or not.',
          expected_tool_use: [
            {
              tool_name: 'transfer_to_agent',
              tool_input: {agent_name: 'roll_agent'},
            },
            {tool_name: 'roll_die', tool_input: {sides: 8}},
            {
              tool_name: 'transfer_to_agent',
              tool_input: {agent_name: 'prime_agent'},
            },
            {tool_name: 'check_prime', tool_input: {nums: [90]}},
          ],
          expected_intermediate_agent_responses: [
            [
              'roll_agent',
              [{text: "I rolled a 2. Now, I'll check if 90 is prime. \n\n"}],
            ],
          ],
          reference: '90 is not a prime number. \n',
        },
      ]);
    });
  });

  describe('convertSessionToEvalInvocations', () => {
    // reference: test_convert_session_to_eval_invocations_handles_missing_history
    it('returns an empty array when the session is undefined or has no events', () => {
      expect(convertSessionToEvalInvocations(undefined)).toEqual([]);
      expect(
        convertSessionToEvalInvocations(
          createSession({id: 's1', appName: 'app', userId: 'u1', events: []}),
        ),
      ).toEqual([]);
    });

    // reference: test_convert_session_to_eval_invocations_groups_events_by_invocation
    it('groups session events into structured invocations by user turn', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          createEvent({
            author: 'user',
            invocationId: 'inv-1',
            timestamp: 100,
            content: {role: 'user', parts: [{text: 'first question'}]},
          }),
          createEvent({
            author: 'agent',
            invocationId: 'inv-1',
            timestamp: 101,
            content: {role: 'model', parts: [{text: 'first answer'}]},
          }),
          createEvent({
            author: 'user',
            invocationId: 'inv-2',
            timestamp: 200,
            content: {role: 'user', parts: [{text: 'second question'}]},
          }),
          createEvent({
            author: 'agent',
            invocationId: 'inv-2',
            timestamp: 201,
            content: {
              role: 'model',
              parts: [
                {text: 'thinking'},
                {functionCall: {name: 'lookup', args: {q: 'second'}}},
              ],
            },
          }),
          createEvent({
            author: 'agent',
            invocationId: 'inv-2',
            timestamp: 202,
            content: {role: 'model', parts: [{text: 'second answer'}]},
          }),
        ],
      });

      const invocations = convertSessionToEvalInvocations(session);

      expect(invocations.map((i) => i.invocationId)).toEqual([
        'inv-1',
        'inv-2',
      ]);
      expect(invocations.map((i) => i.userContent.parts?.[0]?.text)).toEqual([
        'first question',
        'second question',
      ]);
      expect(invocations.map((i) => i.finalResponse?.parts?.[0]?.text)).toEqual(
        ['first answer', 'second answer'],
      );
      expect(invocations[1].intermediateData).toEqual({
        toolUses: [{name: 'lookup', args: {q: 'second'}}],
        intermediateResponses: [['agent', [{text: 'thinking'}]]],
      });
    });
  });
});
