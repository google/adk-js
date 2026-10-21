/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createEventActions, createSession} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {AgentRegistry} from '../../src/integration/agent_registry.js';
import {YamlAgentConfig} from '../../src/integration/agent_types.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';
import {TestRunner} from '../../src/integration/test_runner.js';
import {TestInfo} from '../../src/integration/test_types.js';

const ROOT_AGENT = 'loop_root_agent';
const SUB_AGENT = 'refiner_agent';
const USER_MESSAGE = 'Refine the poem.';

/**
 * Registers the in-memory equivalent of the `workflow/loop_001` conformance
 * corpus: a LoopAgent whose only sub-agent calls `exit_loop`.
 */
function registerLoopAgents(registry: AgentRegistry) {
  registry.registerAgentConfig('loop_test/refiner_agent', {
    name: SUB_AGENT,
    model: 'gemini-2.5-flash',
    description: 'Refines a poem.',
    instruction: 'Refine the poem, then call exit_loop.',
    agentClass: 'LlmAgent',
    tools: [{name: 'exit_loop'}],
  } as unknown as YamlAgentConfig);

  registry.registerAgentConfig('loop_test/root_agent', {
    name: ROOT_AGENT,
    model: 'gemini-2.5-flash',
    description: 'Loops until the refiner exits.',
    instruction: '',
    agentClass: 'LoopAgent',
    maxIterations: '3',
    isRootAgent: true,
    subAgents: [{configPath: 'loop_test/refiner_agent'}],
  } as unknown as YamlAgentConfig);
}

/**
 * The session the harness must reproduce: the refiner agent calls `exit_loop`
 * once and the LoopAgent stops, so there is exactly one iteration. The final
 * function-response event carries `escalate` / `skipSummarization`, which only
 * happens when the `exit_loop` tool is resolved and its side effects replayed.
 *
 * The fixture keeps the shape of a recorded `generated-session.yaml`, but note
 * that `filterPartFields` strips `functionCall` / `functionResponse` from every
 * part before the comparison, so those payloads are documentation rather than
 * assertions.
 */
function expectedSession() {
  return createSession({
    id: 'expected-session',
    appName: 'test-runner',
    events: [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: USER_MESSAGE}]},
      }),
      createEvent({
        author: SUB_AGENT,
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'exit_loop', args: {}}}],
        },
      }),
      createEvent({
        author: SUB_AGENT,
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'exit_loop', response: {result: null}}},
          ],
        },
        actions: {
          ...createEventActions(),
          escalate: true,
          skipSummarization: true,
        },
      }),
    ],
  });
}

function loopTestInfo(): TestInfo {
  return {
    name: 'workflow/loop_001',
    spec: {
      description: 'The refiner agent exits the loop on the first iteration.',
      agent: 'loop_test',
      userMessages: [{text: USER_MESSAGE}],
    },
    recordings: {
      recordings: [
        {
          userMessageIndex: 0,
          agentName: SUB_AGENT,
          llmRecording: {
            llmResponse: {
              content: {
                role: 'model',
                parts: [{functionCall: {name: 'exit_loop', args: {}}}],
              },
            },
          },
        },
        {
          userMessageIndex: 0,
          agentName: SUB_AGENT,
          toolRecording: {
            toolCall: {name: 'exit_loop'},
            toolResponse: {response: {result: null}},
          },
        },
      ],
    },
    session: expectedSession(),
  };
}

describe('TestRunner', () => {
  let registry: AgentRegistry;
  let testRunner: TestRunner;

  beforeEach(() => {
    registry = new AgentRegistry(new IntegrationRegistry());
    testRunner = new TestRunner(registry);
  });

  it('replays a loop agent that exits via the exit_loop built-in tool', async () => {
    registerLoopAgents(registry);

    await expect(testRunner.run(loopTestInfo(), false)).resolves.toBe(false);
  });
});
