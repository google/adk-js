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

  it('F1: sibling artifact saves to the same filename collide on one version', async () => {
    // Both siblings read the artifact version listing before either writes,
    // so both save as version 0 and one payload is lost. The merged
    // artifactDelta records a single save although two happened. A per-file
    // serialization fix should invert this to versions [0, 1].
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
    expect(versions?.sort()).toEqual([0, 0]);
    expect(event?.actions.artifactDelta).toEqual({'report.txt': 0});
    expect(await artifactService.listVersions('report.txt')).toEqual([0]);
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

  it('F2: the committed blend is a null-prototype object', async () => {
    // deepMergeStateValues allocates merged levels with Object.create(null)
    // and updateSessionState stores the value verbatim, so a key two siblings
    // collided on holds an object with no Object.prototype: hasOwnProperty is
    // undefined and template interpolation throws. A fix that merges into a
    // plain object (pollution safety comes from setOwnProperty, not the null
    // prototype) should invert these assertions.
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
    expect(Object.getPrototypeOf(profile)).toBeNull();
    expect(profile.hasOwnProperty).toBeUndefined();
    expect(() => `${profile}`).toThrow(TypeError);
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
