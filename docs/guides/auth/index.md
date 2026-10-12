# Auth

The auth units describe a credential, ask the user for one when a tool needs it, and turn what the user or the configuration supplies into the credential a request carries. This guide covers the credential and config shapes, `AuthHandler`, the scheme helpers, and the credential exchangers that OpenAPI tools use.

## Introduction

A tool that calls a protected API needs two things: a description of how the API authenticates, and a credential that satisfies it. adk-js models the first as an `AuthScheme`, which is an OpenAPI security scheme object or an `OpenIdConnectWithConfig`. It models the second as an `AuthCredential`. An `AuthConfig` pairs the two under a `credentialKey`, and it is the object that travels to the client when the agent has to ask the user for a credential.

Some credentials work as configured, such as an API key. Others have to be exchanged first. An OAuth2 client ID and secret become an authorization URI the user visits, the user's sign-in becomes an access token, and the access token becomes an HTTP bearer credential. A service account key becomes an access token in the same way. The units below each own one step of that chain:

| Unit                                | Step                                                                                         |
| :---------------------------------- | :------------------------------------------------------------------------------------------- |
| `AuthCredential`, `AuthConfig`      | The shapes every other unit reads and writes.                                                |
| `AuthSchemeType`, `OAuthGrantType`  | Runtime values for the OpenAPI scheme types and the OAuth2 grant types.                      |
| `AuthHandler`                       | Builds the auth request for the client and stores the client's response.                     |
| `AuthPreprocessor`                  | Hands a credential response from the client to `AuthHandler` and resumes the tool.           |
| `AutoAuthCredentialExchanger`       | Picks the exchanger for a credential type. OpenAPI tools use it by default.                  |
| `OAuth2BearerExchanger`             | Turns an OAuth2 or OpenID Connect access token into an HTTP bearer credential.               |
| `ServiceAccountCredentialExchanger` | Turns a Google service account key, or application default credentials, into a bearer token. |

## Get started

The example below builds the auth request for an OAuth2 authorization-code API, then shows what the default exchanger does before and after the user signs in. It runs offline: no step here calls the network.

```ts
import {
  AuthConfig,
  AuthCredentialTypes,
  AuthHandler,
  AutoAuthCredentialExchanger,
} from '@google/adk';

const authConfig: AuthConfig = {
  credentialKey: 'items_api',
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        scopes: {'items:read': 'Read items'},
      },
    },
  },
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: 'your-client-id', clientSecret: 'your-client-secret'},
  },
};

// The auth request the client shows the user.
const request = new AuthHandler(authConfig).generateAuthRequest();
const authUri = request.exchangedAuthCredential?.oauth2?.authUri;

const exchanger = new AutoAuthCredentialExchanger();

// Before sign-in there is no token, so the exchanger returns the credential unexchanged.
const before = await exchanger.exchange({
  authScheme: authConfig.authScheme,
  authCredential: authConfig.rawAuthCredential,
});
// before: {credential: authConfig.rawAuthCredential, wasExchanged: false}

// After sign-in the access token becomes an HTTP bearer credential.
const after = await exchanger.exchange({
  authScheme: authConfig.authScheme,
  authCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {accessToken: 'token-from-sign-in'},
  },
});
// after.credential: {authType: 'http', http: {scheme: 'bearer', credentials: {token: 'token-from-sign-in'}}}
```

## How it works

An OpenAPI tool resolves its credential through `ToolAuthHandler`, which calls `AutoAuthCredentialExchanger` unless you give it another exchanger. When the exchanger returns a usable credential, the tool sends the request with that credential. When the exchanger throws, or returns an unexchanged `OAUTH2` or `OPEN_ID_CONNECT` credential that holds no token, `ToolAuthHandler` returns a `pending` state and asks the client for a credential. The request it sends is the `AuthConfig` that `AuthHandler.generateAuthRequest` builds.

### Building the auth request

`generateAuthRequest` returns a new `AuthConfig` every time. For a scheme that is not `oauth2` or `openIdConnect`, and for a config whose `exchangedAuthCredential` already has an `authUri`, it returns a deep copy of the config. For a raw credential that already has an `authUri`, it returns a config whose `exchangedAuthCredential` is a deep copy of the raw credential. Otherwise it requires `clientId` and `clientSecret` on the raw credential, and fills `exchangedAuthCredential` with the result of `generateAuthUri`.

The copy matters because the client fills in the request. When the user finishes signing in, the client sets `exchangedAuthCredential.oauth2.authResponseUri` on the request it received. That write does not reach the tool's own config, so a second request for the same tool starts from the credential you configured.

`generateAuthUri` reads the authorization endpoint from the scheme. For an `OpenIdConnectWithConfig` it uses `authorizationEndpoint` and `scopes`. For an `oauth2` scheme it uses the first flow among `implicit`, `authorizationCode`, `clientCredentials` and `password`, with that flow's `authorizationUrl`, or its `tokenUrl` when there is no `authorizationUrl`, and the keys of its `scopes`. The URI always carries `client_id`, `response_type=code`, a random `state`, `access_type=offline` and `prompt=consent`. It carries `redirect_uri` only when the credential sets `redirectUri`, and `scope` only when the scheme lists at least one scope. An empty `redirect_uri` would override the redirect you registered with the provider, which some providers reject, so leaving it out lets the provider use its registered value.

### Storing the response

`AuthPreprocessor` runs before each model call of an `LlmAgent`. When the latest event holds a response to an `adk_request_credential` function call that the agent raised, it binds the response to the original request, calls `AuthHandler.parseAndStoreAuthResponse`, and runs the tool call that was waiting for the credential again. `parseAndStoreAuthResponse` stores the credential in session state under `temp:` plus the `credentialKey`. For `oauth2` and `openIdConnect` it first exchanges the authorization response for tokens. `getAuthResponse` reads the stored credential back.

### Exchanging credentials

`AutoAuthCredentialExchanger` looks up an exchanger by the credential's `authType`. The default map is:

| `authType`        | Default behavior                                                                |
| :---------------- | :------------------------------------------------------------------------------ |
| `OAUTH2`          | `OAuth2CredentialExchanger` followed by `generateAuthToken`                     |
| `OPEN_ID_CONNECT` | `OAuth2CredentialExchanger` followed by `generateAuthToken`                     |
| `SERVICE_ACCOUNT` | `ServiceAccountCredentialExchanger`                                             |

A type with no entry, such as `API_KEY` or `HTTP`, comes back unchanged as `{credential, wasExchanged: false}`.

For `OAUTH2` and `OPEN_ID_CONNECT`, the default exchanger passes through a credential that already carries `http`, returns `{credential, wasExchanged: false}` when an authorization-code credential has neither a token nor an authorization response yet, and otherwise runs `OAuth2CredentialExchanger` and converts any resulting `oauth2.accessToken` into an HTTP bearer credential with `generateAuthToken`. A client-credentials tool therefore fetches a token from the scheme's `tokenUrl` and converts it into a bearer credential without asking the user to sign in. When an exchange returns an unexchanged `OAUTH2` or `OPEN_ID_CONNECT` credential that holds no `http`, no `accessToken` and no `refreshToken`, `ToolAuthHandler` treats the credential as incomplete and asks the user to sign in. That check runs on the exchanger's result in `ToolAuthHandler`, so it also applies to a custom exchanger you register for those types.

`OAuth2BearerExchanger` converts a token that is already on the credential without calling a token endpoint. It requires an `oauth2` or `openIdConnect` scheme, and a credential that carries `oauth2` or `http`. `generateAuthToken` is the conversion on its own: it returns a new HTTP bearer credential when the credential has an access token, and the credential itself when it has none.

`ServiceAccountCredentialExchanger` needs `serviceAccount` on the credential, and throws `AuthCredentialMissingError` without it. With `useDefaultCredential: true` it uses application default credentials, with `scopes` defaulting to the `cloud-platform` scope. Otherwise it signs a JWT with the key in `serviceAccountCredential`. When the key's `tokenUri` is Google's token endpoint, `https://oauth2.googleapis.com/token`, the exchange goes through google-auth-library. When the key names another `tokenUri`, the exchanger posts the signed JWT-bearer grant to that endpoint itself. That request is aborted when the endpoint has not answered within 30 seconds. The assertion's audience is Google's token endpoint in both cases, as Google service account keys expect. Every failure, including a non-2xx response or a timeout from the token endpoint, becomes an `AuthCredentialMissingError`; when a non-2xx response has a JSON body with `error` or `error_description`, those details are included in the error message.

## Configuration options

`AuthConfig` is the object you configure most often:

| Option                    | Type             | Default | Description                                                   |
| :------------------------ | :--------------- | :------ | :------------------------------------------------------------ |
| `authScheme`              | `AuthScheme`     | none    | How the API authenticates.                                    |
| `credentialKey`           | `string`         | none    | The key the credential is stored under.                       |
| `rawAuthCredential`       | `AuthCredential` | unset   | The credential the tool is configured with.                   |
| `exchangedAuthCredential` | `AuthCredential` | unset   | The credential the client and ADK fill in during the request. |

`credentialKey` is required because the stored credential is found by it. `parseAndStoreAuthResponse` throws when it is empty, rather than storing a credential under a key that every config would share.

`rawAuthCredential` is required for `oauth2` and `openIdConnect`, because the authorization URI is built from its `oauth2` block. For other schemes you can leave it out.

An `AuthCredential` carries `authType`, one of the `AuthCredentialTypes` values, and the block that matches it: `apiKey`, `http`, `oauth2` or `serviceAccount`. In the `oauth2` block, these fields affect the auth request:

| Field                 | Type     | Default | Description                                                            |
| :-------------------- | :------- | :------ | :--------------------------------------------------------------------- |
| `clientId`            | `string` | unset   | Sent as `client_id`. Required, with `clientSecret`, to build the URI.  |
| `clientSecret`        | `string` | unset   | Required to build the URI. Never sent in it.                           |
| `redirectUri`         | `string` | unset   | Sent as `redirect_uri`. Left out of the URI when unset.                |
| `audience`            | `string` | unset   | Sent as `audience` when set.                                           |
| `nonce`               | `string` | unset   | Sent as `nonce` when set.                                              |
| `codeChallengeMethod` | `string` | unset   | Requests PKCE. Only `'S256'` is accepted.                              |
| `codeVerifier`        | `string` | unset   | The PKCE verifier. Generated when PKCE is requested and this is unset. |

`AuthHandler` takes one constructor argument, `authConfig`, and exposes it as a public, writable `authConfig` property. Each method reads the current value, so assigning a new config changes what the next call does.

`AutoAuthCredentialExchanger` takes an optional `customExchangers` map from `AuthCredentialTypes` to an exchanger instance. Entries override the defaults for their type and add exchangers for types with no default. The `exchangers` property is the live map. It is `readonly`, so you cannot replace the map itself, but you can add, replace and delete its entries after construction.

The OpenAPI helpers also export the `OpenIdConfig` interface, with the client settings an application registers with an OpenID Connect provider: `clientId`, `authUri`, `tokenUri` and `clientSecret`, and an optional `redirectUri`.

`AuthSchemeType` has the members `API_KEY`, `HTTP`, `OAUTH2` and `OPEN_ID_CONNECT`. Their values are the OpenAPI `type` strings, `'apiKey'`, `'http'`, `'oauth2'` and `'openIdConnect'`, so a member compares equal to `authScheme.type`. `getOAuthGrantTypeFromFlow(flows)` returns the `OAuthGrantType` of the first flow present, checked in the order `clientCredentials`, `authorizationCode`, `implicit` and `password`, or `undefined` when there is none.

## Advanced applications

You can change how one credential type is exchanged without rebuilding the exchanger. For example, a tool that receives tokens from your own identity service can register an exchanger for `OAUTH2` after construction:

```ts
import {AuthCredentialTypes, AutoAuthCredentialExchanger} from '@google/adk';

const exchanger = new AutoAuthCredentialExchanger();
exchanger.exchangers.set(AuthCredentialTypes.OAUTH2, myTokenServiceExchanger);
```

`ToolAuthHandler` still checks the registered exchanger's result, so when it returns an unexchanged credential without a token, the tool asks the user to sign in.

If your application already supplies `oauth2.accessToken` on the credential and you want to convert that token into an HTTP bearer credential without calling a token endpoint, register `OAuth2BearerExchanger`:

```ts
import {
  AuthCredentialTypes,
  AutoAuthCredentialExchanger,
  OAuth2BearerExchanger,
} from '@google/adk';

const exchanger = new AutoAuthCredentialExchanger({
  [AuthCredentialTypes.OAUTH2]: new OAuth2BearerExchanger(),
});
```

To implement an exchanger for the older synchronous interface, extend `BaseAuthCredentialExchanger` and override `exchangeCredential(authScheme, authCredential)`. The base implementation throws, so a subclass that forgets the override fails on the first call. Throw `AuthCredentialMissingError` when the credential the exchange needs is absent, which is the error the built-in exchangers throw for that case.

## Limitations

- `OAuth2BearerExchanger` and `OAuth2CredentialExchanger` do not refresh tokens. A credential that holds only `refreshToken` is not rejected by `ToolAuthHandler`, but it is also not converted, so the request carries no bearer token.
- The custom `tokenUri` path of `ServiceAccountCredentialExchanger` uses `node:crypto` and the global `fetch`, so it needs Node.js. `useIdToken` and `audience` on `ServiceAccount` are not read by this exchanger.

## Related samples

- [samples/auth/](../../../samples/auth/README.md) - Builds the auth request for an OAuth2 config with no redirect URI, and converts an access token into a bearer credential, offline.

## Related guides

- [OpenAPI tool](../tools/openapi_tool/index.md) - Turning an OpenAPI specification into tools, and configuring the credential their requests carry.
