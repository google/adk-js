/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Request input with a message and payload
 * https://adk.dev/graphs/human-input/#request-input-with-a-message-and-payload
 *
 * `RequestInput` takes three configuration options:
 *   message         text shown to the user explaining what is being asked
 *   payload         structured data sent alongside the prompt, so a client can
 *                   render richer context (here, the full itinerary)
 *   responseSchema  the shape the reply is expected to take
 *
 * Note on `responseSchema`: `RequestInput` does NOT reformat a human reply to
 * fit the schema — the reply must already be in that shape. For a good UX,
 * either collect structured data in your UI, or put an agent node after the
 * pause to normalize whatever the human typed.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/human_input/payload_and_schema/agent.ts
 * Turn 1: a city, e.g. "Lisbon". Turn 2: say which activities appeal to you.
 */

import {node, NodeContext, RequestInput, Workflow} from '@google/adk';
import {z} from 'zod';

/**
 * Itinerary is a list of activities. Each activity has a name and a
 * description.
 */
const activitiesListSchema = z.object({
  itinerary: z.array(z.object({name: z.string(), description: z.string()})),
});
type ActivitiesList = z.infer<typeof activitiesListSchema>;

/** Expected response structure from the user. */
const userFeedbackSchema = z.object({
  userResponse: z.string(),
});

// Stands in for the agent node that composes the base itinerary.
const buildItinerary = node(
  (_ctx: NodeContext, city: string): ActivitiesList => {
    const place = city.trim() || 'your city';
    return {
      itinerary: [
        {name: 'Morning walk', description: `A stroll through old ${place}.`},
        {name: 'Local lunch', description: `Regional food in ${place}.`},
        {name: 'Museum visit', description: `The main museum of ${place}.`},
      ],
    };
  },
  {name: 'build_itinerary', outputSchema: activitiesListSchema},
);

/**
 * Retrieves the user's thoughts on the agent's initial itinerary in order to
 * either expand on it, change the list, or exit the loop.
 */
const getUserFeedback = node(
  async function* (_ctx: NodeContext, nodeInput: ActivitiesList) {
    const rendered = nodeInput.itinerary
      .map((a, i) => `  ${i + 1}. ${a.name} — ${a.description}`)
      .join('\n');

    yield new RequestInput({
      message:
        `Here is your recommended base itinerary:\n${rendered}\n\n` +
        'Which of these items appeal to you (if any)?',
      payload: nodeInput,
      responseSchema: userFeedbackSchema,
    });
  },
  {name: 'get_user_feedback'},
);

// Receives the human's reply as its input (default handoff on resume).
const applyFeedback = node(
  (_ctx: NodeContext, nodeInput: unknown) => {
    // The reply is either the structured `UserFeedback` shape or, from an
    // interactive client, plain text.
    const feedback =
      typeof nodeInput === 'string'
        ? nodeInput
        : String(
            (nodeInput as {userResponse?: unknown} | null)?.userResponse ??
              JSON.stringify(nodeInput),
          );
    return `Noted. Building the final itinerary around: ${feedback}`;
  },
  {name: 'apply_feedback'},
);

export const rootAgent = new Workflow({
  name: 'concierge_workflow',
  edges: [['START', buildItinerary, getUserFeedback, applyFeedback]],
});
