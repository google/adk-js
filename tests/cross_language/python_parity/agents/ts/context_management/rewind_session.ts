/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/context_management/rewind_session.
 *
 * Ported as literally as the two APIs allow: same agent name, same tool names,
 * same parameter names, same instruction text, same response shapes.
 *
 * The rewind itself is *not* ported, because it does not exist here: the
 * Python sample's `main.py` drives `Runner.rewind_async(...,
 * rewind_before_invocation_id=...)`, and adk-js `Runner` has no `rewind`
 * method and the session services have no event-truncating counterpart. A
 * replayed `adk run` never rewinds on either side, so what this case compares
 * is the state/artifact agent the rewind sample is built on.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const updateState = new FunctionTool({
  name: 'update_state',
  description: 'Updates a state value.',
  parameters: z.object({
    key: z.string(),
    value: z.string(),
  }),
  execute: ({key, value}, toolContext) => {
    toolContext?.state.set(key, value);
    return {status: `Updated state '${key}' to '${value}'`};
  },
});

const loadState = new FunctionTool({
  name: 'load_state',
  description: 'Loads a state value.',
  parameters: z.object({
    key: z.string(),
  }),
  execute: ({key}, toolContext) => {
    return {[key]: toolContext?.state.get(key) ?? null};
  },
});

const saveArtifact = new FunctionTool({
  name: 'save_artifact',
  description: 'Saves an artifact with the given filename and content.',
  parameters: z.object({
    filename: z.string(),
    content: z.string(),
  }),
  execute: async ({filename, content}, toolContext) => {
    const artifactBytes = Buffer.from(content, 'utf8');
    const version = await toolContext!.saveArtifact(filename, {
      inlineData: {
        mimeType: 'text/plain',
        data: artifactBytes.toString('base64'),
      },
    });
    return {status: 'success', filename, version};
  },
});

const loadArtifact = new FunctionTool({
  name: 'load_artifact',
  description: 'Loads an artifact with the given filename.',
  parameters: z.object({
    filename: z.string(),
  }),
  execute: async ({filename}, toolContext) => {
    const artifact = await toolContext!.loadArtifact(filename);
    if (!artifact) {
      return {error: `Artifact '${filename}' not found`};
    }
    const content = Buffer.from(
      artifact.inlineData?.data ?? '',
      'base64',
    ).toString('utf8');
    return {filename, content};
  },
});

// Create the agent
export const rootAgent = new LlmAgent({
  name: 'state_agent',
  model: PARITY_MODEL,
  instruction: `You are an agent that manages state and artifacts.

    You can:
    - Update state value
    - Load state value
    - Save artifact
    - Load artifact

    Use the appropriate tool based on what the user asks for.`,
  tools: [updateState, loadState, saveArtifact, loadArtifact],
});
