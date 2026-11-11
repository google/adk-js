/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A human-input node as the FIRST step of a workflow
 * https://adk.dev/graphs/human-input/#tool-confirmation-approval-prompts-in-llm-agents
 *
 * Instead of guessing what the user wants, the graph opens by asking, pauses,
 * and then routes the reply into the rest of the process.
 *
 * `responseSchema: z.string()` asks for a plain text reply. Nothing coerces the
 * human's answer into that shape; the schema tells a client what to collect.
 *
 * (The same docs section also covers tool-confirmation, an LlmAgent-level
 * mechanism rather than a graph node: set `requireConfirmation: true` on a
 * `FunctionTool` and the agent pauses for approval before that tool runs.)
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/human_input/initial_prompt/agent.ts
 * Turn 1: anything. Turn 2: e.g. "Lisbon, 34, cycling, liked the tram tour".
 */

import {node, NodeContext, RequestInput, Workflow} from '@google/adk';
import {z} from 'zod';

/** Asks the user for itinerary information. */
const initialPrompt = node(
  async function* () {
    const inputMessage = `
        This is an interactive concierge workflow tasked with making you a great
        itinerary for you in your city of choice. If you give some details about
        yourself or what you are generally looking for I can better personalize
        your itinerary.
        For example, input your:
            City (Required),
            Age,
            Hobby,
            Example of attraction you liked
    `;
    yield new RequestInput({
      message: inputMessage,
      responseSchema: z.string(),
    });
  },
  {name: 'initial_prompt'},
);

// Receives the user's reply as its input and kicks off the real work.
const buildItinerary = node(
  (_ctx: NodeContext, nodeInput: string) => {
    const [city = 'your city'] = nodeInput.split(',');
    return (
      `Personalized itinerary for ${city.trim()}:\n` +
      '  1. Morning walk through the old town\n' +
      '  2. Lunch at a neighbourhood favourite\n' +
      '  3. An afternoon activity matched to your hobby\n\n' +
      `(based on: ${nodeInput.trim()})`
    );
  },
  {name: 'build_itinerary'},
);

export const rootAgent = new Workflow({
  name: 'concierge_workflow',
  edges: [['START', initialPrompt, buildItinerary]],
});
