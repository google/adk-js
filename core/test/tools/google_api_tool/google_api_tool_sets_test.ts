/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigQueryToolset,
  bigqueryToolSet,
  CalendarToolset,
  calendarToolSet,
  DocsToolset,
  docsToolSet,
  GmailToolset,
  gmailToolSet,
  GoogleApiSpec,
  GoogleApiTool,
  GoogleApiToolSet,
  GoogleApiToolsetOptions,
  isGoogleApiToolSet,
  isGoogleApiToolset,
  logger,
  SheetsToolset,
  sheetsToolSet,
  SlidesToolset,
  slidesToolSet,
  YoutubeToolset,
  youtubeToolSet,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createLazyGoogleApiToolSet} from '../../../src/tools/google_api_tool/google_api_tool_set.js';

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

describe('google_api_tool_sets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports all seven pre-configured Google API toolsets without fetching or warning on import', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const lazySingleton = createLazyGoogleApiToolSet('calendar', 'v3');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(isGoogleApiToolSet(lazySingleton)).toBe(true);

    const entries: Array<{
      toolset: GoogleApiToolSet;
      apiName: string;
      apiVersion: string;
    }> = [
      {toolset: calendarToolSet, apiName: 'calendar', apiVersion: 'v3'},
      {toolset: bigqueryToolSet, apiName: 'bigquery', apiVersion: 'v2'},
      {toolset: gmailToolSet, apiName: 'gmail', apiVersion: 'v1'},
      {toolset: youtubeToolSet, apiName: 'youtube', apiVersion: 'v3'},
      {toolset: slidesToolSet, apiName: 'slides', apiVersion: 'v1'},
      {toolset: sheetsToolSet, apiName: 'sheets', apiVersion: 'v4'},
      {toolset: docsToolSet, apiName: 'docs', apiVersion: 'v1'},
    ];

    for (const {toolset, apiName, apiVersion} of entries) {
      expect(isGoogleApiToolSet(toolset)).toBe(true);
      expect(toolset.apiName).toBe(apiName);
      expect(toolset.apiVersion).toBe(apiVersion);
    }
  });

  it('lazily loads tools when getTools is called on a pre-configured toolset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => createDiscoverySpecFor('calendar', 'v3'),
    } as Response);

    const tools = await calendarToolSet.getTools();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('calendar_items_list');
  });
});

describe('GoogleApiToolset service classes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs isolated instances for all seven Google API toolset classes with auth and toolFilter options', async () => {
    const cases: Array<{
      ToolsetClass: new (options?: GoogleApiToolsetOptions) => GoogleApiToolSet;
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

    for (const {ToolsetClass, apiName, apiVersion} of cases) {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => createDiscoverySpecFor(apiName, apiVersion),
      } as Response);
      const configureAuthSpy = vi.spyOn(
        GoogleApiTool.prototype,
        'configureAuth',
      );

      const filteredToolset = new ToolsetClass({
        clientId: `${apiName}-client-id`,
        clientSecret: `${apiName}-client-secret`,
        toolFilter: [`${apiName}_items_list`],
      });
      const excludedToolset = new ToolsetClass({
        toolFilter: ['other_tool'],
      });

      expect(isGoogleApiToolset(filteredToolset)).toBe(true);
      expect(filteredToolset.apiName).toBe(apiName);
      expect(filteredToolset.apiVersion).toBe(apiVersion);

      const tools = await filteredToolset.getTools();
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://www.googleapis.com/discovery/v1/apis/${apiName}/${apiVersion}/rest`,
      );
      expect(tools.map((t) => t.name)).toEqual([`${apiName}_items_list`]);
      expect(configureAuthSpy).toHaveBeenCalledWith(
        `${apiName}-client-id`,
        `${apiName}-client-secret`,
      );

      const excludedTools = await excludedToolset.getTools();
      expect(excludedTools).toEqual([]);

      fetchSpy.mockRestore();
      configureAuthSpy.mockRestore();
    }
  });
});
