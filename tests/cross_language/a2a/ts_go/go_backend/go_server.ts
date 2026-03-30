/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync, spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {BaseTestServer} from '../../../../integration/test_case_utils.js';

/**
 * Interface representing the parameters for creating the test Go agent server.
 */
export interface TestGoServerParams {
  serverDir: string;
  port?: number;
  startFailureTimeout?: number;
}

const DEFAULT_TIMEOUT = 30000;

/**
 * Go server for testing.
 */
export class AdkGoServer extends BaseTestServer {
  private params: TestGoServerParams;

  constructor(params: TestGoServerParams) {
    super('127.0.0.1', params.port);
    this.params = params;
  }

  async start(): Promise<void> {
    if (!fs.existsSync(path.join(this.params.serverDir, 'go.sum'))) {
      try {
        console.log('Running go mod tidy to fetch dependencies...');
        execSync('go mod tidy', {
          cwd: this.params.serverDir,
          stdio: 'inherit',
          env: process.env,
        });
      } catch (_e: unknown) {
        console.warn(
          'Failed to run go mod tidy, ensure go is installed and network is available.',
        );
      }
    }

    await this.startProcess({
      spawnProcess: () => {
        return spawn('go', ['run', '.'], {
          cwd: this.params.serverDir,
          env: {
            ...process.env,
            PORT: this.port.toString(),
          },
        });
      },
      startMessage: 'A2A Server started on',
      successLogMessage: `Test Go Server started at ${this.url}`,
      serverName: 'Go Server',
      timeoutMs: this.params.startFailureTimeout || DEFAULT_TIMEOUT,
    });
  }
}
