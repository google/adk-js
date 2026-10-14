/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Confirm writes: a plugin that lets the model propose but not perform
 *
 * An agent that can both look things up and change them has one dangerous
 * property: the decision to act is made by the model, in the same breath as
 * the decision to read. Prompting will not fix that. "Ask before you add
 * anything" is a request, and a request is not a control.
 *
 * A plugin is. `beforeToolCallback` runs before every tool, and returning an
 * object from it means ADK treats that object as the tool's result and never
 * calls the tool. So the read-only tools run normally, and the write tools are
 * intercepted: the call is recorded as a proposal, and the agent is told it has
 * been prepared rather than performed. The agent's turn continues, so it can
 * describe what it set up.
 *
 * The application then shows the proposal and, if a human accepts, calls the
 * tool directly. Natural language decides what to propose. A person decides
 * whether it runs. Nothing about that depends on the model behaving.
 *
 * This is worth doing as a plugin rather than inside each tool. A tool that
 * guards itself is a tool someone can forget to write the guard into; the
 * plugin sees every tool the agent has, including ones added later.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/confirm_writes/agent.ts
 * Ask it to add something, e.g. "add two of the soft-close hinges to my cart".
 * The reply describes the change; `pendingProposals()` holds it, unexecuted.
 */

import type {BaseTool, Context} from '@google/adk';
import {App, BasePlugin, FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

/* ----------------------------- the store ----------------------------- */

interface Product {
  sku: string;
  name: string;
  price: number;
}

const CATALOG: Product[] = [
  {sku: 'HNG-204', name: 'Soft-close cabinet hinge', price: 6.5},
  {sku: 'DMP-118', name: 'Door damper, stops slamming', price: 14.0},
  {sku: 'SCR-330', name: 'Wood screws, 4x40mm, 100 pack', price: 8.25},
];

/** The cart the write tool would change. Nothing here is written by the model. */
const cart: Array<{sku: string; quantity: number}> = [];

/* ------------------------------ the plugin ---------------------------- */

/** A write the agent asked for and did not get to perform. */
export interface Proposal {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Intercepts the named tools and records them instead of running them.
 *
 * Anything not named here runs normally, so reads stay fast and unguarded.
 */
export class ConfirmWritesPlugin extends BasePlugin {
  private readonly proposals: Proposal[] = [];

  constructor(private readonly writeTools: ReadonlySet<string>) {
    super('confirm-writes');
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    // Returning undefined lets the tool run. Every read-only tool takes this
    // path.
    if (!this.writeTools.has(tool.name)) return undefined;

    const id = `p${this.proposals.length + 1}`;
    this.proposals.push({id, tool: tool.name, args: toolArgs});

    // Returning an object stands in for the tool's result: the tool itself is
    // never called. The agent reads this and continues its turn, so tell it
    // plainly what happened rather than returning something that reads like
    // success.
    return {
      status: 'awaiting_confirmation',
      proposalId: id,
      note: 'Prepared for the user to confirm. Not performed.',
    };
  }

  /** Removes and returns everything proposed so far. */
  take(): Proposal[] {
    return this.proposals.splice(0, this.proposals.length);
  }
}

/* ------------------------------- the tools ---------------------------- */

const searchCatalog = new FunctionTool({
  name: 'search_catalog',
  description:
    'Finds products by what they are for. Returns sku, name and price.',
  parameters: z.object({
    query: z.string().describe('What the shopper is trying to do or fix.'),
  }),
  execute: ({query}: {query: string}) => {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    const hits = CATALOG.filter((product) => {
      const haystack = `${product.name} ${product.sku}`.toLowerCase();
      return words.some((word) => word.length > 3 && haystack.includes(word));
    });
    return JSON.stringify(hits.length ? hits : CATALOG);
  },
});

const addToCart = new FunctionTool({
  name: 'add_to_cart',
  description: 'Adds a product to the cart. Use the sku from a search result.',
  parameters: z.object({
    sku: z.string().describe('The sku, exactly as the search returned it.'),
    quantity: z.number().describe('How many to add.'),
  }),
  // This body never runs while the plugin is installed. The application calls
  // it directly, with the same arguments, once a human has accepted.
  execute: ({sku, quantity}: {sku: string; quantity: number}) => {
    cart.push({sku, quantity});
    return JSON.stringify({added: sku, quantity, cartSize: cart.length});
  },
});

/* ------------------------------ the agent ----------------------------- */

const plugin = new ConfirmWritesPlugin(new Set(['add_to_cart']));

/** The writes the agent has proposed and not performed. */
export function pendingProposals(): Proposal[] {
  return plugin.take();
}

export const rootAgent = new LlmAgent({
  name: 'store_assistant',
  model: 'gemini-flash-latest',
  description: 'Helps a shopper find hardware and prepare a cart.',
  instruction: [
    'You help a shopper in a hardware store.',
    'Search the catalog before naming any product, price or sku.',
    'To add something, call add_to_cart with a sku the search returned.',
    'If a tool says a change is awaiting confirmation, tell the shopper what',
    'you have prepared and that they need to confirm it. Do not claim it is',
    'done, and do not call the tool again.',
    'Keep answers to two or three sentences.',
  ].join('\n'),
  tools: [searchCatalog, addToCart],
});

/**
 * A plugin belongs to the application, not the agent, so the sample exports an
 * `App`. The CLI prefers an exported app over a bare `rootAgent`; exporting
 * only the agent here would load it without the plugin, and the write tool
 * would run for real.
 */
export const app = new App({
  name: 'confirm_writes',
  rootAgent,
  plugins: [plugin],
});
