/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/auth_api_key/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Auth API Key: a FunctionNode with API-key authentication. The `fetch_weather`
 * node declares an `authConfig`, so the framework pauses the workflow and
 * requests a credential before running it; once supplied, the node runs with the
 * credential available in session state. Faithful port of Python
 * `contributing/samples/workflows/auth_api_key`.
 *
 * The node is `rerunOnResume: true` so that, on resume, it re-runs its body
 * (storing the provided credential and fetching), rather than short-circuiting.
 *
 * TypeScript note: Python reads the credential via `ctx.get_auth_response(cfg)`.
 * There is no such helper here; the framework stores the credential at
 * `temp:<credentialKey>` in state (see AuthHandler), which the node reads.
 *
 * Run:  npm run sample -- samples/workflows/auth_api_key/agent.ts
 * Turn 1: any message -> the workflow requests an API key.
 * Turn 2: type any API key value; the node runs and echoes it back (masked).
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  createEvent,
  node,
  NodeContext,
  Workflow,
} from '@google/adk';

const CREDENTIAL_KEY = 'weather_api_key';

// Uses API key auth: the simplest credential type. The user is prompted to
// provide an API key via the auth UI (or by typing it in `adk run`).
const authConfig: AuthConfig = {
  authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'} as AuthScheme,
  rawAuthCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: 'placeholder',
  },
  credentialKey: CREDENTIAL_KEY,
};

interface Weather {
  city: string;
  temperature: string;
  condition: string;
  apiKeyUsed: string;
}

// Fetches weather data using the authenticated API key.
const fetchWeather = node(
  (ctx: NodeContext): Weather => {
    // After auth completes, the credential is available in state.
    const cred = ctx.state.get<AuthCredential>('temp:' + CREDENTIAL_KEY);
    const apiKey = cred?.apiKey ?? 'unknown';

    // In a real agent you would use the api_key to call an external API. For
    // this sample we just echo it back (masked).
    const masked = apiKey.length > 4 ? apiKey.slice(0, 4) + '****' : '****';
    return {
      city: 'San Francisco',
      temperature: '18C',
      condition: 'Sunny',
      apiKeyUsed: masked,
    };
  },
  {name: 'fetch_weather', authConfig, rerunOnResume: true},
);

// Displays the weather result.
const summarize = node(
  (_ctx: NodeContext, weather: Weather) =>
    createEvent({
      content: {
        role: 'model',
        parts: [
          {
            text:
              `Weather for ${weather.city}: ${weather.temperature}, ` +
              `${weather.condition}. (Authenticated with key: ${weather.apiKeyUsed})`,
          },
        ],
      },
    }),
  {name: 'summarize'},
);

export const rootAgent = new Workflow({
  name: 'auth_api_key',
  edges: [['START', fetchWeather, summarize]],
});
