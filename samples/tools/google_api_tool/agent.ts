/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Google API tool: Discovery conversion, OpenID Connect auth, and tool filtering
 * ../../../docs/guides/tools/google_api_tool/index.md
 *
 * A deterministic `BaseAgent` that converts a Google Calendar Discovery
 * specification into an OpenAPI v3 document with `GoogleApiToOpenApiConverter`,
 * builds a `GoogleApiToolSet` configured with Google OpenID Connect endpoints
 * via `GoogleApiToolSet.loadToolSetWithOidcAuth`, narrows exposed operations
 * with `toolFilter`, configures OAuth 2.0 client credentials across all
 * `GoogleApiTool` instances with `configureAuth`, and invokes a tool to observe
 * the generated OpenID Connect authorization request.
 *
 * Easy to get wrong: `OpenAPIToolset` normalizes each Discovery method `id` to
 * `snake_case`, so `calendar.calendars.get` becomes `calendar_calendars_get`.
 * `toolFilter` narrows what `getTools()` exposes to an agent, while
 * `getTool(name)` searches every operation in the toolset regardless of the
 * active filter.
 *
 * The client secret is a placeholder string, and the agent prints its value
 * only in redacted form.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/tools/google_api_tool/agent.ts
 */

import {
  BaseAgent,
  calendarToolSet,
  Context,
  createEvent,
  Event,
  GoogleApiSpec,
  GoogleApiToolSet,
  GoogleApiToOpenApiConverter,
  InvocationContext,
  isGoogleApiTool,
  isGoogleApiToolSet,
  RestApiTool,
} from '@google/adk';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const PLACEHOLDER_CLIENT_ID = 'example-google-client-id';
const PLACEHOLDER_CLIENT_SECRET = 'example-google-client-secret';

const CALENDAR_DISCOVERY_SPEC = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      'calendar_discovery_spec.json',
    ),
    'utf8',
  ),
) as GoogleApiSpec;

/** Shows a secret's shape without its value. */
function redact(secret: string | undefined): string {
  return secret ? `<redacted, ${secret.length} chars>` : '<none>';
}

/** Runs the Discovery-to-OpenAPI conversion and inspects the toolset. */
async function describeGoogleApiToolSet(
  ctx: InvocationContext,
): Promise<string[]> {
  const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
  converter.googleApiSpec = CALENDAR_DISCOVERY_SPEC;
  const openApiSpec = await converter.convert();

  const scope = Object.keys(
    openApiSpec.components?.securitySchemes?.oauth2 &&
      'flows' in openApiSpec.components.securitySchemes.oauth2
      ? (openApiSpec.components.securitySchemes.oauth2.flows.authorizationCode
          ?.scopes ?? {})
      : {},
  )[0];

  const oidcToolset = GoogleApiToolSet.loadToolSetWithOidcAuth({
    specDict: openApiSpec,
    scopes: scope ? [scope] : [],
  });
  const restTools = ['calendar_calendars_get', 'calendar_calendars_clear']
    .map((name) => oidcToolset.getTool(name))
    .filter((tool): tool is RestApiTool => tool !== undefined);
  const unfilteredToolSet = new GoogleApiToolSet(restTools);
  const allTools = await unfilteredToolSet.getTools();

  const toolSet = new GoogleApiToolSet(restTools, {
    toolFilter: ['calendar_calendars_get'],
  });
  const filteredTools = await toolSet.getTools();
  toolSet.configureAuth(PLACEHOLDER_CLIENT_ID, PLACEHOLDER_CLIENT_SECRET);

  const getCalendarTool = await toolSet.getTool('calendar_calendars_get');
  const clearCalendarTool = await toolSet.getTool('calendar_calendars_clear');
  const declaration = getCalendarTool?._getDeclaration();
  const paramNames = Object.keys(declaration?.parameters?.properties ?? {});

  const toolContext = new Context({
    invocationContext: ctx,
    functionCallId: 'call_calendar_get',
  });
  await getCalendarTool?.runAsync({
    args: {calendar_id: 'primary'},
    toolContext,
  });
  const requestedAuth =
    toolContext.eventActions.requestedAuthConfigs['call_calendar_get'];
  const oauth2Cred = requestedAuth?.exchangedAuthCredential?.oauth2;

  await unfilteredToolSet.close();
  await toolSet.close();

  return [
    `Converted OpenAPI version: ${openApiSpec.openapi}`,
    `Server URL: ${openApiSpec.servers?.[0]?.url ?? '<none>'}`,
    `All tools (${allTools.length}): ${allTools.map((t) => t.name).join(', ')}`,
    `Filtered tools (${filteredTools.length}): ${filteredTools.map((t) => t.name).join(', ')}`,
    `Direct getTool ignores filter: ${Boolean(clearCalendarTool)}`,
    `isGoogleApiToolSet(calendarToolSet): ${isGoogleApiToolSet(calendarToolSet)}`,
    `isGoogleApiTool(getCalendarTool): ${isGoogleApiTool(getCalendarTool)}`,
    `calendar_calendars_get parameters: ${paramNames.join(', ')}`,
    `Configured OIDC clientId: ${oauth2Cred?.clientId ?? '<none>'}`,
    `Configured OIDC clientSecret: ${redact(oauth2Cred?.clientSecret)}`,
  ];
}

class GoogleApiShowcaseAgent extends BaseAgent {
  constructor() {
    super({
      name: 'google_api_showcase_agent',
      description:
        'Converts a Google Discovery specification into a GoogleApiToolSet and configures OpenID Connect credentials, offline.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const lines = await describeGoogleApiToolSet(ctx);

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {role: 'model', parts: [{text: lines.join('\n')}]},
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new GoogleApiShowcaseAgent();
