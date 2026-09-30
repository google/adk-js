/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {runAgent} from '../../src/cli/cli_run.js';
import {AgentFile} from '../../src/utils/agent_loader.js';
import {loadFileData} from '../../src/utils/file_utils.js';

// Only the agent file loading and the replay file are faked. `@google/adk`
// stays real so the error travels the same path it does in production:
// model throws -> LlmAgent turns it into an event carrying errorCode /
// errorMessage and no content -> the CLI has to print it.
vi.mock('../../src/utils/agent_loader.js', () => ({AgentFile: vi.fn()}));
// getAbsolutePath is the real resolver; only the I/O is faked.
vi.mock('../../src/utils/file_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/file_utils.js')>()),
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
}));

/** Verbatim body the Gemini API returns for a rejected API key. */
const INVALID_API_KEY_RESPONSE = JSON.stringify({
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
  },
});

class RejectingLlm extends BaseLlm {
  // eslint-disable-next-line require-yield
  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    throw new Error(INVALID_API_KEY_RESPONSE);
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

describe('adk run with an invalid API key', () => {
  let errorSpy: Mock;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {}) as unknown as Mock;
    originalExitCode = process.exitCode;

    const rootAgent = new LlmAgent({
      name: 'test_agent',
      model: new RejectingLlm({model: 'gemini-flash-latest'}),
    });
    (AgentFile as unknown as Mock).mockImplementation(() => ({
      load: async () => rootAgent,
      [Symbol.asyncDispose]: async () => {},
    }));
    (loadFileData as Mock).mockResolvedValue({state: {}, queries: ['hello']});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it('writes a diagnostic to stderr and exits non-zero', async () => {
    await runAgent({agentPath: 'agent.ts', inputFile: 'input.json'});

    expect(errorSpy).toHaveBeenCalled();
    const stderr = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .join('\n');
    expect(stderr).not.toBe('');
    expect(stderr).toContain('API key not valid');
    expect(process.exitCode).toBe(1);
  });
});
