/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseLlm,
  FunctionTool,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {createUserContent, FinishReason} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../../integration/test_case_utils.js';

const APP_NAME = 'e2e_forwarding_artifact_test';
const USER_ID = 'e2e_user';
const ARTIFACT_FILENAME = 'e2e_report.txt';
const ARTIFACT_TEXT = 'E2E status OK';
const LIVE_MODEL = 'gemini-2.5-flash';

/**
 * Records what the tools observed while running, so the assertions can run
 * after the agent loop finishes instead of inside a tool callback.
 */
interface ArtifactFlowProbe {
  /** Version returned by the sub-agent's `toolContext.saveArtifact`. */
  savedVersion?: number;
  /** Text the parent agent read back via `toolContext.loadArtifact`. */
  loadedText?: string;
}

/**
 * Builds the parent agent used by both the deterministic and the live test.
 *
 * The sub-agent saves an artifact through `toolContext.saveArtifact` (i.e.
 * through the {@link AgentTool}-installed `ForwardingArtifactService`, with no
 * appName/userId/sessionId arguments), and the parent agent reads it back
 * through its own `toolContext.loadArtifact`.
 */
function createParentAgent(
  probe: ArtifactFlowProbe,
  subAgentModel: string | BaseLlm,
  parentAgentModel: string | BaseLlm,
): LlmAgent {
  const subAgentSaveTool = new FunctionTool({
    name: 'sub_agent_save_tool',
    description: 'Saves text to an artifact via SessionArtifactService.',
    parameters: z.object({
      filename: z.string(),
      text: z.string(),
    }),
    execute: async ({filename, text}, toolContext) => {
      // `FunctionTool` types the tool context as optional, but the runner
      // always supplies it. Narrow explicitly so a missing context fails the
      // test loudly rather than being papered over by a bare `!`.
      expect(
        toolContext,
        'sub_agent_save_tool did not receive a tool context',
      ).toBeDefined();
      probe.savedVersion = await toolContext!.saveArtifact(filename, {text});
      return `Sub-agent saved ${filename} with version ${probe.savedVersion}`;
    },
  });

  const subAgent = new LlmAgent({
    name: 'sub_agent',
    description: 'A sub-agent that saves artifacts.',
    instruction: 'When asked, call sub_agent_save_tool with filename and text.',
    model: subAgentModel,
    tools: [subAgentSaveTool],
  });

  const parentAgentVerifyTool = new FunctionTool({
    name: 'parent_agent_verify_tool',
    description:
      'Loads an artifact from session store via SessionArtifactService.',
    parameters: z.object({
      filename: z.string(),
    }),
    execute: async ({filename}, toolContext) => {
      expect(
        toolContext,
        'parent_agent_verify_tool did not receive a tool context',
      ).toBeDefined();
      const loadedPart = await toolContext!.loadArtifact(filename);
      probe.loadedText = loadedPart?.text;
      return `Parent agent loaded text: ${probe.loadedText}`;
    },
  });

  return new LlmAgent({
    name: 'parent_agent',
    description: 'A parent agent.',
    instruction:
      `Call your sub_agent tool to save an artifact named ${ARTIFACT_FILENAME} ` +
      `with text "${ARTIFACT_TEXT}". After that finishes, call ` +
      `parent_agent_verify_tool to verify the file ${ARTIFACT_FILENAME}.`,
    model: parentAgentModel,
    tools: [new AgentTool({agent: subAgent}), parentAgentVerifyTool],
  });
}

function textResponse(text: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {parts: [{text}], role: 'model'},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

function functionCallResponse(
  name: string,
  args: Record<string, unknown>,
  id: string,
): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {parts: [{functionCall: {name, args, id}}], role: 'model'},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/**
 * Asserts that the artifact really landed in `artifactService` — the instance
 * the test owns and handed to the `Runner`. If the runner ignored it (or the
 * sub-agent wrote somewhere else), these reads come back empty.
 */
async function expectArtifactStoredIn(
  artifactService: InMemoryArtifactService,
  sessionId: string,
  probe: ArtifactFlowProbe,
): Promise<void> {
  // The sub-agent's save must have been forwarded to the parent session's
  // artifact service.
  const storedPart = await artifactService.loadArtifact({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId,
    filename: ARTIFACT_FILENAME,
  });
  expect(storedPart).toBeDefined();
  expect(storedPart!.text).toBe(ARTIFACT_TEXT);

  const keys = await artifactService.listArtifactKeys({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId,
  });
  expect(keys).toContain(ARTIFACT_FILENAME);

  // The version handed back to the sub-agent must address that same artifact.
  expect(probe.savedVersion).toBeGreaterThanOrEqual(0);
  const versionedPart = await artifactService.loadArtifact({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId,
    filename: ARTIFACT_FILENAME,
    version: probe.savedVersion,
  });
  expect(versionedPart?.text).toBe(ARTIFACT_TEXT);

  // ...and the parent agent must have read the same value back out through
  // its own tool context.
  expect(probe.loadedText).toBe(ARTIFACT_TEXT);
}

describe('E2E ForwardingArtifactService & AgentTool Artifact Flow', () => {
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  // Hitting a real model is opt-in. Credentials alone are not enough: an
  // ambient GOOGLE_CLOUD_PROJECT on a developer machine must not silently
  // change what this file tests. Run with `ADK_E2E_LIVE=1` to also exercise
  // the live-model variant.
  const runLive = process.env.ADK_E2E_LIVE === '1' && hasAKey;

  it('forwards a sub-agent artifact save into the parent runner artifact service', async () => {
    const artifactService = new InMemoryArtifactService();
    const sessionService = new InMemorySessionService();
    const memoryService = new InMemoryMemoryService();
    const probe: ArtifactFlowProbe = {};

    const parentAgent = createParentAgent(
      probe,
      new GeminiWithMockResponses([
        functionCallResponse(
          'sub_agent_save_tool',
          {filename: ARTIFACT_FILENAME, text: ARTIFACT_TEXT},
          'sub-call-1',
        ),
        textResponse('Artifact saved.'),
      ]),
      new GeminiWithMockResponses([
        functionCallResponse(
          'sub_agent',
          {request: `save ${ARTIFACT_FILENAME}`},
          'parent-call-1',
        ),
        functionCallResponse(
          'parent_agent_verify_tool',
          {filename: ARTIFACT_FILENAME},
          'parent-call-2',
        ),
        textResponse('Verified.'),
      ]),
    );

    // `Runner` (unlike `InMemoryRunner`) accepts an explicit artifact service,
    // so the service asserted on below is genuinely the one under test.
    const runner = new Runner({
      appName: APP_NAME,
      agent: parentAgent,
      sessionService,
      memoryService,
      artifactService,
    });

    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    for await (const _event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: createUserContent(
        `Please instruct sub_agent to save ${ARTIFACT_FILENAME} with text ` +
          `"${ARTIFACT_TEXT}", then load and verify it.`,
      ),
    })) {
      // Drain the event stream.
    }

    await expectArtifactStoredIn(artifactService, session.id, probe);
  });

  it.skipIf(!runLive)(
    'forwards a sub-agent artifact save when driven by a live model',
    async () => {
      const artifactService = new InMemoryArtifactService();
      const sessionService = new InMemorySessionService();
      const memoryService = new InMemoryMemoryService();
      const probe: ArtifactFlowProbe = {};

      const parentAgent = createParentAgent(probe, LIVE_MODEL, LIVE_MODEL);

      const runner = new Runner({
        appName: APP_NAME,
        agent: parentAgent,
        sessionService,
        memoryService,
        artifactService,
      });

      const session = await sessionService.createSession({
        appName: APP_NAME,
        userId: USER_ID,
      });

      for await (const _event of runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: createUserContent(
          `Please instruct sub_agent to save ${ARTIFACT_FILENAME} with text ` +
            `"${ARTIFACT_TEXT}", then load and verify it.`,
        ),
      })) {
        // Drain the event stream.
      }

      await expectArtifactStoredIn(artifactService, session.id, probe);
    },
  );
});
