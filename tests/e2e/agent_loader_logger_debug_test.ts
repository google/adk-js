/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawnSync} from 'node:child_process';
import * as path from 'node:path';
import {expect, it} from 'vitest';

const DEBUG_MARKER = 'AGENT_LOADER_DEBUG_LOG_VISIBLE';

it('shares CLI log-level settings with code in a bundled agent file', () => {
  const cliPath = path.resolve('dev/dist/esm/cli_entrypoint.js');
  const agentPath = path.resolve(
    'tests/e2e/fixtures/agent_loader_logger_debug.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [cliPath, 'run', agentPath, '--verbose'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: 'exit\n',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).toContain(DEBUG_MARKER);
}, 35_000);
