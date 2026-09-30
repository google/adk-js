/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python v0.1.0
 * src/google/adk/tests/unittests/tools/openapi_tool/openapi_spec_parser/test_openapi_toolset.py
 * Test names are kept verbatim so the original can be grepped.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  OpenAPIToolset,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import * as fs from 'fs';
import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The names adk-python v0.1.0's own `test_openapi_toolset.py` asserts.
 * `OperationParser.getFunctionName` snake-cases the source `operationId` the
 * way `to_snake_case` does in adk-python, so `calendar.calendars.insert`
 * becomes `calendar_calendars_insert` in both SDKs.
 */
const INSERT_TOOL = 'calendar_calendars_insert';
const GET_TOOL = 'calendar_calendars_get';
const UPDATE_TOOL = 'calendar_calendars_update';
const DELETE_TOOL = 'calendar_calendars_delete';
const PATCH_TOOL = 'calendar_calendars_patch';

const ALL_TOOLS = [INSERT_TOOL, GET_TOOL, UPDATE_TOOL, DELETE_TOOL, PATCH_TOOL];

describe('OpenAPIToolset parity with adk-python v0.1.0', () => {
  let specStr: string;
  let openapiSpec: OpenAPIV3.Document;

  beforeEach(() => {
    const specPath = path.resolve(__dirname, 'fixtures/calendar.yaml');
    specStr = fs.readFileSync(specPath, 'utf8');
    openapiSpec = yaml.load(specStr) as OpenAPIV3.Document;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('test_openapi_toolset_initialization_from_dict', async () => {
    const toolset = new OpenAPIToolset({specDict: openapiSpec});
    const tools = await toolset.getTools();

    expect(tools.length).toBe(5);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...ALL_TOOLS].sort(),
    );
    for (const name of ALL_TOOLS) {
      expect(toolset.getTool(name)?._getDeclaration()?.name).toBe(name);
    }
  });

  it('test_openapi_toolset_initialization_from_yaml_string', async () => {
    const toolset = new OpenAPIToolset({specStr, specType: 'yaml'});
    const tools = await toolset.getTools();

    expect(tools.length).toBe(5);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...ALL_TOOLS].sort(),
    );
  });

  it('test_openapi_toolset_tool_existing', () => {
    const toolset = new OpenAPIToolset({specDict: openapiSpec});

    const insertTool = toolset.getTool(INSERT_TOOL);
    if (!insertTool) expect.fail(`${INSERT_TOOL} was not parsed`);
    expect(insertTool.name).toBe(INSERT_TOOL);
    expect(insertTool.description).toBe('Creates a secondary calendar.');
    expect(insertTool.isLongRunning).toBe(false);

    const getTool = toolset.getTool(GET_TOOL);
    if (!getTool) expect.fail(`${GET_TOOL} was not parsed`);
    expect(getTool.name).toBe(GET_TOOL);
    expect(getTool.description).toBe('Returns metadata for a calendar.');
    expect(getTool.isLongRunning).toBe(false);

    // adk-js snake_cases the parameter name, so the path parameter `calendarId`
    // reaches the model as `calendar_id`.
    const parameters = getTool._getDeclaration()?.parameters;
    expect(Object.keys(parameters?.properties ?? {})).toContain('calendar_id');
    expect(parameters?.required).toContain('calendar_id');
    // adk-js merges the 7 path-level parameters of `/calendars/{calendarId}`
    // into the operation, where adk-python v0.1.0 asserts the 1 operation-level
    // parameter only. adk-js is ahead, so assert what adk-js produces.
    expect(Object.keys(parameters?.properties ?? {}).length).toBe(8);

    expect(toolset.getTool(UPDATE_TOOL)?.name).toBe(UPDATE_TOOL);
    expect(toolset.getTool(DELETE_TOOL)?.name).toBe(DELETE_TOOL);
    expect(toolset.getTool(PATCH_TOOL)?.name).toBe(PATCH_TOOL);
  });

  it('test_openapi_toolset_tool_non_existing', () => {
    const toolset = new OpenAPIToolset({specDict: openapiSpec});

    expect(toolset.getTool('non_existent_tool')).toBeUndefined();
  });

  it('test_openapi_toolset_configure_auth_on_init', async () => {
    const authScheme: OpenAPIV3.ApiKeySecurityScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'api_key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'parity-api-key',
    };
    const configureScheme = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthScheme',
    );
    const configureCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );

    const toolset = new OpenAPIToolset({
      specDict: openapiSpec,
      authScheme,
      authCredential,
    });

    // adk-python reads `tool.auth_scheme` and `tool.auth_credential` directly.
    // Both are private in adk-js, so assert the toolset configured every tool.
    expect(configureScheme.mock.calls).toEqual(
      ALL_TOOLS.map(() => [authScheme]),
    );
    expect(configureCredential.mock.calls).toEqual(
      ALL_TOOLS.map(() => [authCredential]),
    );
    configureScheme.mockRestore();
    configureCredential.mockRestore();

    // A spy proves the call happened; this proves the credential reached the
    // request the tool sends.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{}', {headers: {'content-type': 'application/json'}}),
      );
    vi.stubGlobal('fetch', fetchMock);
    const getTool = toolset.getTool(GET_TOOL);
    if (!getTool) expect.fail(`${GET_TOOL} was not parsed`);
    await getTool.runAsync({
      args: {calendar_id: 'primary'},
      toolContext: new Context({
        invocationContext: new InvocationContext({
          invocationId: 'invocation-1',
          agent: new LlmAgent({name: 'test_agent'}),
          session: createSession({id: 'session-1', appName: 'test_app'}),
          pluginManager: new PluginManager(),
        }),
      }),
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit?.headers).toMatchObject({api_key: 'parity-api-key'});
  });
});
