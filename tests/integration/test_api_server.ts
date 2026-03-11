/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ChildProcessWithoutNullStreams, spawn} from 'node:child_process';
import * as path from 'node:path';
import {AdkApiClient} from '../../dev/src/server/adk_api_client.js';

/**
 * Interface representing the test ADK API server.
 */
export interface TestAdkApiServer {
  host: string;
  port: number;
  start: () => Promise<AdkApiClient>;
  stop: () => Promise<void>;
}

/**
 * Interface representing the parameters for creating the test ADK API server.
 */
export interface TestApiServerParams {
  agentsDir: string;
  port?: number;
  sessionServiceUri?: string;
  artifactServiceUri?: string;
  a2a?: boolean;
}

/**
 * Creates the ADK API server for testing via the CLI. This is useful for integration tests that require an ADK API server to be running.
 * @param params.agentsDir - The directory containing the agent configuration.
 * @returns An object with the server port, a start function that returns an API client, and a stop function to terminate the server.
 */
export function createTestApiServer(
  params: TestApiServerParams,
): TestAdkApiServer {
  let serverProcess: ChildProcessWithoutNullStreams;
  const port = params.port || getRandormPort();

  return {
    host: 'localhost',
    port,
    start: async () => {
      serverProcess = spawn('node', getAdkCliArgs({...params, port}));

      await new Promise<void>((resolve, reject) => {
        let started = false;
        serverProcess.stdout.on('data', (data) => {
          const message = data.toString();
          if (message.includes('ADK API Server started')) {
            started = true;
            console.log(
              `Test ADK API Server started on http://${'localhost'}:${port}`,
            );
            resolve();
          }
        });
        serverProcess.stderr.on('data', (data) => {
          console.error(`CLI Stderr: ${data.toString()}`);
        });
        serverProcess.on('exit', (code) => {
          if (!started)
            reject(new Error(`Server exited prematurely with code ${code}`));
        });
        setTimeout(() => {
          if (!started)
            reject(new Error('Timeout waiting for server to start.'));
        }, 10000);
      });

      return new AdkApiClient({backendUrl: `http://localhost:${port}`});
    },
    stop: async () => {
      if (serverProcess) {
        serverProcess.kill('SIGINT');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
  };
}

function getRandormPort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

function getAdkCliArgs(params: TestApiServerParams): string[] {
  const cliPath = path.resolve(__dirname, '../../dev/dist/cli_entrypoint.mjs');
  const args = [
    cliPath,
    'api_server',
    params.agentsDir,
    '--port',
    params.port!.toString(),
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
