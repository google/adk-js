/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigQueryToolset,
  CalendarToolset,
  DocsToolset,
  GmailToolset,
  GoogleApiTool,
  GoogleApiToolset,
  GoogleApiToolsetOptions,
  isGoogleApiToolset,
  SheetsToolset,
  SlidesToolset,
  YoutubeToolset,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {GoogleApiSpec} from '../../../src/tools/google_api_tool/googleapi_to_openapi_converter.js';

function createDiscoverySpecFor(
  apiName: string,
  apiVersion: string,
): GoogleApiSpec {
  return {
    kind: 'discovery#restDescription',
    id: `${apiName}:${apiVersion}`,
    name: apiName,
    version: apiVersion,
    title: `${apiName} API`,
    description: `Test spec for ${apiName}`,
    rootUrl: 'https://www.googleapis.com/',
    servicePath: `${apiName}/${apiVersion}/`,
    auth: {
      oauth2: {
        scopes: {
          [`https://www.googleapis.com/auth/${apiName}`]: {
            description: `Access ${apiName}`,
          },
        },
      },
    },
    resources: {
      items: {
        methods: {
          list: {
            id: `${apiName}.items.list`,
            path: 'items',
            httpMethod: 'GET',
            description: `Lists ${apiName} items.`,
            scopes: [`https://www.googleapis.com/auth/${apiName}`],
          },
        },
      },
    },
  };
}

const PREBUILT_TOOLSETS: Array<{
  ToolsetClass: new (options?: GoogleApiToolsetOptions) => GoogleApiToolset;
  apiName: string;
  apiVersion: string;
}> = [
  {ToolsetClass: BigQueryToolset, apiName: 'bigquery', apiVersion: 'v2'},
  {ToolsetClass: CalendarToolset, apiName: 'calendar', apiVersion: 'v3'},
  {ToolsetClass: GmailToolset, apiName: 'gmail', apiVersion: 'v1'},
  {ToolsetClass: YoutubeToolset, apiName: 'youtube', apiVersion: 'v3'},
  {ToolsetClass: SlidesToolset, apiName: 'slides', apiVersion: 'v1'},
  {ToolsetClass: SheetsToolset, apiName: 'sheets', apiVersion: 'v4'},
  {ToolsetClass: DocsToolset, apiName: 'docs', apiVersion: 'v1'},
];

describe('GoogleApiToolset prebuilt service classes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_prebuilt_toolset_targets_its_documented_api_and_version', () => {
    for (const {ToolsetClass, apiName, apiVersion} of PREBUILT_TOOLSETS) {
      const toolset = new ToolsetClass();
      expect(isGoogleApiToolset(toolset)).toBe(true);
      expect(toolset.apiName).toBe(apiName);
      expect(toolset.apiVersion).toBe(apiVersion);
    }
  });

  it('test_prebuilt_toolset_forwards_constructor_arguments', async () => {
    for (const {ToolsetClass, apiName, apiVersion} of PREBUILT_TOOLSETS) {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => createDiscoverySpecFor(apiName, apiVersion),
      } as Response);
      const configureAuthSpy = vi.spyOn(
        GoogleApiTool.prototype,
        'configureAuth',
      );

      const toolFilter = [`${apiName}_items_list`];
      const toolset = new ToolsetClass({
        clientId: `${apiName}-client-id`,
        clientSecret: `${apiName}-client-secret`,
        toolFilter,
      });

      expect(toolset.toolFilter).toEqual(toolFilter);

      const tools = await toolset.getTools();
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://www.googleapis.com/discovery/v1/apis/${apiName}/${apiVersion}/rest`,
      );
      expect(tools.map((t) => t.name)).toEqual([`${apiName}_items_list`]);
      expect(configureAuthSpy).toHaveBeenCalledWith(
        `${apiName}-client-id`,
        `${apiName}-client-secret`,
      );

      fetchSpy.mockRestore();
      configureAuthSpy.mockRestore();
    }
  });
});
