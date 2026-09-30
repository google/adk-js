/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PlanReActPlanner,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({id: 'session-1', appName: 'test-app'}),
    pluginManager: new PluginManager(),
  });
}

function makeContext(): Context {
  return new Context({invocationContext: makeInvocationContext()});
}

function functionCallPart(name: string): Part {
  return {functionCall: {name, args: {}}};
}

// The planner instruction from the Python ADK, one array entry per line. The
// wording is the planner's behaviour, so the test pins every character.
const EXPECTED_INSTRUCTION = [
  '',
  'When answering the question, try to leverage the available tools to gather the information instead of your memorized knowledge.',
  '',
  'Follow this process when answering the question: (1) first come up with a plan in natural language text format; (2) Then use tools to execute the plan and provide reasoning between tool code snippets to make a summary of current state and next step. Tool code snippets and reasoning should be interleaved with each other. (3) In the end, return one final answer.',
  '',
  'Follow this format when answering the question: (1) The planning part should be under /*PLANNING*/. (2) The tool code snippets should be under /*ACTION*/, and the reasoning parts should be under /*REASONING*/. (3) The final answer part should be under /*FINAL_ANSWER*/.',
  '',
  '',
  '',
  'Below are the requirements for the planning:',
  'The plan is made to answer the user query if following the plan. The plan is coherent and covers all aspects of information from user query, and only involves the tools that are accessible by the agent. The plan contains the decomposed steps as a numbered list where each step should use one or multiple available tools. By reading the plan, you can intuitively know which tools to trigger or what actions to take.',
  'If the initial plan cannot be successfully executed, you should learn from previous execution results and revise your plan. The revised plan should be be under /*REPLANNING*/. Then use tools to follow the new plan.',
  '',
  '',
  '',
  'Below are the requirements for the reasoning:',
  'The reasoning makes a summary of the current trajectory based on the user query and tool outputs. Based on the tool outputs and plan, the reasoning also comes up with instructions to the next steps, making the trajectory closer to the final answer.',
  '',
  '',
  '',
  'Below are the requirements for the final answer:',
  'The final answer should be precise and follow query formatting requirements. Some queries may not be answerable with the available tools and information. In those cases, inform the user why you cannot process their query and ask for more information.',
  '',
  '',
  '',
  'Below are the requirements for the tool code:',
  '',
  '**Custom Tools:** The available tools are described in the context and can be directly used.',
  '- Code must be valid self-contained Python snippets with no imports and no references to tools or Python libraries that are not in the context.',
  '- You cannot use any parameters or fields that are not explicitly defined in the APIs in the context.',
  '- The code snippets should be readable, efficient, and directly relevant to the user query and reasoning steps.',
  '- When using the tools, you should use the library name together with the function name, e.g., vertex_search.search().',
  '- If Python libraries are not provided in the context, NEVER write your own code other than the function calls using the provided tools.',
  '',
  '',
  '',
  'VERY IMPORTANT instruction that you MUST follow in addition to the above instructions:',
  '',
  'You should ask for clarification if you need more information to answer the question.',
  'You should prefer using the information available in the context instead of repeated tool use.',
  '',
].join('\n');

describe('PlanReActPlanner', () => {
  describe('processPlanningResponse', () => {
    it('returns undefined for empty response parts', () => {
      const planner = new PlanReActPlanner();

      expect(
        planner.processPlanningResponse(makeContext(), []),
      ).toBeUndefined();
    });

    it('passes text-only parts through unchanged', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [{text: 'first'}, {text: 'second'}];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: 'first'},
        {text: 'second'},
      ]);
    });

    it('drops the parts after the first function call', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [
        {text: 'intro'},
        functionCallPart('tool_a'),
        {text: 'after call'},
        functionCallPart('tool_b'),
      ];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: 'intro'},
        functionCallPart('tool_a'),
      ]);
    });

    it('keeps consecutive function calls after a leading text part', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [
        {text: 'intro'},
        functionCallPart('tool_a'),
        functionCallPart('tool_b'),
        functionCallPart('tool_c'),
        {text: 'after calls'},
        functionCallPart('tool_d'),
      ];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: 'intro'},
        functionCallPart('tool_a'),
        functionCallPart('tool_b'),
        functionCallPart('tool_c'),
      ]);
    });

    it('keeps only the first call when the response starts with a call', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [
        functionCallPart('tool_a'),
        functionCallPart('tool_b'),
      ];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        functionCallPart('tool_a'),
      ]);
    });

    it('skips a function call with an empty name', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [
        {text: 'intro'},
        functionCallPart(''),
        {text: 'more'},
        functionCallPart('tool_a'),
      ];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: 'intro'},
        {text: 'more'},
        functionCallPart('tool_a'),
      ]);
    });

    it('splits a final answer part into a thought and an answer', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [
        {text: '/*REASONING*/All done./*FINAL_ANSWER*/The answer is 42.'},
      ];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: '/*REASONING*/All done./*FINAL_ANSWER*/', thought: true},
        {text: 'The answer is 42.'},
      ]);
    });

    it('splits at the last final answer tag', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [{text: 'a/*FINAL_ANSWER*/b/*FINAL_ANSWER*/c'}];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: 'a/*FINAL_ANSWER*/b/*FINAL_ANSWER*/', thought: true},
        {text: 'c'},
      ]);
    });

    it('keeps only the reasoning part when the final answer tag ends the text', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [{text: 'thinking/*FINAL_ANSWER*/'}];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: 'thinking/*FINAL_ANSWER*/', thought: true},
      ]);
    });

    it.each(['/*PLANNING*/', '/*REASONING*/', '/*ACTION*/', '/*REPLANNING*/'])(
      'marks a part starting with %s as a thought',
      (tag) => {
        const planner = new PlanReActPlanner();
        const parts: Part[] = [{text: `${tag} step one`}];

        expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
          {text: `${tag} step one`, thought: true},
        ]);
      },
    );

    it('does not mark a part whose tag is not at the start', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [{text: ' /*PLANNING*/ step one'}];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: ' /*PLANNING*/ step one'},
      ]);
    });

    it('does not mark the answer after a leading final answer tag', () => {
      const planner = new PlanReActPlanner();
      const parts: Part[] = [{text: '/*FINAL_ANSWER*/The answer.'}];

      expect(planner.processPlanningResponse(makeContext(), parts)).toEqual([
        {text: '/*FINAL_ANSWER*/', thought: true},
        {text: 'The answer.'},
      ]);
    });

    it('does not mutate the input parts', () => {
      const planner = new PlanReActPlanner();
      const planningPart: Part = {text: '/*PLANNING*/ plan'};
      const answerPart: Part = {text: 'why/*FINAL_ANSWER*/what'};

      const result = planner.processPlanningResponse(makeContext(), [
        planningPart,
        answerPart,
      ]);

      expect(planningPart).toEqual({text: '/*PLANNING*/ plan'});
      expect(answerPart).toEqual({text: 'why/*FINAL_ANSWER*/what'});
      expect(result?.[0]).not.toBe(planningPart);
      expect(result?.[0]).toEqual({text: '/*PLANNING*/ plan', thought: true});
    });
  });

  describe('buildPlanningInstruction', () => {
    it('returns the instruction text verbatim', () => {
      const planner = new PlanReActPlanner();
      const readonlyContext = new ReadonlyContext(makeInvocationContext());
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      expect(
        planner.buildPlanningInstruction(readonlyContext, llmRequest),
      ).toBe(EXPECTED_INSTRUCTION);
    });

    it('contains all five tags and ignores its arguments', () => {
      const planner = new PlanReActPlanner();
      const readonlyContext = new ReadonlyContext(makeInvocationContext());
      const emptyRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };
      const otherRequest: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'hi'}]}],
        toolsDict: {},
        liveConnectConfig: {},
      };

      const instruction = planner.buildPlanningInstruction(
        readonlyContext,
        emptyRequest,
      );

      for (const tag of [
        '/*PLANNING*/',
        '/*REPLANNING*/',
        '/*REASONING*/',
        '/*ACTION*/',
        '/*FINAL_ANSWER*/',
      ]) {
        expect(instruction).toContain(tag);
      }
      expect(
        planner.buildPlanningInstruction(readonlyContext, otherRequest),
      ).toBe(instruction);
    });
  });
});
