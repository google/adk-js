/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '@google/adk';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AdkTsApiServer} from '../../../integration/test_api_server.js';
import {GoAgent} from './go_client/go_agent.js';

const TIMEOUT = 60000;

describe(
  'A2A ADK Cross-Language Integration: Go <--A2A--> TS',
  () => {
    let tsServer: AdkTsApiServer;

    beforeAll(async () => {
      tsServer = new AdkTsApiServer({
        agentsDir: path.resolve(__dirname, 'ts_backend'),
        a2a: true,
        startFailureTimeout: TIMEOUT,
      });
      await tsServer.start();
    }, TIMEOUT);

    afterAll(async () => {
      await tsServer.stop();
    }, TIMEOUT);

    it(
      'Should connect to TS agent and receive expected response',
      async () => {
        const goAgent = new GoAgent({
          dir: path.resolve(__dirname, 'go_client'),
          agentUrl: `${tsServer.url}/a2a/basic_agent/`,
        });

        const events: Event[] = [];
        for await (const chunk of goAgent.run('Hello TS Agent From Go!')) {
          events.push(chunk);
        }

        expect(events.length).toBe(2);
        const hasExpectedText = events.some((event) =>
          event.content?.parts?.some((part) =>
            part.text?.includes('Hello from TS basic agent'),
          ),
        );
        expect(hasExpectedText).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'Should handle InputRequired from TS agent',
      async () => {
        const goAgent = new GoAgent({
          dir: path.resolve(__dirname, 'go_client'),
          agentUrl: `${tsServer.url}/a2a/hitl_agent/`,
        });

        const events: Event[] = [];
        for await (const event of goAgent.run('Need approval')) {
          events.push(event);
        }

        expect(events.length).toBe(2);
        const lastEvent = events[events.length - 1];
        const hasApprovalTool = events.some((event) =>
          event.content?.parts?.some(
            (part) => part.functionCall?.name === 'request_approval',
          ),
        );
        expect(hasApprovalTool).toBe(true);
        expect(lastEvent.longRunningToolIds).toBeDefined();
        expect(lastEvent.longRunningToolIds).toContain('call-123');
      },
      TIMEOUT,
    );
  },
  TIMEOUT,
);
