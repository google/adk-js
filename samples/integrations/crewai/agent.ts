/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CrewAI Tool (`CrewaiTool`)
 * ../../../docs/guides/integrations/crewai/index.md
 *
 * An `LlmAgent` equipped with `CrewaiTool` adapters from
 * `@google/adk-integrations`, demonstrating a Zod-typed `argsSchema` tool with
 * space-separated name normalization and a `toJsonSchema()` tool with custom
 * name and description overrides.
 *
 * Prerequisites:
 *   export GEMINI_API_KEY="your-gemini-api-key"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/crewai/agent.ts
 * Try "Search the catalog for streaming guides and look up the runner glossary entry."
 */

import {LlmAgent} from '@google/adk';
import {CrewaiTool} from '@google/adk-integrations';
import {z} from 'zod';

interface CatalogArticle {
  readonly title: string;
  readonly category: string;
  readonly summary: string;
}

const CATALOG_ARTICLES: readonly CatalogArticle[] = [
  {
    title: 'Live Streaming Tools',
    category: 'tools',
    summary: 'Stream incremental tool updates over bidirectional queues.',
  },
  {
    title: 'Multi-Agent Delegation',
    category: 'agents',
    summary: 'Coordinate specialist child agents through AgentTool.',
  },
  {
    title: 'Session State Scopes',
    category: 'sessions',
    summary: 'Persist application, user, and invocation state values.',
  },
];

export const searchCatalogTool = new CrewaiTool({
  tool: {
    name: 'Search Documentation Catalog',
    description:
      'Searches documentation catalog entries by keyword and optional limit.',
    argsSchema: z.object({
      searchQuery: z
        .string()
        .describe('Keyword to match against article titles and summaries.'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Maximum number of matching articles to return.'),
    }),
    run: async ({
      searchQuery,
      maxResults,
    }: {
      searchQuery: string;
      maxResults?: number;
    }) => {
      const needle = searchQuery.trim().toLowerCase();
      const matches = CATALOG_ARTICLES.filter(
        (article) =>
          article.title.toLowerCase().includes(needle) ||
          article.category.toLowerCase().includes(needle) ||
          article.summary.toLowerCase().includes(needle),
      );
      return {
        searchQuery,
        results: matches.slice(0, maxResults ?? 5),
      };
    },
  },
});

const GLOSSARY_ENTRIES: Readonly<Record<string, string>> = {
  runner:
    'Executes an agent against a session service and yields structured events.',
  toolset:
    'Dynamically supplies a filtered collection of tools for an agent turn.',
  artifact:
    'Stores versioned binary or text payloads scoped to a session or user.',
};

export const lookupGlossaryTool = new CrewaiTool(
  {
    name: 'rawGlossaryTool',
    description: 'Raw glossary description replaced by constructor options.',
    argsSchema: {
      toJsonSchema: () => ({
        type: 'object',
        properties: {
          termKey: {
            type: 'string',
            description: 'Glossary term such as runner, toolset, or artifact.',
          },
        },
        required: ['termKey'],
      }),
    },
    run: ({termKey}: {termKey: string}) => {
      const normalized = termKey.trim().toLowerCase();
      return {
        termKey: normalized,
        definition:
          GLOSSARY_ENTRIES[normalized] ??
          `No glossary definition found for "${termKey}". Available terms: ${Object.keys(GLOSSARY_ENTRIES).join(', ')}.`,
      };
    },
  },
  {
    name: 'lookupGlossaryTerm',
    description:
      'Looks up concise definitions for core terms such as runner, toolset, or artifact.',
  },
);

export const rootAgent = new LlmAgent({
  name: 'crewaiToolsAssistant',
  model: 'gemini-flash-latest',
  description:
    'Answers documentation catalog and glossary questions using CrewAI-compatible tools.',
  instruction:
    'You are a helpful documentation assistant. Use available catalog search ' +
    'and glossary lookup tools to answer user questions accurately.',
  tools: [searchCatalogTool, lookupGlossaryTool],
});
