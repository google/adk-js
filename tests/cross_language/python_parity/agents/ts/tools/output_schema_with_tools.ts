/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/tools/output_schema_with_tools.
 *
 * Sample agent demonstrating output_schema with tools feature.
 *
 * This agent shows how to use structured output (output_schema) alongside
 * other tools. Previously, this combination was not allowed, but now it's
 * supported through a workaround that uses a special set_model_response tool.
 *
 * Both runtimes gate that workaround on the same predicate: on Vertex AI with
 * a Gemini 2+ model they set a native response schema instead
 * (core/src/utils/output_schema_utils.ts), and only otherwise inject
 * `set_model_response` (core/src/agents/llm_agent.ts:1487).
 */
import {FunctionTool, GOOGLE_SEARCH, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

/** Structured information about a person. */
const PersonInfo = z.object({
  name: z.string().describe("The person's full name"),
  age: z.number().int().describe("The person's age in years"),
  occupation: z.string().describe("The person's job or profession"),
  location: z.string().describe('The city and country where they live'),
  biography: z.string().describe('A brief biography of the person'),
});

const searchWikipedia = new FunctionTool({
  name: 'search_wikipedia',
  description: 'Search Wikipedia for information about a topic.',
  parameters: z.object({
    query: z.string().describe('The search query to look up on Wikipedia'),
  }),
  execute: async ({query}) => {
    try {
      // Use Wikipedia API to search for the article
      const searchUrl =
        'https://en.wikipedia.org/api/rest_v1/page/summary/' +
        query.split(' ').join('_');
      const response = await fetch(searchUrl, {
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 200) {
        const data = (await response.json()) as {
          title?: string;
          extract?: string;
        };
        return (
          `Title: ${data.title ?? 'N/A'}\n\nSummary:` +
          ` ${data.extract ?? 'No summary available'}`
        );
      }
      return (
        `Wikipedia article not found for '${query}'. Status code:` +
        ` ${response.status}`
      );
    } catch (error) {
      return `Error searching Wikipedia: ${String(error)}`;
    }
  },
});

const getCurrentYear = new FunctionTool({
  name: 'get_current_year',
  description: 'Get the current year.',
  execute: () => String(new Date().getFullYear()),
});

// Create the knowledge agent that uses google_search tool.
const knowledgeAgent = new LlmAgent({
  name: 'knowledge_agent',
  model: PARITY_MODEL,
  instruction: `
You are a helpful assistant that gathers information about famous people.
Use google_search tool to find information about them.
Provide the output into a structured response using the PersonInfo format.
`,
  description: `
A knowledge agent that gathers information about famous people.
`,
  tools: [GOOGLE_SEARCH],
  outputSchema: PersonInfo,
});

// Create the agent with both output_schema and tools
export const rootAgent = new LlmAgent({
  name: 'person_info_agent',
  model: PARITY_MODEL,
  instruction: `You are a helpful assistant that gathers information about famous people.

When asked about a person, you should:
1. Use the knowledge_agent to find information about politicians
2. Use the search_wikipedia tool to find information about other people
3. Use the get_current_year tool if you need to calculate ages
4. Compile the information into a structured response using the PersonInfo format`,
  outputSchema: PersonInfo,
  tools: [searchWikipedia, getCurrentYear],
  subAgents: [knowledgeAgent],
});
