/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthConfig, AuthCredentialTypes, AuthHandler, State} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('AuthHandler', () => {
  describe('getAuthResponse', () => {
    it('returns credential from state when temp:key is present', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
      };
      const handler = new AuthHandler(authConfig);
      const state = new State({
        'temp:testKey': {authType: 'apiKey', apiKey: 'testToken'},
      });

      const response = handler.getAuthResponse(state);

      expect(response).toEqual({
        authType: 'apiKey',
        apiKey: 'testToken',
      });
    });

    it('returns undefined when temp:key is not present', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
      };
      const handler = new AuthHandler(authConfig);
      const state = new State();

      const response = handler.getAuthResponse(state);

      expect(response).toBeUndefined();
    });
  });

  describe('generateAuthRequest', () => {
    it('returns original config if scheme type is not oauth2 or openIdConnect', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
      };
      const handler = new AuthHandler(authConfig);

      const request = handler.generateAuthRequest();

      expect(request).toBe(authConfig);
    });

    it('returns original config if exchangedAuthCredential.oauth2.authUri is present', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {authUri: 'https://auth.com'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const request = handler.generateAuthRequest();

      expect(request).toBe(authConfig);
    });

    it('throws if rawAuthCredential is missing for oauth2', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthRequest()).toThrow(
        'Auth Scheme oauth2 requires authCredential.',
      );
    });

    it('throws if rawAuthCredential.oauth2 is missing', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'testToken',
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthRequest()).toThrow(
        'Auth Scheme oauth2 requires oauth2 in authCredential.',
      );
    });

    it('returns updated config if rawAuthCredential.oauth2.authUri is present', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {authUri: 'https://auth.com'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const request = handler.generateAuthRequest();

      expect(request.exchangedAuthCredential).toBe(
        authConfig.rawAuthCredential,
      );
    });

    it('throws if clientId or clientSecret are missing', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthRequest()).toThrow(
        'Auth Scheme oauth2 requires both clientId and clientSecret in authCredential.oauth2.',
      );
    });

    it('returns config with exchangedAuthCredential set to generated auth URI', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id', clientSecret: 'secret'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const request = handler.generateAuthRequest();

      expect(request.exchangedAuthCredential).toEqual(
        authConfig.rawAuthCredential, // As per current implementation of generateAuthUri returning rawAuthCredential
      );
    });
  });

  describe('generateAuthUri', () => {
    it('returns rawAuthCredential (current implementation)', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri).toBe(authConfig.rawAuthCredential);
    });
  });
});
