/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Google API tool: CalendarToolset, OpenID Connect auth, and tool filtering
 * ../../../docs/guides/tools/google_api_tool/index.md
 *
 * A deterministic `BaseAgent` that instantiates a `CalendarToolset`,
 * narrows exposed operations with `toolFilter`, configures OAuth 2.0 client
 * credentials across all `GoogleApiTool` instances with `configureAuth`, and
 * invokes a tool to observe the generated OpenID Connect authorization request.
 *
 * Easy to get wrong: `CalendarToolset` normalizes each Discovery method `id` to
 * `snake_case`, so `calendar.calendars.get` becomes `calendar_calendars_get`.
 * `toolFilter` narrows what `getTools()` exposes to an agent.
 *
 * The client secret is a placeholder string, and the agent prints its value
 * only in redacted form.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/tools/google_api_tool/agent.ts
 */

import {
  BaseAgent,
  CalendarToolset,
  Context,
  createEvent,
  Event,
  InvocationContext,
  isGoogleApiTool,
  isGoogleApiToolset,
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
);

// Stub globalThis.fetch to support offline execution with the local calendar discovery fixture.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (
  ...args: Parameters<typeof globalThis.fetch>
): Promise<Response> => {
  const [input] = args;
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : 'url' in input
          ? input.url
          : String(input);
  if (url.includes('apis/calendar/v3/rest')) {
    return new Response(JSON.stringify(CALENDAR_DISCOVERY_SPEC), {
      status: 200,
      headers: {'Content-Type': 'application/json'},
    });
  }
  return originalFetch(...args);
};

/** Shows a secret's shape without its value. */
function redact(secret: string | undefined): string {
  return secret ? `<redacted, ${secret.length} chars>` : '<none>';
}

/** Instantiates CalendarToolset and inspects the tools. */
async function describeCalendarToolset(
  ctx: InvocationContext,
): Promise<string[]> {
  const unfilteredToolset = new CalendarToolset();
  const allTools = await unfilteredToolset.getTools();

  const toolset = new CalendarToolset({
    clientId: PLACEHOLDER_CLIENT_ID,
    clientSecret: PLACEHOLDER_CLIENT_SECRET,
    toolFilter: ['calendar_calendars_get'],
  });
  const filteredTools = await toolset.getTools();

  const getCalendarTool = filteredTools.find(
    (tool) => tool.name === 'calendar_calendars_get',
  );
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

  await unfilteredToolset.close();
  await toolset.close();

  return [
    `All tools (${allTools.length}): ${allTools.map((t) => t.name).join(', ')}`,
    `Filtered tools (${filteredTools.length}): ${filteredTools.map((t) => t.name).join(', ')}`,
    `isGoogleApiToolset(toolset): ${isGoogleApiToolset(toolset)}`,
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
        'Instantiates a CalendarToolset and configures OpenID Connect credentials, offline.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const lines = await describeCalendarToolset(ctx);

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
