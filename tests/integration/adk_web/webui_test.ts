/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AdkTsApiServer} from '../test_api_server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('WebUI Integration Test', () => {
  let server: AdkTsApiServer;
  let url: string;

  beforeAll(async () => {
    // Use a random free port (0)
    server = new AdkTsApiServer({
      agentsDir: path.resolve(__dirname, '../../dev/samples'),
      port: 0,
      web: true,
    });
    await server.start();
    url = server.url;
  }, 20000); // Increase timeout for server start

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should load the WebUI correctly', async () => {
    return new Promise<void>((resolve, reject) => {
      http
        .get(`${url}/dev-ui/`, (res) => {
          try {
            expect(res.statusCode).toBe(200);

            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });

            res.on('end', () => {
              try {
                // Verify that the response contains typical HTML markers for the WebUI
                expect(data).toContain('<app-root>');
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          } catch (e) {
            reject(e);
          }
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  });
});
