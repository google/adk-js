/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  BaseAgent,
  Event,
  InMemorySessionService,
  isLlmAgent,
  Runner,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {cloneDeep} from 'lodash-es';
import * as assert from 'node:assert';
import {AgentRegistry} from './agent_registry.js';
import {DummyLlm} from './dummy_llm.js';
import {ReplayPlugin} from './replay_plugin.js';
import {
  FilteredEvent,
  FilteredEventActions,
  FilteredPart,
  TestInfo,
  UserMessage,
} from './test_types.js';

const SKIPPED_TESTS = [
  {
    name: 'tool/example_tool_001',
    reason: 'ExampleTool is not implemented yet.',
  },
  {name: 'workflow/loop_001', reason: 'ExitLoopTool is not implemented yet.'},
  {
    name: 'core/multi_005',
    reason: 'Suspected broken test. Need to re-evaluate.',
  },
  {
    name: 'tool/long_running_tool_001',
    reason: 'Suspected broken test. Need to re-evaluate.',
  },
];

export class TestRunner {
  constructor(private agentRegistry: AgentRegistry) {}

  async run(testInfo: TestInfo, force: boolean): Promise<boolean> {
    // skip tests for unimplemented features
    if (!force) {
      for (const skip of SKIPPED_TESTS) {
        if (skip.name == testInfo.name) {
          console.log('Skipping test', testInfo.name, 'because:', skip.reason);
          return true;
        }
      }
    }

    const agentName = testInfo.spec.agent;
    // Use the "short name" in the specs. This could possibly break
    // if there is more than one agent with the same name. Full names
    // are qualified by the file path.
    const agent = this.agentRegistry.getRootAgentByShortName(agentName);
    if (!agent) {
      throw new Error(`Agent ${agentName} not found in registry`);
    }

    // Clone recordings to track consumption without mutating the original test info
    const recordings = cloneDeep(testInfo.recordings.recordings);
    const context = {userMessageIndex: 0};
    injectDummyLlm(agent);

    const replayPlugin = new ReplayPlugin(recordings, context);
    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      agent,
      sessionService,
      plugins: [replayPlugin],
      appName: 'test-runner',
    });

    const userId = 'test-user';
    const sessionId = 'test-session';

    // Create the session explicitly
    await sessionService.createSession({
      appName: 'test-runner',
      userId,
      sessionId,
    });

    const userMessages = testInfo.spec.userMessages!;

    for (let i = 0; i < userMessages.length; i++) {
      context.userMessageIndex = i;
      const userMsg = userMessages[i];
      const content = userMessageToContent(userMsg);

      const iterator = runner.runAsync({
        userId,
        sessionId,
        newMessage: content,
        stateDelta: i === 0 ? testInfo.spec.initialState : undefined,
      });

      for await (const _ of iterator) {
        // Consume events
      }
    }

    const session = await sessionService.getSession({
      appName: 'test-runner',
      userId,
      sessionId,
    });

    if (!session) {
      throw new Error('Session not found after execution');
    }

    validateSession(session, testInfo.session);

    return false;
  }
}

function injectDummyLlm(agent: BaseAgent) {
  if (isLlmAgent(agent)) {
    agent.model = new DummyLlm();
  }

  // Traverse subagents
  const subAgents = agent.subAgents;
  if (subAgents && Array.isArray(subAgents)) {
    for (const sub of subAgents) {
      injectDummyLlm(sub);
    }
  }
}

function userMessageToContent(msg: UserMessage): Content {
  if (msg.content) {
    const content = msg.content;
    content.role = 'user';
    return content;
  }
  if (msg.text) {
    return {role: 'user', parts: [{text: msg.text}]};
  }

  throw new Error('Either Content text or content field is required');
}

function validateSession(actual: Session, expected: Session) {
  const actualEvents = actual.events.map(normalizeEvent);
  const expectedEvents = expected.events.map(normalizeEvent);

  assert.deepStrictEqual(actualEvents, expectedEvents);
}

function normalizeEvent(event: Event): FilteredEvent {
  const filteredEvent = event as FilteredEvent;
  filterEventFields(filteredEvent);
  removeEmptyAndUndefinedFields(
    filteredEvent as unknown as Record<string, unknown>,
  );
  return filteredEvent;
}

function removeEmptyAndUndefinedFields(obj: Record<string, unknown>) {
  for (const key in obj) {
    if (Object.hasOwn(obj, key)) {
      if (obj[key] === undefined || obj[key] === null) {
        delete obj[key];
      } else if (Array.isArray(obj[key])) {
        for (let i = 0; i < obj[key].length; i++) {
          removeEmptyAndUndefinedFields(obj[key][i] as Record<string, unknown>);
        }

        // Remove fields that are just an empty array
        if (obj[key].length === 0) {
          delete obj[key];
          continue;
        }
      } else if (typeof obj[key] === 'object') {
        removeEmptyAndUndefinedFields(obj[key] as Record<string, unknown>);

        // Remove fields that are just an empty object
        if (Object.keys(obj[key] as Record<string, unknown>).length === 0) {
          delete obj[key];
          continue;
        }
      }
    }
  }
}

function filterEventActionsStateDelta(actions?: FilteredEventActions) {
  if (!actions?.stateDelta) {
    return;
  }

  delete actions.stateDelta['_adk_recordings_config'];
  delete actions.stateDelta['_adk_replay_config'];
}

function filterPartFields(part: FilteredPart) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  delete (part as any).thoughtSignature;
  delete (part as any).functionCall;
  delete (part as any).functionResponse;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function filterEventFields(event: FilteredEvent) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  delete (event as any).id;
  delete (event as any).timestamp;
  delete (event as any).invocationId;
  delete (event as any).longRunningToolIds;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  filterEventActionsStateDelta(event.actions);

  if (event.content) {
    event.content.parts?.forEach(filterPartFields);
  }
}
