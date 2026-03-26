import {describe, expect, it} from 'vitest';
import {AuthCredentialTypes} from '../../src/auth/auth_credential.js';
import {AuthHandler} from '../../src/auth/auth_handler.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';

describe('AuthHandler generateAuthUri', () => {
  it('generates auth URI for OIDC', () => {
    const authConfig: AuthConfig = {
      credentialKey: 'testKey',
      authScheme: {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
        authorizationEndpoint: 'https://example.com/auth',
        tokenEndpoint: 'https://example.com/token',
        scopes: ['openid', 'profile'],
      },
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'my-client-id',
          redirectUri: 'https://client.example.com/callback',
        },
      },
    };

    const handler = new AuthHandler(authConfig);
    const result = handler.generateAuthUri();

    expect(result).toBeDefined();
    expect(result?.oauth2?.authUri).toContain('https://example.com/auth');
    expect(result?.oauth2?.authUri).toContain('client_id=my-client-id');
    expect(result?.oauth2?.authUri).toContain(
      'redirect_uri=https%3A%2F%2Fclient.example.com%2Fcallback',
    );
    expect(result?.oauth2?.authUri).toContain('scope=openid+profile');
    expect(result?.oauth2?.state).toBeDefined();
  });

  it('generates auth URI for OAuth2 Authorization Code flow', () => {
    const authConfig: AuthConfig = {
      credentialKey: 'testKey',
      authScheme: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/oauth/authorize',
            tokenUrl: 'https://example.com/oauth/token',
            scopes: {
              'read': 'Read access',
              'write': 'Write access',
            },
          },
        },
      },
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'my-client-id',
          redirectUri: 'https://client.example.com/callback',
        },
      },
    };

    const handler = new AuthHandler(authConfig);
    const result = handler.generateAuthUri();

    expect(result).toBeDefined();
    expect(result?.oauth2?.authUri).toContain(
      'https://example.com/oauth/authorize',
    );
    expect(result?.oauth2?.authUri).toContain('client_id=my-client-id');
    expect(result?.oauth2?.authUri).toContain('scope=read+write'); // Order might vary, but ripgrep/expect can handle it or we can check parts
    expect(result?.oauth2?.state).toBeDefined();
  });
});
