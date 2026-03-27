/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '@google/adk';
import {execSync, spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

export interface GoAgentParams {
  dir: string;
  agentUrl: string;
}

/**
 * A TS client for a Go agent that communicates with Go agent file using command line.
 */
export class GoAgent {
  private readonly dir: string;
  private readonly agentUrl: string;

  constructor(params: GoAgentParams) {
    this.dir = params.dir;
    this.agentUrl = params.agentUrl;
  }

  public async *run(userMessage: string): AsyncGenerator<Event, void, unknown> {
    if (!fs.existsSync(path.join(this.dir, 'go.sum'))) {
      try {
        execSync('go mod tidy', {
          cwd: this.dir,
          stdio: 'inherit',
          env: process.env,
        });
      } catch (_e: unknown) {
        console.warn('Failed to run go mod tidy');
      }
    }

    const child = spawn(
      'go',
      [
        'run',
        '.',
        `-agent_url=${this.agentUrl}`,
        `-agent_input=${userMessage}`,
      ],
      {
        cwd: this.dir,
        env: process.env,
      },
    );

    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        yield JSON.parse(line) as Event;
      }
    }

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          console.error('STDERR:', stderr);
          reject(
            new Error(`Process exited with code ${code}\nStderr: ${stderr}`),
          );
        }
      });
    });
  }
}
