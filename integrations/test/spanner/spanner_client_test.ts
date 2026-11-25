/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type GoogleAuthClient,
  type GoogleCredentials,
  isGoogleAuthClient,
  logger,
} from '@google/adk';
import {
  getSpannerClient,
  type GetSpannerClientOptions,
  isSpannerClient,
  SPANNER_USER_AGENT,
  SpannerClient,
  type SpannerDatabaseContext,
  type SpannerDatabaseDialect,
  type SpannerDatabaseQueryOptions,
  type SpannerDatabaseTarget,
  type SpannerQueryOptions,
  type SpannerSnapshotContext,
} from '@google/adk-integrations';
import {GoogleAuth, JWT, OAuth2Client} from 'google-auth-library';
import {readFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';

interface FakeSdkModuleOptions {
  dialect?: SpannerDatabaseDialect;
  dialectViaMetadataOnly?: boolean;
  getDatabaseDialectError?: Error;
  getMetadataError?: Error;
  rows?: unknown[];
  streamRows?: unknown[];
  useStream?: boolean;
  queryError?: Error;
  snapshotEndError?: Error;
  databaseCloseError?: Error;
  clientCloseError?: Error;
}

function createFakeSdkFixture(opts: FakeSdkModuleOptions = {}) {
  const capturedClientOptions: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let destroyedStream = false;

  const snapshot = {
    runStream: opts.useStream
      ? vi.fn(() => {
          const stream = Readable.from(opts.streamRows ?? opts.rows ?? []);
          const origDestroy = stream.destroy.bind(stream);
          vi.spyOn(stream, 'destroy').mockImplementation((error?: Error) => {
            destroyedStream = true;
            calls.push('stream.destroy');
            return origDestroy(error);
          });
          return stream;
        })
      : undefined,
    run: vi.fn(async () => {
      if (opts.queryError) {
        throw opts.queryError;
      }
      return [opts.rows ?? []];
    }),
    end: vi.fn(async () => {
      calls.push('snapshot.end');
      if (opts.snapshotEndError) {
        throw opts.snapshotEndError;
      }
    }),
  };

  const database = {
    getDatabaseDialect: opts.dialectViaMetadataOnly
      ? undefined
      : vi.fn(async () => {
          if (opts.getDatabaseDialectError) {
            throw opts.getDatabaseDialectError;
          }
          return opts.dialect ?? 'GOOGLE_STANDARD_SQL';
        }),
    getMetadata: vi.fn(async () => {
      if (opts.getMetadataError) {
        throw opts.getMetadataError;
      }
      return [{databaseDialect: opts.dialect ?? 'GOOGLE_STANDARD_SQL'}];
    }),
    getSnapshot: vi.fn(async () => {
      calls.push('database.getSnapshot');
      return [snapshot];
    }),
    close: vi.fn(async () => {
      calls.push('database.close');
      if (opts.databaseCloseError) {
        throw opts.databaseCloseError;
      }
    }),
  };

  const instance = {
    database: vi.fn(() => database),
  };

  const sdkClient = {
    instance: vi.fn(() => instance),
    close: vi.fn(async () => {
      calls.push('client.close');
      if (opts.clientCloseError) {
        throw opts.clientCloseError;
      }
    }),
  };

  const fakeModule = {
    Spanner: class {
      constructor(options: Record<string, unknown>) {
        capturedClientOptions.push(options);
        return sdkClient;
      }
    },
  };

  return {
    fakeModule,
    capturedClientOptions,
    calls,
    snapshot,
    database,
    instance,
    sdkClient,
    wasStreamDestroyed: () => destroyedStream,
  };
}

function createClientWithSdk(
  options: Record<string, unknown>,
  sdkLoader: () => Promise<unknown>,
): SpannerClient {
  return getSpannerClient({
    ...options,
    sdkLoader,
  } as Parameters<typeof getSpannerClient>[0]);
}

describe('getSpannerClient and SpannerClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@google-cloud/spanner');
    vi.restoreAllMocks();
  });

  it('identifies SpannerClient instances via isSpannerClient', () => {
    const clientOptions: GetSpannerClientOptions = {
      projectId: 'test-gcp-project',
    };
    const directClient = new SpannerClient(clientOptions);
    const factoryClient = getSpannerClient(clientOptions);
    expect(isSpannerClient(directClient)).toBe(true);
    expect(isSpannerClient(factoryClient)).toBe(true);
    expect(isSpannerClient({})).toBe(false);
    expect(isSpannerClient(null)).toBe(false);
    expect(isSpannerClient(undefined)).toBe(false);
  });

  it('formats SPANNER_USER_AGENT with the package version from integrations/package.json', () => {
    const pkgJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {version: string};

    expect(SPANNER_USER_AGENT).toBe(
      `adk-spanner-tool google-adk/${pkgJson.version}`,
    );
    expect(SPANNER_USER_AGENT).toMatch(
      /^adk-spanner-tool google-adk\/[0-9A-Za-z._\-+/]+$/,
    );
  });

  it('sets an explicit projectId without invoking default credentials or env fallback', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'ignored-env-project');
    const fixture = createFakeSdkFixture({rows: [[1]]});
    const client = createClientWithSdk(
      {
        projectId: 'test-gcp-project',
        credentials: {token: 'tok-123', valid: true},
      },
      async () => fixture.fakeModule,
    );

    expect(client.projectId).toBe('test-gcp-project');

    await client.runReadOnlyQuery({
      instanceId: 'test-instance',
      databaseId: 'test-database',
      sql: 'SELECT 1',
    });

    expect(fixture.capturedClientOptions[0]?.['projectId']).toBe(
      'test-gcp-project',
    );
    expect(fixture.capturedClientOptions[0]?.['userAgent']).toBe(
      SPANNER_USER_AGENT,
    );
  });

  it('leaves projectId undefined when omitted and GOOGLE_CLOUD_PROJECT is unset', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    const fixture = createFakeSdkFixture({rows: [[1]]});
    const client = createClientWithSdk(
      {credentials: {token: 'tok-123', valid: true}},
      async () => fixture.fakeModule,
    );

    expect(client.projectId).toBeUndefined();

    await client.runReadOnlyQuery({
      instanceId: 'test-instance',
      databaseId: 'test-database',
      sql: 'SELECT 1',
    });

    expect(fixture.capturedClientOptions[0]).not.toHaveProperty('projectId');
  });

  it('falls back to GOOGLE_CLOUD_PROJECT when projectId is omitted or empty', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-gcp-project');

    const omittedClient = getSpannerClient();
    const emptyClient = getSpannerClient({projectId: ''});

    expect(omittedClient.projectId).toBe('env-gcp-project');
    expect(emptyClient.projectId).toBe('env-gcp-project');
  });

  it('appends custom userAgent strings and arrays to SPANNER_USER_AGENT', () => {
    const withString = getSpannerClient({
      projectId: 'test-gcp-project',
      userAgent: 'customAgent',
    });
    expect(withString.userAgent).toBe(`${SPANNER_USER_AGENT} customAgent`);

    const withArray = getSpannerClient({
      projectId: 'test-gcp-project',
      userAgent: ['agentOne', undefined, '', null, 'agentTwo'],
    });
    expect(withArray.userAgent).toBe(`${SPANNER_USER_AGENT} agentOne agentTwo`);
  });

  it('disables built-in Spanner SDK metrics by default and allows explicit opt-in', async () => {
    const defaultFixture = createFakeSdkFixture({rows: [[1]]});
    const defaultClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => defaultFixture.fakeModule,
    );
    expect(defaultClient.disableBuiltInMetrics).toBe(true);
    await defaultClient.runReadOnlyQuery({
      instanceId: 'test-instance',
      databaseId: 'test-database',
      sql: 'SELECT 1',
    });
    expect(
      defaultFixture.capturedClientOptions[0]?.['disableBuiltInMetrics'],
    ).toBe(true);

    const optInFixture = createFakeSdkFixture({rows: [[1]]});
    const optInClient = createClientWithSdk(
      {projectId: 'test-gcp-project', disableBuiltInMetrics: false},
      async () => optInFixture.fakeModule,
    );
    expect(optInClient.disableBuiltInMetrics).toBe(false);
    await optInClient.runReadOnlyQuery({
      instanceId: 'test-instance',
      databaseId: 'test-database',
      sql: 'SELECT 1',
    });
    expect(
      optInFixture.capturedClientOptions[0]?.['disableBuiltInMetrics'],
    ).toBe(false);
  });

  it('passes GoogleAuthClient instances (JWT, OAuth2Client, GoogleAuth, and custom clients) as authClient while preserving instanceof', async () => {
    const jwtClient = new JWT({
      email: 'service-account@example.iam.gserviceaccount.com',
      scopes: ['https://www.googleapis.com/auth/spanner.data'],
    });
    const oauth2Client = new OAuth2Client({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    const googleAuth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spanner.data'],
    });
    const expectedHeaders = new Headers({
      Authorization: 'Bearer custom-header-token',
    });
    const customAuthClient: GoogleAuthClient = {
      getRequestHeaders: async () => expectedHeaders,
    };

    const cases: Array<{
      cred: GoogleCredentials;
      checkInstance?: (authClient: unknown) => void;
    }> = [
      {
        cred: jwtClient,
        checkInstance: (ac) => expect(ac).toBeInstanceOf(JWT),
      },
      {
        cred: oauth2Client,
        checkInstance: (ac) => expect(ac).toBeInstanceOf(OAuth2Client),
      },
      {
        cred: googleAuth,
        checkInstance: (ac) => expect(ac).toBeInstanceOf(GoogleAuth),
      },
      {cred: customAuthClient},
    ];

    for (const {cred, checkInstance} of cases) {
      const fixture = createFakeSdkFixture({dialect: 'GOOGLE_STANDARD_SQL'});
      const client = createClientWithSdk(
        {projectId: 'test-gcp-project', credentials: cred},
        async () => fixture.fakeModule,
      );

      await client.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      });

      const authClient = fixture.capturedClientOptions[0]?.['authClient'];
      expect(isGoogleAuthClient(authClient)).toBe(true);
      expect(fixture.capturedClientOptions[0]?.['credentials']).toBeUndefined();
      checkInstance?.(authClient);
      if (cred === customAuthClient && isGoogleAuthClient(authClient)) {
        await expect(authClient.getRequestHeaders()).resolves.toBe(
          expectedHeaders,
        );
      }
    }
  });

  it('normalizes plain-record GoogleAuthClient and getClient() headers to Headers while preserving instanceof and private fields', async () => {
    class CustomRecordAuthClient implements GoogleAuthClient {
      #secret: string;
      label = 'initial';

      constructor(secret: string) {
        this.#secret = secret;
      }

      readSecret(): string {
        return this.#secret;
      }

      getRequestHeaders(url?: string | URL): Record<string, string> {
        return {
          Authorization: `Bearer ${this.#secret}`,
          'X-Target-Url': String(url ?? ''),
        };
      }
    }

    const recordClient = new CustomRecordAuthClient('record-secret-token');
    const fixture = createFakeSdkFixture({dialect: 'GOOGLE_STANDARD_SQL'});
    const spannerClient = createClientWithSdk(
      {projectId: 'test-gcp-project', credentials: recordClient},
      async () => fixture.fakeModule,
    );

    await spannerClient.getDatabaseDialect({
      instanceId: 'test-instance',
      databaseId: 'test-database',
    });

    const wrapped = fixture.capturedClientOptions[0]?.['authClient'];
    expect(wrapped).toBeInstanceOf(CustomRecordAuthClient);
    expect(isGoogleAuthClient(wrapped)).toBe(true);
    if (
      !isGoogleAuthClient(wrapped) ||
      !(wrapped instanceof CustomRecordAuthClient)
    ) {
      throw new Error('Expected wrapped CustomRecordAuthClient');
    }

    expect(wrapped.readSecret()).toBe('record-secret-token');
    wrapped.label = 'updated';
    expect(recordClient.label).toBe('updated');

    const normalizedHeaders = await wrapped.getRequestHeaders(
      'https://spanner.googleapis.com',
    );
    expect(normalizedHeaders).toBeInstanceOf(Headers);
    const gaxCopied: Record<string, string> = {};
    if (normalizedHeaders instanceof Headers) {
      normalizedHeaders.forEach((value, key) => {
        gaxCopied[key] = value;
      });
    }
    expect(gaxCopied).toEqual({
      authorization: 'Bearer record-secret-token',
      'x-target-url': 'https://spanner.googleapis.com',
    });

    class DelegatingAuthFactory implements GoogleAuthClient {
      #inner: CustomRecordAuthClient;

      constructor(inner: CustomRecordAuthClient) {
        this.#inner = inner;
      }

      async getClient(): Promise<CustomRecordAuthClient> {
        return this.#inner;
      }

      async getRequestHeaders(
        url?: string | URL,
      ): Promise<Record<string, string>> {
        return this.#inner.getRequestHeaders(url);
      }
    }

    const authFactory = new DelegatingAuthFactory(
      new CustomRecordAuthClient('nested-record-token'),
    );
    const nestedFixture = createFakeSdkFixture({
      dialect: 'GOOGLE_STANDARD_SQL',
    });
    const nestedSpannerClient = createClientWithSdk(
      {
        projectId: 'test-gcp-project',
        credentials: authFactory,
      },
      async () => nestedFixture.fakeModule,
    );
    await nestedSpannerClient.getDatabaseDialect({
      instanceId: 'test-instance',
      databaseId: 'test-database',
    });

    const wrappedFactory =
      nestedFixture.capturedClientOptions[0]?.['authClient'];
    expect(wrappedFactory).toBeInstanceOf(DelegatingAuthFactory);
    if (!(wrappedFactory instanceof DelegatingAuthFactory)) {
      throw new Error('Expected wrapped DelegatingAuthFactory instance');
    }
    const innerClient: unknown = await wrappedFactory.getClient();
    expect(innerClient).toBeInstanceOf(CustomRecordAuthClient);
    expect(isGoogleAuthClient(innerClient)).toBe(true);
    if (isGoogleAuthClient(innerClient)) {
      const innerHeaders = await innerClient.getRequestHeaders();
      expect(innerHeaders).toBeInstanceOf(Headers);
      if (innerHeaders instanceof Headers) {
        expect(innerHeaders.get('authorization')).toBe(
          'Bearer nested-record-token',
        );
      }
    }

    const backingOAuth = new OAuth2Client();
    backingOAuth.setCredentials({access_token: 'oauth-access-token'});
    const realGoogleAuth = new GoogleAuth({authClient: backingOAuth});
    const googleAuthFixture = createFakeSdkFixture({
      dialect: 'GOOGLE_STANDARD_SQL',
    });
    const googleAuthSpannerClient = createClientWithSdk(
      {projectId: 'test-gcp-project', credentials: realGoogleAuth},
      async () => googleAuthFixture.fakeModule,
    );
    await googleAuthSpannerClient.getDatabaseDialect({
      instanceId: 'test-instance',
      databaseId: 'test-database',
    });
    const wrappedRealGoogleAuth =
      googleAuthFixture.capturedClientOptions[0]?.['authClient'];
    expect(wrappedRealGoogleAuth).toBeInstanceOf(GoogleAuth);
    if (wrappedRealGoogleAuth instanceof GoogleAuth) {
      const resolvedOAuth = await wrappedRealGoogleAuth.getClient();
      expect(resolvedOAuth).toBeInstanceOf(OAuth2Client);
      const oauthHeaders = await resolvedOAuth.getRequestHeaders();
      expect(oauthHeaders).toBeInstanceOf(Headers);
      expect(oauthHeaders.get('authorization')).toBe(
        'Bearer oauth-access-token',
      );
    }

    const frozenRecordClient: GoogleAuthClient = Object.freeze({
      getRequestHeaders: () => ({Authorization: 'Bearer frozen-token'}),
    });
    const frozenFixture = createFakeSdkFixture({
      dialect: 'GOOGLE_STANDARD_SQL',
    });
    const frozenSpannerClient = createClientWithSdk(
      {projectId: 'test-gcp-project', credentials: frozenRecordClient},
      async () => frozenFixture.fakeModule,
    );
    await frozenSpannerClient.getDatabaseDialect({
      instanceId: 'test-instance',
      databaseId: 'test-database',
    });
    const wrappedFrozen =
      frozenFixture.capturedClientOptions[0]?.['authClient'];
    expect(isGoogleAuthClient(wrappedFrozen)).toBe(true);
    if (isGoogleAuthClient(wrappedFrozen)) {
      const frozenHeaders = await wrappedFrozen.getRequestHeaders();
      expect(frozenHeaders).toBeInstanceOf(Headers);
      if (frozenHeaders instanceof Headers) {
        expect(frozenHeaders.get('authorization')).toBe('Bearer frozen-token');
      }
    }
  });

  it('wraps bearer-token credentials in a Headers-returning authClient with getAccessToken', async () => {
    const fixture = createFakeSdkFixture({dialect: 'GOOGLE_STANDARD_SQL'});
    const client = createClientWithSdk(
      {
        projectId: 'test-gcp-project',
        credentials: {token: 'bearer-tok-123', valid: true},
      },
      async () => fixture.fakeModule,
    );

    const target: SpannerDatabaseTarget = {
      instanceId: 'test-instance',
      databaseId: 'test-database',
    };
    await client.withDatabase(target, async (db: SpannerDatabaseContext) => {
      await db.withSnapshot(async (snap: SpannerSnapshotContext) => {
        const queryOpts: SpannerQueryOptions = {sql: 'SELECT 1'};
        await snap.runQuery(queryOpts);
      });
    });

    const rawAuthClient = fixture.capturedClientOptions[0]?.['authClient'];
    expect(isGoogleAuthClient(rawAuthClient)).toBe(true);
    if (!isGoogleAuthClient(rawAuthClient)) {
      throw new Error('Expected authClient to implement GoogleAuthClient');
    }
    const headers = await rawAuthClient.getRequestHeaders();
    expect(headers).toBeInstanceOf(Headers);
    if (headers instanceof Headers) {
      expect(headers.get('authorization')).toBe('Bearer bearer-tok-123');
    }
    await expect(rawAuthClient.getAccessToken?.()).resolves.toEqual({
      token: 'bearer-tok-123',
    });
  });

  it('rejects configured credentials that lack both an access token and getRequestHeaders', async () => {
    const fixture = createFakeSdkFixture();
    const client = createClientWithSdk(
      {
        projectId: 'test-gcp-project',
        credentials: {valid: true},
      },
      async () => fixture.fakeModule,
    );

    await expect(
      client.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      }),
    ).rejects.toThrow(
      /Configured Spanner credentials must provide a non-empty access token or a getRequestHeaders\(\) method/,
    );
  });

  it('throws an actionable install error when @google-cloud/spanner cannot be loaded', async () => {
    vi.doMock('@google-cloud/spanner', () => {
      throw new Error("Cannot find package '@google-cloud/spanner'");
    });

    const client = getSpannerClient({projectId: 'test-gcp-project'});
    await expect(
      client.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      }),
    ).rejects.toThrow(/npm install @google-cloud\/spanner/);
  });

  it('throws when the loaded Spanner module omits the Spanner constructor', async () => {
    const client = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => ({}),
    );

    await expect(
      client.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      }),
    ).rejects.toThrow(/Missing 'Spanner' export from '@google-cloud\/spanner'/);
  });

  it('falls back to getMetadata when getDatabaseDialect is absent or hits SDK callback TypeError', async () => {
    const metadataOnlyFixture = createFakeSdkFixture({
      dialect: 'POSTGRESQL',
      dialectViaMetadataOnly: true,
    });
    const metadataOnlyClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => metadataOnlyFixture.fakeModule,
    );
    await expect(
      metadataOnlyClient.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      }),
    ).resolves.toBe('POSTGRESQL');

    const sdkBugFixture = createFakeSdkFixture({
      dialect: 'GOOGLE_STANDARD_SQL',
      getDatabaseDialectError: new TypeError('cb is not a function'),
    });
    const sdkBugClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => sdkBugFixture.fakeModule,
    );
    await expect(
      sdkBugClient.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      }),
    ).resolves.toBe('GOOGLE_STANDARD_SQL');
  });

  it('ends snapshots, closes databases before clients, and still cleans up when close fails', async () => {
    const happyFixture = createFakeSdkFixture({rows: [[42]]});
    const happyClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => happyFixture.fakeModule,
    );

    const queryOptions: SpannerDatabaseQueryOptions = {
      instanceId: 'test-instance',
      databaseId: 'test-database',
      sql: 'SELECT 42',
    };
    const rows = await happyClient.runReadOnlyQuery(queryOptions);
    expect(rows).toEqual([[42]]);
    expect(happyFixture.calls).toEqual([
      'database.getSnapshot',
      'snapshot.end',
      'database.close',
      'client.close',
    ]);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const failingCloseFixture = createFakeSdkFixture({
      queryError: new Error('query exploded'),
      snapshotEndError: new Error('snapshot close failed'),
      databaseCloseError: new Error('db close failed'),
      clientCloseError: new Error('client close failed'),
    });
    const failingClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => failingCloseFixture.fakeModule,
    );

    await expect(
      failingClient.runReadOnlyQuery({
        instanceId: 'test-instance',
        databaseId: 'test-database',
        sql: 'SELECT broken',
      }),
    ).rejects.toThrow('query exploded');

    expect(failingCloseFixture.calls).toEqual([
      'database.getSnapshot',
      'snapshot.end',
      'database.close',
      'client.close',
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to close the Spanner snapshot.',
      expect.any(Error),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to close the Spanner database.',
      expect.any(Error),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to close the Spanner client.',
      expect.any(Error),
    );
  });

  it('unwraps Spanner SDK Int, Float, Struct, and oversized INT64 values while capping streams', async () => {
    const spannerPkg = await import('@google-cloud/spanner');
    class LossyWrappedInt {
      readonly value: string;
      constructor(value: string) {
        this.value = value;
      }
      valueOf(): number {
        return Number(this.value);
      }
    }

    const row1 = Object.assign(
      [
        {name: 'count', value: new spannerPkg.Int('42')},
        {name: 'score', value: new spannerPkg.Float(3.5)},
        {name: 'bigId', value: new spannerPkg.Int('9007199254740993')},
        {name: 'negBigId', value: new LossyWrappedInt('-9007199254740993')},
        {
          name: 'nested',
          value: spannerPkg.Struct.fromJSON({
            label: 'alpha',
            rank: new spannerPkg.Int('1'),
          }),
        },
      ],
      {toJSON: () => ({})},
    );
    const row2 = Object.assign(
      [{name: 'count', value: new spannerPkg.Int('99')}],
      {toJSON: () => ({})},
    );
    const row3 = Object.assign(
      [{name: 'count', value: new spannerPkg.Int('100')}],
      {toJSON: () => ({})},
    );

    const fixture = createFakeSdkFixture({
      useStream: true,
      streamRows: [row1, row2, row3],
    });
    const client = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => fixture.fakeModule,
    );

    const rows = await client.runReadOnlyQuery({
      instanceId: 'test-instance',
      databaseId: 'test-database',
      sql: 'SELECT count, score, bigId, nested FROM Items',
      maxRows: 2,
    });

    expect(rows).toEqual([
      [
        42,
        3.5,
        '9007199254740993',
        '-9007199254740993',
        {label: 'alpha', rank: 1},
      ],
      [99],
    ]);
    expect(fixture.wasStreamDestroyed()).toBe(true);
    expect(fixture.calls).toContain('stream.destroy');
    expect(fixture.calls).toContain('snapshot.end');
    expect(fixture.calls).toContain('database.close');
    expect(fixture.calls).toContain('client.close');
  });

  it('handles cached databaseDialect, non-TypeError dialect failures, and metadata-less database handles', async () => {
    const postgresDialect: SpannerDatabaseDialect = 'POSTGRESQL';
    const cachedDialectClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => ({
        Spanner: class {
          constructor() {
            return {
              instance: () => ({
                database: () => ({
                  databaseDialect: postgresDialect,
                  close: async () => {},
                }),
              }),
              close: async () => {},
            };
          }
        },
      }),
    );
    await expect(
      cachedDialectClient.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      }),
    ).resolves.toBe('POSTGRESQL');

    const bareDbClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => ({
        Spanner: class {
          constructor() {
            return {
              instance: () => ({
                database: () => ({}),
              }),
            };
          }
        },
      }),
    );
    await expect(
      bareDbClient.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      }),
    ).resolves.toBeUndefined();

    const rpcErrorFixture = createFakeSdkFixture({
      getDatabaseDialectError: new Error('DatabaseAdmin unavailable'),
    });
    const rpcErrorClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => rpcErrorFixture.fakeModule,
    );
    await expect(
      rpcErrorClient.getDatabaseDialect({
        instanceId: 'test-instance',
        databaseId: 'test-database',
      }),
    ).rejects.toThrow('DatabaseAdmin unavailable');
  });

  it('normalizes JSON-object rows, Date cells, direct database queries, and unsupported snapshot handles', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const jsonRowsClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => ({
        Spanner: class {
          constructor() {
            return {
              instance: () => ({
                database: () => ({
                  // Omit getSnapshot so withSnapshot falls back to database.run.
                  run: async () => [
                    [
                      {TABLE_NAME: 'Singers', CREATED_AT: now},
                      {table_name: 'Albums', created_at: 'yesterday'},
                    ],
                  ],
                  close: async () => {},
                }),
              }),
              close: async () => {},
            };
          }
        },
      }),
    );

    const rowsWithColumns = await jsonRowsClient.runReadOnlyQuery({
      instanceId: 'test-instance',
      databaseId: 'test-database',
      sql: 'SELECT TABLE_NAME, CREATED_AT FROM T',
      paramTypes: {p1: {code: 'STRING'}},
      columns: ['TABLE_NAME', 'CREATED_AT', 'MISSING_COL'],
      maxRows: 5,
    });
    expect(rowsWithColumns).toEqual([
      ['Singers', now, undefined],
      ['Albums', 'yesterday', undefined],
    ]);

    const rowsWithoutColumns = await jsonRowsClient.runReadOnlyQuery({
      instanceId: 'test-instance',
      databaseId: 'test-database',
      sql: 'SELECT TABLE_NAME, CREATED_AT FROM T',
    });
    expect(rowsWithoutColumns).toEqual([
      ['Singers', now],
      ['Albums', 'yesterday'],
    ]);

    await expect(
      jsonRowsClient.runReadOnlyQuery({
        instanceId: 'test-instance',
        databaseId: 'test-database',
        sql: 'SELECT TABLE_NAME FROM T',
        maxRows: 0,
      }),
    ).resolves.toEqual([]);
    await expect(
      jsonRowsClient.runReadOnlyQuery({
        instanceId: 'test-instance',
        databaseId: 'test-database',
        sql: 'SELECT TABLE_NAME FROM T',
        maxRows: -1,
      }),
    ).resolves.toEqual([]);

    const zeroMaxStreamFixture = createFakeSdkFixture({
      useStream: true,
      streamRows: [[1], [2]],
    });
    const zeroMaxClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => zeroMaxStreamFixture.fakeModule,
    );
    await expect(
      zeroMaxClient.runReadOnlyQuery({
        instanceId: 'test-instance',
        databaseId: 'test-database',
        sql: 'SELECT 1',
        maxRows: 0,
      }),
    ).resolves.toEqual([]);

    const unsupportedSnapshotClient = createClientWithSdk(
      {projectId: 'test-gcp-project'},
      async () => ({
        Spanner: class {
          constructor() {
            return {
              instance: () => ({
                database: () => ({
                  getSnapshot: async () => [{}],
                  close: async () => {},
                }),
              }),
              close: async () => {},
            };
          }
        },
      }),
    );
    await expect(
      unsupportedSnapshotClient.runReadOnlyQuery({
        instanceId: 'test-instance',
        databaseId: 'test-database',
        sql: 'SELECT 1',
      }),
    ).rejects.toThrow(
      'Spanner snapshot does not support runStream() or run().',
    );
  });
});
