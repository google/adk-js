/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/patterns/json_passing_agent.
 *
 * Ported as literally as the two APIs allow: same tool names, same agent
 * names, same instruction text, same prices. Divergence in the transcript
 * should come from the runtimes, not from the agent definition.
 *
 * The pattern under test is JSON hand-off through session state: the intake
 * agent's `outputSchema` result is written to `pizza_order` by `outputKey`,
 * and the confirmation agent reads it back both from `{pizza_order}` in its
 * instruction and from `toolContext.state` inside `calculate_price`. Both
 * runtimes store the *parsed object* under `outputKey` when an output schema
 * is set, so the state shape is directly comparable.
 */
import {FunctionTool, LlmAgent, SequentialAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

// 1. Define the data structure for the pizza order.
/** A data class to hold the details of a pizza order. */
const PizzaOrder = z.object({
  size: z.string(),
  crust: z.string(),
  toppings: z.array(z.string()),
});

// 2. Define tools for the order intake agent.
const getAvailableSizes = new FunctionTool({
  name: 'get_available_sizes',
  description: 'Returns the available pizza sizes.',
  execute: () => ['small', 'medium', 'large'],
});

const getAvailableCrusts = new FunctionTool({
  name: 'get_available_crusts',
  description: 'Returns the available pizza crusts.',
  execute: () => ['thin', 'thick', 'stuffed'],
});

const getAvailableToppings = new FunctionTool({
  name: 'get_available_toppings',
  description: 'Returns the available pizza toppings.',
  execute: () => [
    'pepperoni',
    'mushrooms',
    'onions',
    'sausage',
    'bacon',
    'pineapple',
  ],
});

// 3. Define the order intake agent.
// This agent's job is to interact with the user to fill out a PizzaOrder
// object. It uses the outputSchema to structure its response as a JSON object
// that conforms to the PizzaOrder model.
const orderIntakeAgent = new LlmAgent({
  name: 'order_intake_agent',
  model: PARITY_MODEL,
  instruction:
    "You are a pizza order intake agent. Your goal is to get the user's" +
    ' pizza order. Use the available tools to find out what sizes, crusts,' +
    ' and toppings are available. Once you have all the information,' +
    ' provide it in the requested format. Your output MUST be a JSON object' +
    ' that conforms to the PizzaOrder schema and nothing else.',
  outputKey: 'pizza_order',
  outputSchema: PizzaOrder,
  tools: [getAvailableSizes, getAvailableCrusts, getAvailableToppings],
});

// 4. Define a tool for the order confirmation agent.
const calculatePrice = new FunctionTool({
  name: 'calculate_price',
  description:
    'Calculates the price of a pizza order and returns a descriptive string.',
  execute: (_input, toolContext) => {
    const orderDict = toolContext?.state.get('pizza_order');
    if (!orderDict) {
      return "I can't find an order to calculate the price for.";
    }

    const order = PizzaOrder.parse(orderDict);

    let price = 0.0;
    if (order.size === 'small') {
      price += 8.0;
    } else if (order.size === 'medium') {
      price += 10.0;
    } else if (order.size === 'large') {
      price += 12.0;
    }

    if (order.crust === 'stuffed') {
      price += 2.0;
    }

    price += order.toppings.length * 1.5;
    return `The total price for your order is $${price.toFixed(2)}.`;
  },
});

// 5. Define the order confirmation agent.
// This agent reads the PizzaOrder object from the session state (placed there
// by the order_intake_agent) and confirms the order with the user.
const orderConfirmationAgent = new LlmAgent({
  name: 'order_confirmation_agent',
  model: PARITY_MODEL,
  instruction:
    'Confirm the pizza order with the user. The order is in the state' +
    ' variable `pizza_order`. First, use the `calculate_price` tool to get' +
    ' the price. Then, summarize the order details from {pizza_order} and' +
    ' include the price in your summary. For example: "You ordered a large' +
    ' thin crust pizza with pepperoni and mushrooms. The total price is' +
    ' $15.00."',
  tools: [calculatePrice],
});

// 6. Define the root agent as a sequential agent.
// This agent directs the conversation by running its sub-agents in order.
export const rootAgent = new SequentialAgent({
  name: 'pizza_ordering_agent',
  subAgents: [orderIntakeAgent, orderConfirmationAgent],
  description:
    'This agent is used to order pizza. It will ask the user for their' +
    ' pizza order and then confirm the order with the user.',
});
