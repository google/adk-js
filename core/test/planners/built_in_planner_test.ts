/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BuiltInPlanner,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({id: 'session-1', appName: 'test-app'}),
    pluginManager: new PluginManager(),
  });
}

function makeLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}, ...overrides};
}

describe('BuiltInPlanner', () => {
  it('stores the thinking config passed to the constructor', () => {
    const thinkingConfig = {includeThoughts: true, thinkingBudget: 1024};
    const planner = new BuiltInPlanner({thinkingConfig});

    expect(planner.thinkingConfig).toBe(thinkingConfig);
  });

  it('creates the request config when it is absent', () => {
    const thinkingConfig = {includeThoughts: true};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = makeLlmRequest();

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config).toEqual({thinkingConfig});
  });

  it('keeps the other config fields', () => {
    const thinkingConfig = {thinkingBudget: 512};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = makeLlmRequest({
      config: {temperature: 0.5, systemInstruction: 'Be brief.'},
    });

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config).toEqual({
      temperature: 0.5,
      systemInstruction: 'Be brief.',
      thinkingConfig,
    });
  });

  it('overwrites an existing thinking config', () => {
    const thinkingConfig = {thinkingBudget: 2048};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = makeLlmRequest({
      config: {thinkingConfig: {includeThoughts: true, thinkingBudget: 0}},
    });

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config?.thinkingConfig).toBe(thinkingConfig);
  });

  it('returns no planning instruction', () => {
    const planner = new BuiltInPlanner({thinkingConfig: {}});
    const readonlyContext = new ReadonlyContext(makeInvocationContext());

    expect(
      planner.buildPlanningInstruction(readonlyContext, makeLlmRequest()),
    ).toBeUndefined();
  });

  it('does not process the planning response', () => {
    const planner = new BuiltInPlanner({thinkingConfig: {}});
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(
      planner.processPlanningResponse(context, [{text: 'hello'}]),
    ).toBeUndefined();
  });
});
