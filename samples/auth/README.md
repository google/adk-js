# Auth Sample (`AuthHandler`, `AuthSchemeType` and `AutoAuthCredentialExchanger`)

This sample shows how an OAuth2 authorization-code config becomes an auth request, and how an access token becomes the HTTP bearer credential a request carries. It runs offline and calls no model.

## Overview

`AuthShowcaseAgent` is a deterministic `BaseAgent` subclass. On each turn it replies with one message that reports these results:

- `Object.values(AuthSchemeType)` lists the four OpenAPI scheme types, and `getOAuthGrantTypeFromFlow` reads the grant type of the scheme's flows.
- `AuthHandler.generateAuthRequest` builds the auth request. The credential has no `redirectUri`, so the generated URI carries no `redirect_uri` parameter. The request holds a copy of the raw credential, not the raw credential itself.
- `AutoAuthCredentialExchanger` lists its registered exchangers. It turns an OAuth2 credential that holds an access token into an HTTP bearer credential with `wasExchanged: true`, and returns the credential with `wasExchanged: false` when there is no token yet.
- `generateAuthToken` does the same conversion directly.

The access token is a placeholder string, and the reply shows it only in redacted form.

## Sample Inputs

- `Show me the auth flow.`

  _Any message works. The agent ignores the text and replies with the same report._

## Running the Sample

The sample needs nothing beyond the repository: no API key, no network access and no optional package. Build the workspace once, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/auth/agent.ts
```

The file exports `rootAgent`, so `adk web` can also load it.

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Auth](../../docs/guides/auth/index.md) - Credentials, auth configs, `AuthHandler`, and the OpenAPI credential exchangers.
