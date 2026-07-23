/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  LlmRequest,
  PlanReActPlanner,
  ReadonlyContext,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  ACTION_TAG,
  FINAL_ANSWER_TAG,
  handleNonFunctionCallParts,
  markAsThought,
  PLANNING_TAG,
  REASONING_TAG,
  REPLANNING_TAG,
  splitByLastPattern,
} from '../../src/planners/plan_re_act_planner.js';

function fc(name: string): Part {
  return {functionCall: {name, args: {city: 'SF'}}};
}

function txt(text: string): Part {
  return {text};
}

function functionCallNames(
  parts: Part[] | undefined,
): Array<string | undefined> {
  return (parts ?? [])
    .filter((p) => p.functionCall)
    .map((p) => p.functionCall!.name);
}

// The callback context is unused by PlanReActPlanner.processPlanningResponse.
const NO_CONTEXT = undefined as unknown as Context;

describe('PlanReActPlanner.processPlanningResponse', () => {
  it('preserves all leading parallel function calls (index-0 regression)', () => {
    const planner = new PlanReActPlanner();
    const responseParts = [fc('get_weather'), fc('get_time')];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('preserves the parallel function-call group after leading text', () => {
    const planner = new PlanReActPlanner();
    const responseParts = [
      txt('Let me look that up.'),
      fc('get_weather'),
      fc('get_time'),
    ];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(functionCallNames(result)).toEqual(['get_weather', 'get_time']);
  });

  it('stops the contiguous group at the first non-function-call part', () => {
    const planner = new PlanReActPlanner();
    const responseParts = [fc('a'), fc('b'), txt('trailing text'), fc('c')];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(functionCallNames(result)).toEqual(['a', 'b']);
    // The trailing text (and everything after) is dropped by the break.
    expect(result?.some((p) => p.text === 'trailing text')).toBe(false);
  });

  it('filters out function calls with an empty name', () => {
    const planner = new PlanReActPlanner();
    const responseParts = [fc(''), fc('get_time')];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(functionCallNames(result)).toEqual(['get_time']);
  });

  it('returns undefined for an empty parts array', () => {
    const planner = new PlanReActPlanner();
    expect(planner.processPlanningResponse(NO_CONTEXT, [])).toBeUndefined();
  });

  it('returns undefined for a missing parts array', () => {
    const planner = new PlanReActPlanner();
    expect(
      planner.processPlanningResponse(
        NO_CONTEXT,
        undefined as unknown as Part[],
      ),
    ).toBeUndefined();
  });

  it('splits reasoning and final answer around /*FINAL_ANSWER*/', () => {
    const planner = new PlanReActPlanner();
    const responseParts = [
      txt(`${REASONING_TAG} some reasoning ${FINAL_ANSWER_TAG} the answer`),
    ];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(result).toHaveLength(2);
    expect(result![0].thought).toBe(true);
    expect(result![0].text).toContain(FINAL_ANSWER_TAG);
    expect(result![1].thought).toBeUndefined();
    expect(result![1].text).toBe(' the answer');
  });

  it('splits on the last /*FINAL_ANSWER*/ occurrence', () => {
    const planner = new PlanReActPlanner();
    const responseParts = [
      txt(`a ${FINAL_ANSWER_TAG} b ${FINAL_ANSWER_TAG} c`),
    ];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(result).toHaveLength(2);
    expect(result![0].text).toBe(`a ${FINAL_ANSWER_TAG} b ${FINAL_ANSWER_TAG}`);
    expect(result![1].text).toBe(' c');
  });

  it('emits only a reasoning part when the final answer is empty', () => {
    const planner = new PlanReActPlanner();
    const responseParts = [txt(`some reasoning ${FINAL_ANSWER_TAG}`)];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(result).toHaveLength(1);
    expect(result![0].thought).toBe(true);
    expect(result![0].text).toBe(`some reasoning ${FINAL_ANSWER_TAG}`);
  });

  it.each([PLANNING_TAG, REASONING_TAG, ACTION_TAG, REPLANNING_TAG])(
    'marks text starting with %s as a thought',
    (tag) => {
      const planner = new PlanReActPlanner();
      const responseParts = [txt(`${tag} content`)];

      const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

      expect(result![0].thought).toBe(true);
    },
  );

  it('does not mark plain text (no tag) as a thought', () => {
    const planner = new PlanReActPlanner();
    const responseParts = [txt('just some text')];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(result![0].thought).toBeUndefined();
  });

  it('handles a part with no text and no function call', () => {
    const planner = new PlanReActPlanner();
    const responseParts: Part[] = [{}];

    const result = planner.processPlanningResponse(NO_CONTEXT, responseParts);

    expect(result).toHaveLength(1);
    expect(result![0].thought).toBeUndefined();
  });
});

describe('PlanReActPlanner.buildPlanningInstruction', () => {
  it('returns an instruction containing every tag and the key preamble phrases', () => {
    const planner = new PlanReActPlanner();
    const instruction = planner.buildPlanningInstruction(
      {} as ReadonlyContext,
      {} as LlmRequest,
    );

    for (const tag of [
      PLANNING_TAG,
      REPLANNING_TAG,
      REASONING_TAG,
      ACTION_TAG,
      FINAL_ANSWER_TAG,
    ]) {
      expect(instruction).toContain(tag);
    }
    expect(instruction).toContain('come up with a plan in natural language');
    expect(instruction).toContain(
      'Below are the requirements for the planning:',
    );
  });
});

describe('splitByLastPattern', () => {
  it('splits at the last occurrence of the separator', () => {
    expect(splitByLastPattern('abFOOcd', 'FOO')).toEqual(['abFOO', 'cd']);
  });

  it('splits on the last of multiple occurrences', () => {
    expect(splitByLastPattern('aFOObFOOc', 'FOO')).toEqual(['aFOObFOO', 'c']);
  });

  it('returns [text, ""] when the separator is absent', () => {
    expect(splitByLastPattern('abcd', 'FOO')).toEqual(['abcd', '']);
  });
});

describe('markAsThought', () => {
  it('marks a part with text as a thought', () => {
    const part: Part = {text: 'hello'};
    markAsThought(part);
    expect(part.thought).toBe(true);
  });

  it('does not mark a part with empty text', () => {
    const part: Part = {text: ''};
    markAsThought(part);
    expect(part.thought).toBeUndefined();
  });
});

describe('handleNonFunctionCallParts', () => {
  it('pushes an unmarked part when text is empty', () => {
    const preserved: Part[] = [];
    handleNonFunctionCallParts({}, preserved);
    expect(preserved).toHaveLength(1);
    expect(preserved[0].thought).toBeUndefined();
  });
});
