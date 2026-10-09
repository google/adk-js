/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Application Integration tool: an integration or a connection as tools
 * ../../../docs/guides/tools/application_integration_tool/index.md
 *
 * `ApplicationIntegrationToolset` turns a Google Cloud resource into
 * `RestApiTool`s. It works in one of two modes, and this sample picks the mode
 * from the environment:
 *
 *   - Integration mode: set INTEGRATION_NAME and INTEGRATION_TRIGGER. The
 *     toolset asks Application Integration for the OpenAPI spec of that API
 *     trigger, and the agent gets one tool per operation in it.
 *   - Connection mode: set CONNECTION_NAME and CONNECTION_ENTITIES,
 *     CONNECTION_ACTIONS, or both, as comma-separated lists. The toolset reads
 *     the connection's entity schemas and action schemas from Integration
 *     Connectors and builds the spec itself. Every entity here gets all of its
 *     supported operations, because an empty operation list means exactly that.
 *
 * Constructing the toolset only validates the options, so a missing value
 * fails when this module loads. Nothing reaches Google Cloud until the agent
 * first asks the toolset for its tools, at the start of the first turn.
 *
 * Connection mode routes every call through an integration named
 * `ExecuteConnection` with the API trigger `api_trigger/ExecuteConnection`,
 * which has to exist in the same project and region as the connection.
 *
 * The spec requests and the generated tools authenticate with Application
 * Default Credentials, so run `gcloud auth application-default login` or set
 * GOOGLE_APPLICATION_CREDENTIALS first.
 *
 * REQUIRES an API key and a Google Cloud project with Application Integration
 * or an Integration Connectors connection. Set GEMINI_API_KEY,
 * GOOGLE_CLOUD_PROJECT, optionally GOOGLE_CLOUD_LOCATION (default
 * us-central1), and the variables of one mode above, then:
 *   npm run sample -- samples/tools/application_integration_tool/agent.ts
 * Try "what can you do?".
 */

import {ApplicationIntegrationToolset, LlmAgent} from '@google/adk';

/** Reads a comma-separated environment variable as a list. */
function listFromEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) {
  throw new Error(
    'Set GOOGLE_CLOUD_PROJECT to the project that holds the integration or the connection.',
  );
}

// An empty operation list asks for every operation the entity supports. Name
// operations, such as {Issues: ['LIST', 'GET']}, to expose fewer.
const entityOperations = Object.fromEntries(
  listFromEnv('CONNECTION_ENTITIES').map((entity) => [entity, []]),
);

// The constructor throws unless the variables name either an integration and
// a trigger, or a connection with at least one entity or action.
const applicationIntegrationToolset = new ApplicationIntegrationToolset({
  project,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1',
  integration: process.env.INTEGRATION_NAME,
  trigger: process.env.INTEGRATION_TRIGGER,
  connection: process.env.CONNECTION_NAME,
  entityOperations,
  actions: listFromEnv('CONNECTION_ACTIONS'),
});

export const rootAgent = new LlmAgent({
  name: 'application_integration_agent',
  model: 'gemini-flash-latest',
  description:
    'An assistant that works with a Google Cloud integration or connection.',
  instruction:
    'You help the user with the system behind your tools. Call a tool to ' +
    'answer a question about its data or to run one of its actions. When a ' +
    'tool returns an error, tell the user what failed instead of guessing ' +
    'an answer.',
  tools: [applicationIntegrationToolset],
});
