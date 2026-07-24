/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BuiltInPlanner,
  Context,
  LlmRequest,
  ReadonlyContext,
} from '@google/adk';
import {ThinkingConfig} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createLlmRequest(config?: LlmRequest['config']): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}, config};
}

describe('BuiltInPlanner', () => {
  it('applyThinkingConfig creates config when it is undefined', () => {
    const thinkingConfig: ThinkingConfig = {includeThoughts: true};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = createLlmRequest();

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config).toBeDefined();
    expect(llmRequest.config?.thinkingConfig).toBe(thinkingConfig);
  });

  it('applyThinkingConfig sets thinkingConfig when config already exists', () => {
    const thinkingConfig: ThinkingConfig = {thinkingBudget: 1024};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = createLlmRequest({temperature: 0.5});

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config?.temperature).toBe(0.5);
    expect(llmRequest.config?.thinkingConfig).toBe(thinkingConfig);
  });

  it('applyThinkingConfig overwrites a pre-existing thinkingConfig', () => {
    const previousThinkingConfig: ThinkingConfig = {includeThoughts: false};
    const thinkingConfig: ThinkingConfig = {includeThoughts: true};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = createLlmRequest({
      thinkingConfig: previousThinkingConfig,
    });

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config?.thinkingConfig).toBe(thinkingConfig);
    expect(llmRequest.config?.thinkingConfig).not.toBe(previousThinkingConfig);
  });

  it('applyThinkingConfig is a no-op when thinkingConfig is absent', () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    // Simulate a falsy thinkingConfig to exercise the guard's else branch.
    (planner as {thinkingConfig?: ThinkingConfig}).thinkingConfig = undefined;
    const llmRequest = createLlmRequest();

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config).toBeUndefined();
  });

  it('buildPlanningInstruction returns undefined', () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    expect(
      planner.buildPlanningInstruction(
        {} as ReadonlyContext,
        createLlmRequest(),
      ),
    ).toBeUndefined();
  });

  it('processPlanningResponse returns undefined', () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    expect(planner.processPlanningResponse({} as Context, [])).toBeUndefined();
  });
});
