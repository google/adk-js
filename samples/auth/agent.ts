/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auth: auth requests, scheme types and bearer exchange
 * ../../docs/guides/auth/index.md
 *
 * A deterministic `BaseAgent` that walks an OAuth2 authorization-code config
 * through the auth helpers without a network call. `AuthHandler` builds the
 * auth request and its authorization URI, `AuthSchemeType` and
 * `getOAuthGrantTypeFromFlow` classify the scheme, and
 * `AutoAuthCredentialExchanger` and `generateAuthToken` turn an access token
 * into an HTTP bearer credential. `SessionStateCredentialService` keeps a
 * credential in session state under its `credentialKey`.
 *
 * Easy to get wrong: the credential has no `redirectUri`, so the URI carries
 * no `redirect_uri` at all and the provider uses the redirect registered for
 * the client. And for an OAuth2 credential that holds no token yet, the auto
 * exchanger returns `{credential, wasExchanged: false}` so callers can still
 * read `.credential`, while `ToolAuthHandler` treats that unexchanged result
 * as the signal to ask the user to sign in.
 *
 * The access token is a placeholder string, and the agent prints its value
 * only in redacted form.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/auth/agent.ts
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthHandler,
  AuthScheme,
  AuthSchemeType,
  AutoAuthCredentialExchanger,
  BaseAgent,
  Context,
  createEvent,
  CredentialManager,
  Event,
  generateAuthToken,
  getOAuthGrantTypeFromFlow,
  InMemoryCredentialService,
  InvocationContext,
  SessionStateCredentialService,
} from '@google/adk';

const PLACEHOLDER_ACCESS_TOKEN = 'placeholder-access-token';

const flows = {
  authorizationCode: {
    authorizationUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    scopes: {'items:read': 'Read items'},
  },
};

const authScheme: AuthScheme = {type: 'oauth2', flows};

const rawAuthCredential: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {
    clientId: 'example-client-id',
    clientSecret: 'example-client-secret',
  },
};

const authConfig: AuthConfig = {
  credentialKey: 'example_oauth2',
  authScheme,
  rawAuthCredential,
};

/** Shows a token's shape without its value. */
function redact(token: string | undefined): string {
  return token ? `<redacted, ${token.length} chars>` : '<none>';
}

/** Describes the auth request `AuthHandler` builds for `authConfig`. */
function describeAuthRequest(): string[] {
  const request = new AuthHandler(authConfig).generateAuthRequest();
  const authUri = request.exchangedAuthCredential?.oauth2?.authUri ?? '';
  const url = new URL(authUri);
  return [
    `Authorization endpoint: ${url.origin}${url.pathname}`,
    `URI parameters: ${[...url.searchParams.keys()].join(', ')}`,
    `redirect_uri present: ${url.searchParams.has('redirect_uri')}`,
    `Request credential is a copy: ${
      request.exchangedAuthCredential !== authConfig.rawAuthCredential
    }`,
  ];
}

/** Describes what the default exchangers do with and without a token. */
async function describeExchange(): Promise<string[]> {
  const exchanger = new AutoAuthCredentialExchanger();
  const signedIn: AuthCredential = {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {accessToken: PLACEHOLDER_ACCESS_TOKEN},
  };

  const exchanged = await exchanger.exchange({
    authScheme,
    authCredential: signedIn,
  });
  const notSignedIn = await exchanger.exchange({
    authScheme,
    authCredential: rawAuthCredential,
  });
  const converted = generateAuthToken(signedIn);

  const withToken = `${exchanged.credential.authType} ${
    exchanged.credential.http?.scheme
  } ${redact(exchanged.credential.http?.credentials.token)}`;

  return [
    `Registered exchangers: ${[...exchanger.exchangers.keys()].join(', ')}`,
    `With an access token: ${withToken} (wasExchanged: ${exchanged.wasExchanged})`,
    `Without a token: ${notSignedIn.credential.authType} (wasExchanged: ${notSignedIn.wasExchanged})`,
    `generateAuthToken: ${converted.authType} ${redact(
      converted.http?.credentials.token,
    )}`,
  ];
}

/** Describes how `CredentialManager` loads and persists credentials via `InMemoryCredentialService`. */
async function describeCredentialManager(
  ctx: InvocationContext,
): Promise<string[]> {
  const credentialService = new InMemoryCredentialService();
  const toolContext = new Context({
    invocationContext: ctx.clone({credentialService}),
    functionCallId: 'sample-auth-call',
  });
  const manager = new CredentialManager(authConfig);
  const beforeResponse = await manager.getAuthCredential(toolContext);

  toolContext.state.set(`temp:${authConfig.credentialKey}`, {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {accessToken: PLACEHOLDER_ACCESS_TOKEN},
  });
  const afterResponse = await manager.getAuthCredential(toolContext);
  const stored = await credentialService.loadCredential(
    authConfig,
    toolContext,
  );

  return [
    `CredentialManager before response: ${beforeResponse ?? 'undefined'}`,
    `CredentialManager after response: ${afterResponse?.authType} ${redact(
      afterResponse?.oauth2?.accessToken,
    )}`,
    `Saved in InMemoryCredentialService: ${Boolean(
      stored?.oauth2?.accessToken,
    )}`,
  ];
}

/** Describes how `SessionStateCredentialService` keeps a credential in session state. */
async function describeSessionStateCredentialService(
  ctx: InvocationContext,
): Promise<string[]> {
  const credentialService = new SessionStateCredentialService();
  const toolContext = new Context({
    invocationContext: ctx,
    functionCallId: 'sample-session-state-call',
  });
  const sessionAuthConfig: AuthConfig = {
    ...authConfig,
    credentialKey: 'example_session_state',
    exchangedAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: PLACEHOLDER_ACCESS_TOKEN},
    },
  };

  await credentialService.saveCredential(sessionAuthConfig, toolContext);
  const loaded = await credentialService.loadCredential(
    sessionAuthConfig,
    toolContext,
  );

  return [
    `SessionStateCredentialService state key: ${sessionAuthConfig.credentialKey}`,
    `SessionStateCredentialService loaded: ${loaded?.authType} ${redact(
      loaded?.oauth2?.accessToken,
    )}`,
  ];
}

class AuthShowcaseAgent extends BaseAgent {
  constructor() {
    super({
      name: 'auth_showcase_agent',
      description:
        'Builds an OAuth2 auth request and converts an access token into a bearer credential, offline.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const lines = [
      `Scheme types: ${Object.values(AuthSchemeType).join(', ')}`,
      `Grant type: ${getOAuthGrantTypeFromFlow(flows)}`,
      ...describeAuthRequest(),
      ...(await describeExchange()),
      ...(await describeCredentialManager(ctx)),
      ...(await describeSessionStateCredentialService(ctx)),
    ];

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {role: 'model', parts: [{text: lines.join('\n')}]},
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new AuthShowcaseAgent();
