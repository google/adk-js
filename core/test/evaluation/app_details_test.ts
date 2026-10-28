/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AppDetails,
  buildAppDetailsFromAgent,
  FunctionTool,
  getDeveloperInstructionsByAgentName,
  getToolsByAgentName,
  LlmAgent,
  SequentialAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const APP_DETAILS: AppDetails = {
  agentDetails: {
    root: {name: 'root', instructions: 'Be helpful.', toolDeclarations: []},
    helper: {
      name: 'helper',
      instructions: '',
      toolDeclarations: [{functionDeclarations: [{name: 'lookup'}]}],
    },
  },
};

describe('evaluation/app_details', () => {
  describe('getDeveloperInstructionsByAgentName', () => {
    it('returns the instructions of the named agent', () => {
      expect(getDeveloperInstructionsByAgentName(APP_DETAILS, 'root')).toBe(
        'Be helpful.',
      );
    });

    it('throws for an agent that is not in the app', () => {
      expect(() =>
        getDeveloperInstructionsByAgentName(APP_DETAILS, 'missing'),
      ).toThrow('`missing` not found in the agentic system.');
    });
  });

  describe('getToolsByAgentName', () => {
    it('returns the tool declarations keyed by agent name', () => {
      expect(getToolsByAgentName(APP_DETAILS)).toEqual({
        root: [],
        helper: [{functionDeclarations: [{name: 'lookup'}]}],
      });
    });
  });

  describe('buildAppDetailsFromAgent', () => {
    it('collects every agent with static instructions and tool declarations', async () => {
      const lookup = new FunctionTool({
        name: 'lookup',
        description: 'Looks something up.',
        parameters: z.object({id: z.string()}),
        execute: () => 'found',
      });
      const root = new SequentialAgent({
        name: 'pipeline',
        subAgents: [
          new LlmAgent({
            name: 'static_agent',
            model: 'gemini-flash-latest',
            instruction: 'Use lookup.',
            tools: [lookup],
          }),
          new LlmAgent({
            name: 'dynamic_agent',
            model: 'gemini-flash-latest',
            instruction: async () => 'Resolved at run time.',
          }),
        ],
      });

      const appDetails = await buildAppDetailsFromAgent(root);

      expect(Object.keys(appDetails.agentDetails)).toEqual([
        'pipeline',
        'static_agent',
        'dynamic_agent',
      ]);
      expect(appDetails.agentDetails['pipeline']).toEqual({
        name: 'pipeline',
        instructions: '',
        toolDeclarations: [],
      });
      expect(appDetails.agentDetails['static_agent']).toMatchObject({
        name: 'static_agent',
        instructions: 'Use lookup.',
        toolDeclarations: [
          {
            functionDeclarations: [
              {name: 'lookup', description: 'Looks something up.'},
            ],
          },
        ],
      });
      expect(appDetails.agentDetails['dynamic_agent']).toEqual({
        name: 'dynamic_agent',
        instructions: '',
        toolDeclarations: [],
      });
    });
  });
});
