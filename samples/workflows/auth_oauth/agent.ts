/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auth (OAuth2): a node requiring OAuth pauses and emits an authorization URL
 * for the user to complete the flow. Mirrors Python `workflows/auth_oauth`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/auth_oauth/agent.ts
 * Turn 1 emits an `adk_request_credential` interrupt with an auth URL. NOTE:
 * completing the real OAuth token exchange requires a live provider, so the
 * resume step is illustrative only.
 */

import {
  AuthConfig,
  AuthCredentialTypes,
  AuthScheme,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const authConfig: AuthConfig = {
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://accounts.example.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.example.com/token',
        scopes: {'https://example.com/auth/calendar.readonly': 'Read calendar'},
      },
    },
  } as AuthScheme,
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'demo-client-id',
      clientSecret: 'demo-client-secret',
      redirectUri: 'http://localhost:8080/callback',
    },
  },
  credentialKey: 'example_calendar_oauth',
};

const fetchCalendar = node(
  (_c: NodeContext) => 'Fetched 3 calendar events using OAuth credentials.',
  {name: 'fetch_calendar', authConfig},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'auth_oauth',
    edges: [['START', fetchCalendar]],
  }),
);
