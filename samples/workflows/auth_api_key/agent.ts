/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auth (API key): a node requires a credential; it pauses to request one, then
 * runs once supplied. Mirrors Python `workflows/auth_api_key`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/auth_api_key/agent.ts
 * Turn 1: any prompt -> asks for an API key. Turn 2: type any API key value.
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const CREDENTIAL_KEY = 'weather_api';

const authConfig: AuthConfig = {
  authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'} as AuthScheme,
  rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
  credentialKey: CREDENTIAL_KEY,
};

const fetchWeather = node(
  (ctx: NodeContext) => {
    const cred = ctx.state.get<AuthCredential>('temp:' + CREDENTIAL_KEY);
    return `Fetched weather using API key "${cred?.apiKey}": sunny, 25C.`;
  },
  {name: 'fetch_weather', authConfig},
);

const summarize = node(
  (_c: NodeContext, weather: string) => `Report: ${weather}`,
  {name: 'summarize'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'auth_api_key',
    edges: [['START', fetchWeather, summarize]],
  }),
);
