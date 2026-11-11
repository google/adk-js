/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAPI tool: a spec becomes a toolset, one tool, and an authenticated call
 * ../../../docs/guides/tools/openapi_tool/index.md
 *
 * `OpenAPIToolset` reads an OpenAPI v3 document and produces one `RestApiTool`
 * per operation. This sample runs the whole path against https://httpbin.org
 * from a single inline spec:
 *
 *   - `tools: [httpbinToolset]` hands `httpbin_agent` every operation.
 *   - `toolset.getTool('get_uuid')` selects exactly one, so the sub-agent
 *     `uuid_agent` can call that operation and nothing else.
 *   - `tokenToSchemeCredential` builds the scheme and credential pair the
 *     toolset puts on every request, and `get_bearer` is the operation that
 *     proves the header arrived: httpbin answers 401 without it.
 *
 * `getTool` looks up the name the toolset stored, which is the `operationId`
 * in snake_case, so `getUuid` is `get_uuid`. A toolset built with `prefix`
 * stores the prefixed name. The lookup ignores `toolFilter`, which decides
 * what an agent exposes rather than what the toolset holds.
 *
 * httpbin issues no credentials of its own — it echoes back whatever bearer
 * token you send — so the token below is a stand-in for a real one and the
 * only key this sample needs is the one for the model.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, optionally set HTTPBIN_TOKEN, then:
 *   npm run sample -- samples/tools/openapi_tool/agent.ts
 * Try "give me a random identifier".
 */

import {LlmAgent, OpenAPIToolset, tokenToSchemeCredential} from '@google/adk';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// The spec lives beside this file rather than inside it. A real caller loads a
// document they were given; inlining sixty lines of YAML in a string would put
// the sample's subject behind its fixture.
const HTTPBIN_SPEC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'httpbin_spec.yaml'),
  'utf8',
);

// The scheme says where the credential travels and the credential carries the
// secret, so the helper returns both rather than leaving a caller to match
// them. 'oauth2Token' yields a bearer scheme and an HTTP bearer credential,
// which reaches httpbin as `Authorization: Bearer …`.
const [authScheme, authCredential] = tokenToSchemeCredential(
  'oauth2Token',
  undefined,
  undefined,
  process.env.HTTPBIN_TOKEN ?? 'demo-openapi-token',
);

// The pair is a toolset-wide override: it reaches every tool the spec
// produced, including the one handed to the sub-agent below.
const httpbinToolset = new OpenAPIToolset({
  specStr: HTTPBIN_SPEC,
  specType: 'yaml',
  authScheme,
  authCredential,
});

const uuidTool = httpbinToolset.getTool('get_uuid');
if (!uuidTool) {
  throw new Error('The httpbin spec did not produce a get_uuid tool.');
}

/** Exactly one operation from the spec, selected by name. */
const uuidAgent = new LlmAgent({
  name: 'uuid_agent',
  model: 'gemini-flash-latest',
  description:
    'Generates a random identifier. Use it for any request for a ' +
    'UUID or a random identifier.',
  instruction: 'You generate random identifiers. Always call get_uuid.',
  tools: [uuidTool],
});

/** Every operation in the spec. This is the agent the CLI runs. */
export const rootAgent = new LlmAgent({
  name: 'httpbin_agent',
  model: 'gemini-flash-latest',
  description: 'Calls the httpbin API through an OpenAPI spec.',
  instruction:
    'You call the httpbin API. Use get_echo to echo a message back, and ' +
    'get_bearer to check whether the request was authenticated — report the ' +
    'token it echoes back. Transfer to uuid_agent for a random identifier. ' +
    'If a tool returns an error, report the error instead of inventing an ' +
    'answer.',
  tools: [httpbinToolset],
  subAgents: [uuidAgent],
});
