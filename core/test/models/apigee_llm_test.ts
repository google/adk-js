/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {afterEach, describe, expect, it, vi} from 'vitest';

import {GoogleGenAI, HttpOptions} from '@google/genai';

import {
  ApigeeLlm,
  ApigeeLlmParams,
  BaseLlmConnection,
  Gemini,
  LLMRegistry,
  LlmRequest,
} from '@google/adk';

const geminiModelString = 'apigee/gemini/gemini-1.5-flash';
const vertexModelString = 'apigee/vertex_ai/model-id';
const defaultProxyUrl = 'https://proxy.example.com';

describe('ApigeeLlm', () => {
  afterEach(() => {
    delete process.env['APIGEE_PROXY_URL'];
    delete process.env['GOOGLE_GENAI_API_KEY'];
    delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  });

  describe('constructor', () => {
    it('simple gemini model', () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      expect(llm).toBeInstanceOf(ApigeeLlm);
    });

    it('models that do not start with apigee are invalid', () => {
      expect(() => {
        new ApigeeLlm({model: 'invalid/model', proxyUrl: defaultProxyUrl});
      }).toThrowError(/Model invalid\/model is not a valid Apigee model/);
    });

    it('gemini throws error if if proxy URL is not provided', () => {
      expect(() => {
        new ApigeeLlm({model: geminiModelString});
      }).toThrowError(/Proxy URL must be provided/);
    });

    it('gemini uses APIGEE_PROXY_URL env variable if proxyUrl is not provided', () => {
      process.env['APIGEE_PROXY_URL'] = 'https://env-proxy.example.com';
      const llm = new ApigeeLlm({
        model: geminiModelString,
      });
      expect(llm['proxyUrl']).toBe('https://env-proxy.example.com');
    });

    it('vertexai is used if the model starts with apigee/vertex_ai/', () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';
      const llm = new ApigeeLlm({
        model: vertexModelString,
        proxyUrl: defaultProxyUrl,
      });
      expect(llm['vertexai']).toBe(true);
    });

    it('vertexai is used if GOOGLE_GENAI_USE_VERTEXAI is true', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';
      const llm = new ApigeeLlm({
        model: 'apigee/unknown-model',
        proxyUrl: defaultProxyUrl,
      });
      expect(llm['vertexai']).toBe(true);
    });

    interface EnvVarTestCase {
      description: string;
      envVars: Record<string, string>;
      expectedError: RegExp;
    }

    const envVarTestCases: EnvVarTestCase[] = [
      {
        description:
          'vertexai with no project throws an error about missing GOOGLE_CLOUD_PROJECT',
        envVars: {},
        expectedError: /GOOGLE_CLOUD_PROJECT/,
      },
      {
        description:
          'vertexai with project but no location throws an error about missing GOOGLE_CLOUD_LOCATION',
        envVars: {
          'GOOGLE_CLOUD_PROJECT': 'test-project',
        },
        expectedError: /GOOGLE_CLOUD_LOCATION/,
      },
      {
        description:
          'vertexai with project and location but no proxy url throws an error about missing APIGEE_PROXY_URL',
        envVars: {
          'GOOGLE_CLOUD_LOCATION': 'us-central1',
          'GOOGLE_CLOUD_PROJECT': 'test-project',
        },
        expectedError: /APIGEE_PROXY_URL/,
      },
    ];

    envVarTestCases.forEach(({description, envVars, expectedError}) => {
      it(description, () => {
        Object.entries(envVars).forEach(([key, value]) => {
          process.env[key] = value;
        });

        expect(() => {
          new ApigeeLlm({model: vertexModelString});
        }).toThrowError(expectedError);
      });
    });
  });

  describe('apiClient', () => {
    it('should configure apiClient with proxyUrl', () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      const apiClient = llm.apiClient;
      const httpOptions = apiClient['apiClient']['clientOptions'][
        'httpOptions'
      ] as HttpOptions;
      expect(httpOptions.baseUrl).toBe('https://proxy.example.com');
    });
  });

  describe('liveApiClient', () => {
    it('should return a GoogleGenAI instance', () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      expect(llm.liveApiClient).toBeInstanceOf(GoogleGenAI);
    });

    it('should configure liveApiClient with proxyUrl', () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      const liveApiClient = llm.liveApiClient;
      const httpOptions = liveApiClient['apiClient']['clientOptions'][
        'httpOptions'
      ] as HttpOptions;
      expect(httpOptions.baseUrl).toBe('https://proxy.example.com');
    });

    it('should include apiVersion and exclude user headers in liveApiClient', () => {
      const userHeaders = {'x-custom-header': 'should-not-be-here'};
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
        headers: userHeaders,
      });
      const liveApiClient = llm.liveApiClient;
      const httpOptions = liveApiClient['apiClient']['clientOptions'][
        'httpOptions'
      ] as HttpOptions;

      expect(httpOptions.apiVersion).toBe(llm.liveApiVersion);
      expect(httpOptions.headers).toBeDefined();
      expect(httpOptions.headers!['x-goog-api-client']).toContain(
        'google-adk/',
      );
      // user headers should not be included in live api client calls.
      expect(httpOptions.headers!['x-custom-header']).toBeUndefined();
      expect(httpOptions.baseUrl).toBe(defaultProxyUrl);
    });
  });

  describe('generateContentAsync', () => {
    it('should use the modified model in the base path', async () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      const request: LlmRequest = {
        contents: [
          {
            parts: [{text: 'Hello'}],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      };

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({candidates: []}), {status: 200}),
        );

      const generator = llm.generateContentAsync(request);
      await generator.next();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const fetchArgs = fetchSpy.mock.lastCall!;
      const url = fetchArgs[0];
      expect(url).toContain('https://proxy.example.com');
      expect(url).toContain('gemini-1.5-flash');
    });

    it('should use model from request if provided', async () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      const request: LlmRequest = {
        contents: [
          {
            parts: [{text: 'Hello'}],
          },
        ],
        model: 'apigee/gemini/other-model',
        liveConnectConfig: {},
        toolsDict: {},
      };

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({candidates: []}), {status: 200}),
        );

      const generator = llm.generateContentAsync(request);
      await generator.next();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const fetchArgs = fetchSpy.mock.lastCall!;
      const url = fetchArgs[0];
      expect(url).toContain('https://proxy.example.com');
      expect(url).toContain('other-model');
    });
  });

  describe('connect', () => {
    it('should call super.connect with modified model ID', async () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      const request: LlmRequest = {
        contents: [
          {
            parts: [{text: 'Hello'}],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      };

      // Spy on super.connect (Gemini.prototype.connect)
      const connectSpy = vi
        .spyOn(Gemini.prototype, 'connect')
        .mockResolvedValue({} as BaseLlmConnection);

      await llm.connect(request);

      expect(connectSpy).toHaveBeenCalledTimes(1);
      const calledRequest = connectSpy.mock.lastCall![0];
      // Original model is 'apigee/gemini/gemini-1.5-flash'
      // Expected model passed to super.connect is 'gemini-1.5-flash'
      expect(calledRequest.model).toBe('gemini-1.5-flash');
    });

    it('should call super.connect with modified model ID from request override', async () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      const request: LlmRequest = {
        contents: [
          {
            parts: [{text: 'Hello'}],
          },
        ],
        model: 'apigee/gemini/other-model-connect',
        liveConnectConfig: {},
        toolsDict: {},
      };

      // Spy on super.connect (Gemini.prototype.connect)
      const connectSpy = vi
        .spyOn(Gemini.prototype, 'connect')
        .mockResolvedValue({} as BaseLlmConnection);

      await llm.connect(request);

      expect(connectSpy).toHaveBeenCalledTimes(1);
      const calledRequest = connectSpy.mock.lastCall![0];
      expect(calledRequest.model).toBe('other-model-connect');
    });
  });

  describe('validateModel (implicit via constructor)', () => {
    const validModels = [
      'apigee/model-id',
      'apigee/gemini/model-id',
      'apigee/v1/model-id',
      'apigee/vertex_ai/v1beta/model-id',
    ];

    validModels.forEach((model) => {
      it(`should accept valid model: ${model}`, () => {
        // Mock env vars for vertexai models to avoid other errors
        process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
        process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';
        expect(() => {
          new ApigeeLlm({model, proxyUrl: defaultProxyUrl});
        }).not.toThrowError(/not a valid Apigee model/);
      });
    });

    const invalidModels = [
      'apigee/',
      'model-id',
      'apigee/invalid_provider/model-id',
      'apigee/gemini/v1beta1/',
      'apigee/gemini/v1beta1/model-id/extra',
      'apigee/provider/version/model-id/extra',
    ];

    invalidModels.forEach((model) => {
      it(`should throw for invalid model: ${model}`, () => {
        expect(() => {
          new ApigeeLlm({model, proxyUrl: defaultProxyUrl});
        }).toThrowError(/not a valid Apigee model/);
      });
    });
  });

  describe('getModelId (implicit via generateContentAsync)', () => {
    const modelIdTestCases = [
      {model: 'apigee/model-id1', expected: 'model-id1'},
      {model: 'apigee/gemini/model-id2', expected: 'model-id2'},
      {model: 'apigee/vertex_ai/model-id3', expected: 'model-id3'},
      {model: 'apigee/v1/model-id4', expected: 'model-id4'},
      {model: 'apigee/gemini/v1beta1/model-id5', expected: 'model-id5'},
      {model: 'apigee/vertex_ai/v1beta/model-id6', expected: 'model-id6'},
    ];

    modelIdTestCases.forEach(({model, expected}) => {
      it(`should extract model ID correctly for ${model} in request`, async () => {
        const llm = new ApigeeLlm({
          model: geminiModelString,
          proxyUrl: defaultProxyUrl,
        });

        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(
            new Response(JSON.stringify({candidates: []}), {status: 200}),
          );

        const request: LlmRequest = {
          contents: [{parts: [{text: 'Hello'}]}],
          model: model, // Override model in request
          liveConnectConfig: {},
          toolsDict: {},
        };

        const generator = llm.generateContentAsync(request);
        await generator.next();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const url = fetchSpy.mock.lastCall![0] as string;
        // Verify the URL contains the expected model ID
        expect(url).toContain(expected);
      });
    });

    it('should throw error for invalid model string in request', async () => {
      const llm = new ApigeeLlm({
        model: geminiModelString,
        proxyUrl: defaultProxyUrl,
      });
      const request: LlmRequest = {
        contents: [],
        model: 'invalid/model',
        liveConnectConfig: {},
        toolsDict: {},
      };

      const generator = llm.generateContentAsync(request);
      await expect(generator.next()).rejects.toThrowError(
        /not a valid Apigee model/,
      );
    });
  });

  describe('supportedModels', () => {
    it('should have a single regex', () => {
      expect(ApigeeLlm.supportedModels.length).toBe(1);
    });

    const modelRegex = ApigeeLlm.supportedModels[0];

    it('should match valid models', () => {
      expect('apigee/model-id').toMatch(modelRegex);
      expect('apigee/gemini/model-id').toMatch(modelRegex);
      expect('apigee/vertex_ai/model-id').toMatch(modelRegex);
      expect('apigee/v1/model-id').toMatch(modelRegex);
      expect('apigee/gemini/v1beta1/model-id').toMatch(modelRegex);
      expect('apigee/vertex_ai/v1beta/model-id').toMatch(modelRegex);
    });

    it('should not match invalid models', () => {
      expect('model-id').not.toMatch(modelRegex);
      expect('').not.toMatch(modelRegex);
    });
  });

  describe('liveApiVersion', () => {
    interface ApiVersionTestCase {
      description: string;
      llmParams: ApigeeLlmParams;
      expectedVersion: string;
      setupEnv?: Record<string, string>;
    }

    const geminiApiVersionCases: ApiVersionTestCase[] = [
      {
        description: 'geminiModelString (no version defaults to v1alpha)',
        llmParams: {model: geminiModelString, proxyUrl: defaultProxyUrl},
        expectedVersion: 'v1alpha',
      },
      {
        description: 'apigee/v1/gemini-1.5-flash uses v1',
        llmParams: {
          model: 'apigee/v1/gemini-1.5-flash',
          proxyUrl: defaultProxyUrl,
        },
        expectedVersion: 'v1',
      },
      {
        description: 'apigee/gemini/v2/gemini-1.5-flash uses v2',
        llmParams: {
          model: 'apigee/gemini/v2/gemini-1.5-flash',
          proxyUrl: defaultProxyUrl,
        },
        expectedVersion: 'v2',
      },
    ];

    geminiApiVersionCases.forEach(
      ({description, llmParams, expectedVersion}) => {
        it(description, () => {
          const llm = new ApigeeLlm(llmParams);
          expect(llm.liveApiVersion).toBe(expectedVersion);
        });
      },
    );

    const vertexApiVersionCases: ApiVersionTestCase[] = [
      {
        description:
          'apigee/vertex_ai/model-id (no version defaults to v1beta1)',
        llmParams: {model: vertexModelString, proxyUrl: defaultProxyUrl},
        expectedVersion: 'v1beta1',
        setupEnv: {
          'GOOGLE_GENAI_USE_VERTEXAI': 'true',
          'GOOGLE_CLOUD_PROJECT': 'test-project',
          'GOOGLE_CLOUD_LOCATION': 'us-central1',
        },
      },
      {
        description: 'apigee/vertex_ai/v3/model-id uses v3',
        llmParams: {
          model: 'apigee/vertex_ai/v3/model-id',
          proxyUrl: defaultProxyUrl,
        },
        expectedVersion: 'v3',
        setupEnv: {
          'GOOGLE_GENAI_USE_VERTEXAI': 'true',
          'GOOGLE_CLOUD_PROJECT': 'test-project',
          'GOOGLE_CLOUD_LOCATION': 'us-central1',
        },
      },
    ];

    vertexApiVersionCases.forEach(
      ({description, llmParams, expectedVersion, setupEnv}) => {
        it(description, () => {
          if (setupEnv) {
            Object.entries(setupEnv).forEach(([key, value]) => {
              process.env[key] = value;
            });
          }
          const llm = new ApigeeLlm(llmParams);
          expect(llm.liveApiVersion).toBe(expectedVersion);
        });
      },
    );
  });
});

describe('ApigeeLlm LLMRegistry integration', () => {
  beforeAll(() => {
    process.env['APIGEE_PROXY_URL'] = defaultProxyUrl;
    process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';
  });

  afterAll(() => {
    delete process.env['APIGEE_PROXY_URL'];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  });

  it('ApigeeLlm is registered by default', () => {
    expect(LLMRegistry.newLlm('apigee/gemini/gemini-1.5-flash')).toBeInstanceOf(
      ApigeeLlm,
    );
  });
});
