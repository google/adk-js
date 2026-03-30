/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, RemoteA2AAgent} from '@google/adk';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createRunner} from '../../../integration/test_case_utils.js';
import {AdkGoServer} from './go_backend/go_server.js';

const TIMEOUT = 60000;

describe(
  'A2A ADK Cross-Language Integration: TS <--A2A--> Go',
  () => {
    let goServer: AdkGoServer;

    beforeAll(async () => {
      goServer = new AdkGoServer({
        serverDir: path.resolve(__dirname, 'go_backend'),
      });
      await goServer.start();
    }, TIMEOUT);

    afterAll(async () => {
      await goServer.stop();
    }, TIMEOUT);

    it(
      'Should connect to Go agent and receive mock response',
      async () => {
        const remoteA2AAgent = new RemoteA2AAgent({
          name: 'remote_go_agent',
          description: 'A mock Go agent for testing over a2a',
          agentCard: `${goServer.url}/a2a/basic_agent/`,
        });

        const runner = await createRunner(remoteA2AAgent);
        const events: Event[] = [];

        for await (const event of runner.run('Hello Go Agent From TS!')) {
          events.push(event);
        }

        expect(events.length).toBeGreaterThan(0);
        const containsExpectedText = events.some((e) =>
          e.content?.parts?.some((p) =>
            p.text?.includes('Hello from Go test agent'),
          ),
        );
        expect(containsExpectedText).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'Should handle InputRequired from Go agent',
      async () => {
        const remoteA2AAgent = new RemoteA2AAgent({
          name: 'remote_hitl_agent',
          description: 'A mock hitl agent',
          agentCard: `${goServer.url}/a2a/hitl_agent/`,
        });

        const runner = await createRunner(remoteA2AAgent);
        const events: Event[] = [];

        for await (const event of runner.run('Need approval')) {
          events.push(event);
        }

        expect(events.length).toBe(1);
        const hasApprovalTool = events.some((event) =>
          event.content?.parts?.some(
            (part) => part.functionCall?.name === 'request_approval',
          ),
        );
        const lastEvent = events[events.length - 1];
        expect(lastEvent.longRunningToolIds).toBeDefined();
        expect(hasApprovalTool).toBe(true);
        expect(lastEvent.longRunningToolIds).toContain('call-123');
      },
      TIMEOUT,
    );
  },
  TIMEOUT,
);
