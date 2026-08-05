/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LlmAgent,
  loadSkillFromDir,
  SkillToolset,
  ToolConfirmation,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  GeminiWithMockResponses,
  type RawGenerateContentResponse,
} from '../../test_case_utils.js';
import modelResponses from './model_responses.json' with {type: 'json'};

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));

const skill = await loadSkillFromDir(
  path.join(PROJECT_DIR, '../skills/algorithmic-art'),
);

export const rootAgent = new LlmAgent({
  name: 'test_algorithmic_art_skill_agent',
  description: 'An agent to test skills.',
  model: new GeminiWithMockResponses(
    modelResponses as RawGenerateContentResponse[],
  ),
  tools: [
    new SkillToolset([skill], {
      codeExecutor: new UnsafeLocalCodeExecutor(),
      // Inline-script execution is opt-in; enable it for this end-to-end test.
      allowInlineScripts: true,
      // Script output defaults to a private temp dir so that script-chosen file
      // names cannot land in the host app's working directory. This test asserts
      // on the generated artwork files, so point it at the project dir - which
      // is what the agent is expected to produce into here.
      scriptOutputDir: PROJECT_DIR,
    }),
  ],
  // Executing model-provided inline scripts is gated behind a confirmation
  // (see run_skill_inline_script_tool.ts). This trusted, non-interactive
  // integration agent auto-approves that gate so the end-to-end flow can run.
  beforeToolCallback: ({tool, context}) => {
    if (tool.name === 'run_skill_inline_script') {
      context.toolConfirmation = new ToolConfirmation({confirmed: true});
    }
    return undefined;
  },
});
