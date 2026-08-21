/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  FileArtifactService,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  functionsExportedForTestingOnly,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

function callFor(tool: BaseTool): FunctionCall {
  return {id: `${tool.name}_${Math.random()}`, name: tool.name, args: {}};
}

describe('parallel tool calls (characterization for PR #770 review F1/F2)', () => {
  let rootDir: string;
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-parallel-tools-'));
    sessionService = new InMemorySessionService();
  });

  afterEach(async () => {
    await fs.rm(rootDir, {recursive: true, force: true});
  });

  async function makeSessionInvocation() {
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
    });
    const artifactService = new ScopedArtifactService(
      new FileArtifactService(rootDir),
      'test_app',
      'test_user',
      session.id,
    );
    const invocationContext = new InvocationContext({
      invocationId: 'inv_parallel',
      session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager: new PluginManager(),
      artifactService,
    });
    return {session, invocationContext, artifactService};
  }

  const makeSaverTool = (name: string, payload: string) =>
    new FunctionTool({
      name,
      description: name,
      parameters: z.object({}),
      execute: async (_args, context) => {
        const version = await context!.saveArtifact('report.txt', {
          text: payload,
        });
        return {version};
      },
    });

  it('F1: sibling artifact saves to the same filename get distinct versions', async () => {
    // The backends serialize the per-file version read-modify-write, so
    // sibling saves both land: distinct versions, both payloads on disk.
    // The merged artifactDelta records the highest version — the surviving
    // payload — regardless of which sibling drew it.
    const {invocationContext, artifactService} = await makeSessionInvocation();
    const toolA = makeSaverTool('saverA', 'payload-A');
    const toolB = makeSaverTool('saverB', 'payload-B');

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(toolA), callFor(toolB)],
      toolsDict: {saverA: toolA, saverB: toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const versions = event?.content?.parts?.map(
      (part) => (part.functionResponse?.response as {version: number}).version,
    );
    expect(versions?.slice().sort()).toEqual([0, 1]);
    expect(event?.actions.artifactDelta).toEqual({'report.txt': 1});
    expect(await artifactService.listVersions('report.txt')).toEqual([0, 1]);
  });

  const makeProfileTool = (name: string, subKey: string, delayMs: number) =>
    new FunctionTool({
      name,
      description: name,
      parameters: z.object({}),
      execute: async (_args, context) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        context!.state.set('profile', {[subKey]: name});
        return {result: name};
      },
    });

  it('F2: the committed blend is an ordinary plain object', async () => {
    // The deep merge produces plain objects (pollution safety comes from
    // storing own properties via defineProperty, not from a null prototype),
    // so a key two siblings collided on behaves like every other state value:
    // Object.prototype methods work and template interpolation is safe.
    const {session, invocationContext} = await makeSessionInvocation();
    const toolA = makeProfileTool('profileA', 'age', 10);
    const toolB = makeProfileTool('profileB', 'name', 0);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(toolA), callFor(toolB)],
      toolsDict: {profileA: toolA, profileB: toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    await sessionService.appendEvent({session, event: event!});

    const profile = session.state.profile as Record<string, unknown>;
    expect(profile).toEqual({age: 'profileA', name: 'profileB'});
    expect(Object.getPrototypeOf(profile)).toBe(Object.prototype);
    expect(typeof profile.hasOwnProperty).toBe('function');
    expect(() => `${profile}`).not.toThrow();
  });

  it('F2 control: a single-writer value keeps Object.prototype', async () => {
    const {session, invocationContext} = await makeSessionInvocation();
    const toolA = makeProfileTool('profileA', 'age', 0);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(toolA)],
      toolsDict: {profileA: toolA},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    await sessionService.appendEvent({session, event: event!});

    const profile = session.state.profile as Record<string, unknown>;
    expect(Object.getPrototypeOf(profile)).toBe(Object.prototype);
    expect(() => `${profile}`).not.toThrow();
  });
});
