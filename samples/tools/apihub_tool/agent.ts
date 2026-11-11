/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API Hub tool: an API registered in API Hub becomes a toolset
 * ../../../docs/guides/tools/apihub_tool/index.md
 *
 * `APIHubToolset` fetches an OpenAPI spec through a `BaseAPIHubClient` and
 * produces one `RestApiTool` per operation, the way `OpenAPIToolset` does for
 * a spec you already hold.
 *
 *   - By default the client is `LocalSpecClient` below, which serves
 *     `apihub_spec.yaml` from disk. That stands in for API Hub, so the sample
 *     runs without a Google Cloud project.
 *   - Set APIHUB_RESOURCE_NAME to an API, a version or a spec in your API Hub
 *     instance, and the sample uses the real `APIHubClient` instead. It
 *     authenticates with APIHUB_ACCESS_TOKEN when that is set, and with
 *     application default credentials otherwise.
 *
 * `lazyLoadSpec: true` defers the fetch to the first `getTools` call, which
 * the agent makes on its first turn. Loading this module therefore does no
 * network I/O, and a fetch failure is reported on that turn.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, optionally set APIHUB_RESOURCE_NAME
 * and APIHUB_ACCESS_TOKEN, then:
 *   npm run sample -- samples/tools/apihub_tool/agent.ts
 * Try "give me a random identifier".
 */

import {
  APIHubClient,
  APIHubToolset,
  BaseAPIHubClient,
  LlmAgent,
} from '@google/adk';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'apihub_spec.yaml',
);

/**
 * A `BaseAPIHubClient` that ignores the resource name and returns a spec from
 * disk. A custom client is also how you would add caching, or read specs from
 * somewhere other than API Hub.
 */
class LocalSpecClient implements BaseAPIHubClient {
  async getSpecContent(_path: string): Promise<string> {
    return readFile(SPEC_PATH, 'utf8');
  }
}

const resourceName = process.env.APIHUB_RESOURCE_NAME;

const apihubToolset = new APIHubToolset({
  apihubResourceName:
    resourceName ?? 'projects/local/locations/local/apis/httpbin',
  apihubClient: resourceName
    ? new APIHubClient({accessToken: process.env.APIHUB_ACCESS_TOKEN})
    : new LocalSpecClient(),
  lazyLoadSpec: true,
});

/** Every operation in the spec. This is the agent the CLI runs. */
export const rootAgent = new LlmAgent({
  name: 'apihub_agent',
  model: 'gemini-flash-latest',
  description: 'Calls an API whose spec comes from API Hub.',
  instruction:
    'You call an HTTP API through the tools you have. Use get_uuid for a ' +
    'random identifier and get_echo to echo a message back. If a tool ' +
    'returns an error, report the error instead of inventing an answer.',
  tools: [apihubToolset],
});
