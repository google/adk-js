/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: a workflow node that requires an API-key credential
 * interrupts on the first turn and runs once the credential is supplied on
 * resume (mirrors the Python `workflows/auth_api_key` sample).
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  FunctionNode,
  NodeContext,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  collect,
  createWorkflowRunner,
  finalOutput,
} from '../_harness/workflow_test_utils.js';

const CREDENTIAL_KEY = 'weather_api';

function apiKeyAuthConfig(): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'} as AuthScheme,
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
    credentialKey: CREDENTIAL_KEY,
  };
}

describe('workflow integration — auth gate (API key)', () => {
  it('requests credentials, then runs after they are supplied on resume', async () => {
    let runs = 0;
    const secured = new FunctionNode(
      'secured',
      (ctx: NodeContext) => {
        runs++;
        const cred = ctx.state.get<AuthCredential>('temp:' + CREDENTIAL_KEY);
        return `weather(key=${cred?.apiKey})`;
      },
      // Auth-gated nodes re-run on resume to store the credential and run their
      // body (Python's auth samples set rerun_on_resume=True).
      {authConfig: apiKeyAuthConfig(), rerunOnResume: true},
    );
    const wf = new Workflow({
      name: 'auth_api_key',
      edges: [['START', secured]],
    });
    const {run} = await createWorkflowRunner(wf);

    // Turn 1: no credential -> auth request interrupt; handler NOT run.
    const turn1 = await collect(run('what is the weather?'));
    expect(runs).toBe(0);
    expect(
      turn1.some((e) =>
        (e.content?.parts ?? []).some(
          (p) => p.functionCall?.name === 'adk_request_credential',
        ),
      ),
    ).toBe(true);

    // Turn 2: supply the credential -> node runs with it.
    const credentialResponse: AuthConfig = {
      authScheme: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      } as AuthScheme,
      credentialKey: CREDENTIAL_KEY,
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'sk-test-123',
      },
    };
    const turn2 = await collect(
      run({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: CREDENTIAL_KEY,
              name: 'adk_request_credential',
              response: credentialResponse as unknown as Record<
                string,
                unknown
              >,
            },
          },
        ],
      }),
    );

    expect(runs).toBe(1);
    expect(finalOutput(turn2)).toBe('weather(key=sk-test-123)');
  });
});
