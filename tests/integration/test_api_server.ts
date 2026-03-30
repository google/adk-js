/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import * as path from 'node:path';
import {AdkApiClient} from '../../dev/src/server/adk_api_client.js';
import {BaseTestServer} from './test_case_utils.js';

/**
 * Interface representing the parameters for creating the test ADK API server.
 */
export interface TestApiServerParams {
  agentsDir: string;
  port?: number;
  sessionServiceUri?: string;
  artifactServiceUri?: string;
  a2a?: boolean;
  startFailureTimeout?: number;
}

const DEFAULT_TIMEOUT = 10000;

/**
 * ADK API server for testing via the CLI. This is useful for integration tests
 * that require an ADK API server to be running.
 */
export class AdkTsApiServer extends BaseTestServer {
  private params: TestApiServerParams;

  constructor(params: TestApiServerParams) {
    super('localhost', params.port);
    this.params = params;
  }

  async start(): Promise<AdkApiClient> {
    await this.startProcess({
      spawnProcess: () => {
        return spawn('node', this.getAdkCliArgs(this.params), {
          env: {
            ...process.env,
            TEST_API_SERVER_PORT: this.port.toString(),
          },
        });
      },
      startMessage: 'ADK API Server started',
      successLogMessage: `Test ADK API Server started on http://${this.host}:${this.port}`,
      serverName: 'CLI',
      timeoutMs: this.params.startFailureTimeout || DEFAULT_TIMEOUT,
    });

    return new AdkApiClient({backendUrl: this.url});
  }

  private getAdkCliArgs(params: TestApiServerParams): string[] {
    const cliPath = path.resolve(
      __dirname,
      '../../dev/dist/cli_entrypoint.mjs',
    );
    const args = [
      cliPath,
      'api_server',
      params.agentsDir,
      '--port',
      this.port.toString(),
      '--allow_origins',
      '*',
    ];

    if (params.sessionServiceUri) {
      args.push('--session_service_uri', params.sessionServiceUri);
    }
    if (params.artifactServiceUri) {
      args.push('--artifact_service_uri', params.artifactServiceUri);
    }
    if (params.a2a) {
      args.push('--a2a');
    }

    return args;
  }
}
