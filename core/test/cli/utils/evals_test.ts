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
});
