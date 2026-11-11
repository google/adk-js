/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../src/auth/auth_credential.js';
import {AuthScheme} from '../../src/auth/auth_schemes.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {hasAuthRequestFunctionCall} from '../../src/workflow/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveWorkflow} from './test_helpers.js';

const CREDENTIAL_KEY = 'my_api';

function apiKeyAuthConfig(): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'} as AuthScheme,
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
    credentialKey: CREDENTIAL_KEY,
  };
}

async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of gen) {
    out.push(e);
  }
  return out;
}

describe('Phase 5b-cont — FunctionNode auth gate', () => {
  it('requests credentials, then runs after they are supplied on resume', async () => {
    let runs = 0;
    let sawApiKey: string | undefined;

    // An auth-gated node must RE-RUN on resume so it can store the supplied
    // credential and then run its body (this is why Python's auth samples set
    // rerun_on_resume=True). Without it, the default two-node resume semantics
    // would complete the node with the raw credential response as its output.
    const secured = new FunctionNode(
      'secured',
      (ctx: NodeContext) => {
        runs++;
        const cred = ctx.state.get<AuthCredential>('temp:' + CREDENTIAL_KEY);
        sawApiKey = cred?.apiKey;
        return `data(${cred?.apiKey})`;
      },
      {authConfig: apiKeyAuthConfig(), rerunOnResume: true},
    );

    const wf = new Workflow({name: 'auth_wf', edges: [['START', secured]]});
    const agent = wf;
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    // Turn 1: no credential -> auth request interrupt, handler NOT run.
    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      }),
    );
    expect(runs).toBe(0);
    expect(turn1.some(hasAuthRequestFunctionCall)).toBe(true);

    // Turn 2: supply the credential (as a filled AuthConfig) and resume.
    const credentialResponse: AuthConfig = {
      authScheme: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      } as AuthScheme,
      credentialKey: CREDENTIAL_KEY,
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-123',
      },
    };
    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
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
        },
      }),
    );

    // The node ran once, saw the supplied API key, and produced output.
    expect(runs).toBe(1);
    expect(sawApiKey).toBe('secret-123');
    expect(turn2.some((e) => e.output === 'data(secret-123)')).toBe(true);
  });

  it('runs immediately when the credential already exists in state', async () => {
    let runs = 0;
    const secured = new FunctionNode(
      'secured',
      () => {
        runs++;
        return 'ok';
      },
      {authConfig: apiKeyAuthConfig()},
    );
    const wf = new Workflow({name: 'auth_wf2', edges: [['START', secured]]});

    // Pre-seed the credential directly in the session state.
    const {events, output} = await driveWorkflow(wf, 'go', {
      ic: createIc({
        ['temp:' + CREDENTIAL_KEY]: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'pre-existing',
        },
      }),
    });

    expect(runs).toBe(1);
    expect(output).toBe('ok');
    expect(events.some(hasAuthRequestFunctionCall)).toBe(false);
  });
});
