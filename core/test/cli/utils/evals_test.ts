/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  convertSessionToEvalFormat,
  createEmptyState,
  createEvent,
  createSession,
  LlmAgent,
  SequentialAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  convertEvaluationItemToInvocation,
  convertSessionToInvocations,
} from '../../../src/cli/utils/evals.js';

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
  });

  describe('convertSessionToInvocations', () => {
    it('returns an empty list when session is undefined', () => {
      expect(convertSessionToInvocations(undefined)).toEqual([]);
    });

    it('keeps the full turn content, with the last final-response event as the final response', () => {
      const appDetails = {agentDetails: {}};
      const userEvent = createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Roll a die'}]},
      });
      const routing = createEvent({
        invocationId: 'inv-1',
        author: 'router_agent',
        content: {role: 'model', parts: [{text: 'Routing.'}]},
      });
      const call = createEvent({
        invocationId: 'inv-1',
        author: 'roll_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'roll_die', args: {sides: 6}}}],
        },
      });
      const toolResponse = createEvent({
        invocationId: 'inv-1',
        author: 'roll_agent',
        content: {
          role: 'user',
          parts: [{functionResponse: {name: 'roll_die', response: {r: 4}}}],
        },
      });
      const answer = createEvent({
        invocationId: 'inv-1',
        author: 'roll_agent',
        content: {role: 'model', parts: [{text: 'You rolled 4.'}]},
      });
      const secondUser = createEvent({
        invocationId: 'inv-2',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Again'}]},
      });
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [
          userEvent,
          routing,
          call,
          createEvent({invocationId: 'inv-1', author: 'roll_agent'}),
          toolResponse,
          answer,
          secondUser,
        ],
      });

      expect(convertSessionToInvocations(session, appDetails)).toEqual([
        {
          invocationId: 'inv-1',
          userContent: userEvent.content,
          finalResponse: answer.content,
          intermediateData: {
            invocationEvents: [
              {author: 'router_agent', content: routing.content},
              {author: 'roll_agent', content: call.content},
              {author: 'roll_agent', content: toolResponse.content},
            ],
          },
          creationTimestamp: userEvent.timestamp,
          appDetails,
        },
        {
          invocationId: 'inv-2',
          userContent: secondUser.content,
          finalResponse: undefined,
          intermediateData: {invocationEvents: []},
          creationTimestamp: secondUser.timestamp,
          appDetails,
        },
      ]);
    });
  });

  describe('convertSessionToInvocations grouping', () => {
    it('groups events by invocation id, not by user event', () => {
      const firstUser = createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Hello'}]},
      });
      const secondUser = createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Roll a die'}]},
      });
      const answer = createEvent({
        invocationId: 'inv-1',
        author: 'roll_agent',
        content: {role: 'model', parts: [{text: 'You rolled 4.'}]},
      });
      const session = createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
        events: [firstUser, secondUser, answer],
      });

      expect(convertSessionToInvocations(session)).toEqual([
        {
          invocationId: 'inv-1',
          userContent: secondUser.content,
          finalResponse: answer.content,
          intermediateData: {invocationEvents: []},
          creationTimestamp: secondUser.timestamp,
          appDetails: undefined,
        },
      ]);
    });
  });

  describe('convertEvaluationItemToInvocation', () => {
    it('maps the query, reference, expected tools and intermediate responses', () => {
      expect(
        convertEvaluationItemToInvocation({
          query: 'Roll a die',
          reference: 'You rolled 4.',
          expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
          expected_intermediate_agent_responses: [
            ['router_agent', [{text: 'Routing.'}]],
          ],
        }),
      ).toEqual({
        userContent: {role: 'user', parts: [{text: 'Roll a die'}]},
        finalResponse: {role: 'model', parts: [{text: 'You rolled 4.'}]},
        intermediateData: {
          toolUses: [{name: 'roll_die', args: {sides: 6}}],
          toolResponses: [],
          intermediateResponses: [['router_agent', [{text: 'Routing.'}]]],
        },
        appDetails: undefined,
      });
    });
  });
});
