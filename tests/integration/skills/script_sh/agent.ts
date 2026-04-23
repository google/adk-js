/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  CodeExecutionResult,
  ExecuteCodeParams,
  LlmAgent,
  loadSkillFromDir,
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * A custom CodeExecutor that intercepts specific curl commands used in integration tests.
 *
 * Why:
 * Executing actual curl requests against live external endpoints (like GitHub API) introduces
 * network flakiness, latency, and the risk of rate-limiting, which causes non-deterministic test failures.
 *
 * How:
 * This mock intercepts any shell scripts containing specific GitHub PR URLs and returns pre-recorded
 * deterministic output directly from the expected JSON event files, guaranteeing that the test passes instantly
 * and offline without needing real internet connectivity.
 */
class MockedCurlCodeExecutor extends BaseCodeExecutor {
  private realExecutor = new UnsafeLocalCodeExecutor();

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const code = params.codeExecutionInput.code;
    if (code.includes('https://api.github.com/repos/google/adk-js/pulls/276')) {
      const dir = path.dirname(fileURLToPath(import.meta.url));
      if (code.includes('"title"|"body"')) {
        const stdout = fs.readFileSync(
          path.join(dir, 'mock_pr_description.txt'),
          'utf8',
        );
        return {
          stdout,
          stderr: '',
          outputFiles: [],
        };
      } else if (code.includes('"state":|"merged":')) {
        const stdout = fs.readFileSync(
          path.join(dir, 'mock_pr_status.txt'),
          'utf8',
        );
        return {
          stdout,
          stderr: '',
          outputFiles: [],
        };
      }
    }
    return this.realExecutor.executeCode(params);
  }
}

const skill = await loadSkillFromDir(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../skills/gh-issues',
  ),
);

export const rootAgent = new LlmAgent({
  name: 'test_sh_skill_agent',
  description: 'An agent to test skills.',
  model: 'gemini-3.1-pro-preview',
  tools: [
    new SkillToolset([skill], {
      codeExecutor: new MockedCurlCodeExecutor(),
    }),
  ],
});
