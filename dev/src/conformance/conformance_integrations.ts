/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  Context,
  FunctionTool,
  LongRunningFunctionTool,
  SingleAgentCallback,
} from '@google/adk';
import {Content} from '@google/genai';
import {z} from 'zod';
import {IntegrationRegistry} from '../integration/integration_registry.js';

export function registerConformanceIntegrations(registry: IntegrationRegistry) {
  // Plugins
  const plugins: BasePlugin[] = [];
  for (const plugin of plugins) {
    registry.registerPlugin(plugin.name, plugin);
  }

  // Callbacks
  const beforeAgentCallbacks: {name: string; callback: SingleAgentCallback}[] =
    [
      {
        name: 'callback_agent_002.callbacks.shortcut_agent_execution',
        callback: shortcutAgentExecution,
      },
      {
        name: 'callback_agent_001.callbacks.before_agent_callback1',
        callback: beforeAgentCallback1,
      },
      {
        name: 'callback_agent_001.callbacks.before_agent_callback2',
        callback: beforeAgentCallback2,
      },
    ];
  for (const {name, callback} of beforeAgentCallbacks) {
    registry.registerBeforeAgentCallback(name, callback);
  }

  const afterAgentCallbacks: {name: string; callback: SingleAgentCallback}[] = [
    {
      name: 'callback_agent_003.callbacks.after_agent_callback1',
      callback: afterAgentCallback1,
    },
    {
      name: 'callback_agent_003.callbacks.after_agent_callback2',
      callback: afterAgentCallback2,
    },
  ];
  for (const {name, callback} of afterAgentCallbacks) {
    registry.registerAfterAgentCallback(name, callback);
  }

  // Tools
  const tools: {name: string; tool: FunctionTool}[] = [
    {name: 'tools_agent_009.tools.reimburse', tool: reimburse},
    {name: 'tools_agent_009.tools.ask_for_approval', tool: askForApproval},
    {name: 'tools_agent_004.tools.search_flights', tool: searchFlights},
    {
      name: 'tools_agent_004.tools.calculate_trip_cost',
      tool: calculateTripCost,
    },
    {name: 'tools_agent_002.tools.validate_email', tool: validateEmail},
    {name: 'tools_agent_002.tools.get_user_id', tool: getUserId},
    {name: 'tools_agent_002.tools.create_booking', tool: createBooking},
  ];
  for (const {name, tool} of tools) {
    registry.registerTool(name, tool);
  }
}

/**
 * Plugins
 */

// none yet

/**
 * Callbacks
 */

export function shortcutAgentExecution(
  callbackContext: Context,
): Content | undefined {
  if (callbackContext.state.get('conversationLimitReached') === 'True') {
    return {
      role: 'model',
      parts: [{text: 'Sorry, you have reached the limit of the conversation.'}],
    };
  } else {
    callbackContext.state.set('conversationLimitReached', 'True');
    return undefined;
  }
}

export async function beforeAgentCallback1(
  callbackContext: Context,
): Promise<Content | undefined> {
  callbackContext.state.set('beforeAgentCallbackStateKey', 'value1');
  return undefined;
}

export async function beforeAgentCallback2(
  callbackContext: Context,
): Promise<Content | undefined> {
  const current = callbackContext.state.get('beforeAgentCallbackStateKey');
  callbackContext.state.set('beforeAgentCallbackStateKey', current + '+value2');
  return undefined;
}

export async function afterAgentCallback1(
  callbackContext: Context,
): Promise<Content | undefined> {
  callbackContext.state.set('afterAgentCallbackStateKey', 'value1');
  return undefined;
}

export async function afterAgentCallback2(
  callbackContext: Context,
): Promise<Content | undefined> {
  const current = callbackContext.state.get('afterAgentCallbackStateKey');
  callbackContext.state.set('afterAgentCallbackStateKey', current + '+value2');
  return undefined;
}

/**
 * Tools
 */

export const reimburse = new FunctionTool({
  name: 'reimburse',
  description: 'Reimburse the amount of money to the employee.',
  parameters: z.object({
    purpose: z.string(),
    amount: z.number(),
  }),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  execute: ({purpose, amount}) => {
    return {
      status: 'ok',
    };
  },
});

export const askForApproval = new LongRunningFunctionTool({
  name: 'ask_for_approval',
  description: 'Ask for approval for the reimbursement.',
  parameters: z.object({
    purpose: z.string(),
    amount: z.number(),
  }),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  execute: ({purpose, amount}, context) => {
    return {
      status: 'pending',
      amount: amount,
      ticketId: 'reimbursement-ticket-001',
    };
  },
});

export interface TripDetails {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string | null | undefined;
}

export interface FlightPreferences {
  cabinClass: string;
  maxStops: number;
  preferredAirline?: string | null | undefined;
  flexibleDates: boolean;
}

export const searchFlights = new FunctionTool({
  name: 'search_flights',
  description: 'Search for flights based on trip details and preferences.',
  parameters: z.object({
    trip: z
      .object({
        origin: z.string().describe('Departure city or airport code'),
        destination: z.string().describe('Arrival city or airport code'),
        departureDate: z
          .string()
          .describe('Departure date in YYYY-MM-DD format'),
        returnDate: z
          .string()
          .optional()
          .nullable()
          .describe(
            'Return date in YYYY-MM-DD format, or None for one-way trip',
          ),
      })
      .describe('Core trip information'),
    preferences: z
      .object({
        cabinClass: z
          .string()
          .default('economy')
          .describe(
            'Preferred cabin class: economy, premium_economy, business, or first',
          ),
        maxStops: z
          .number()
          .default(1)
          .describe(
            'Maximum number of stops allowed (0 for direct flights only)',
          ),
        preferredAirline: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Preferred airline code (e.g., 'UA', 'AA'), or None for any airline",
          ),
        flexibleDates: z
          .boolean()
          .default(false)
          .describe('Whether to search nearby dates for better prices'),
      })
      .optional()
      .describe('Optional flight preferences. If not provided, uses defaults.'),
  }),
  execute: (input: {
    trip: TripDetails;
    preferences?: FlightPreferences | undefined;
  }) => {
    const trip = input.trip;
    const preferences = input.preferences;

    const prefs = preferences ? preferences : ({} as FlightPreferences);
    const cabinClass = prefs.cabinClass ?? 'economy';
    const maxStops = prefs.maxStops ?? 1;
    const preferredAirline = prefs.preferredAirline ?? null;
    const flexibleDates = prefs.flexibleDates ?? false;

    const tripType = input.trip.returnDate ? 'round-trip' : 'one-way';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {
      trip_type: tripType,
      route: `${trip.origin} to ${trip.destination}`,
      departure_date: trip.departureDate,
      return_date: trip.returnDate,
      cabin_class: cabinClass,
      max_stops: maxStops,
      preferred_airline: preferredAirline,
      flexible_dates: flexibleDates,
      search_status: 'completed',
    };

    const airline = preferredAirline || 'Various Airlines';
    const stopsDesc = maxStops === 0 ? 'direct' : `up to ${maxStops} stops`;

    result['available_flights'] = [
      `${airline} - ${tripType} ${cabinClass} flight with ${stopsDesc}`,
      `Departure: ${trip.departureDate}`,
    ];

    if (trip.returnDate) {
      result['available_flights'].push(`Return: ${trip.returnDate}`);
    }

    return result;
  },
});

function validateEmailLogic(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

export const calculateTripCost = new FunctionTool({
  name: 'calculate_trip_cost',
  description: 'Calculate total trip cost with various optional charges.',
  parameters: z.object({
    baseFare: z.number().describe('Base ticket price per passenger.'),
    numPassengers: z
      .number()
      .default(1)
      .describe('Number of passengers (default: 1).'),
    insurance: z
      .boolean()
      .default(false)
      .describe('Whether to add travel insurance (default: False).'),
    baggageCount: z
      .number()
      .optional()
      .nullable()
      .describe(
        'Number of checked bags per passenger, or None for carry-on only.',
      ),
  }),
  execute: ({baseFare, numPassengers, insurance, baggageCount}) => {
    const subtotal = baseFare * numPassengers;
    const insuranceCost = insurance ? subtotal * 0.1 : 0.0;

    let baggageCost = 0.0;
    if (baggageCount && baggageCount !== null && baggageCount > 0) {
      const chargeableBags = Math.max(0, baggageCount - 1);
      baggageCost = chargeableBags * 35 * numPassengers;
    }

    const total = subtotal + insuranceCost + baggageCost;

    return {
      base_fare: baseFare,
      num_passengers: numPassengers,
      subtotal: subtotal,
      insurance_included: insurance,
      insurance_cost: insuranceCost,
      baggage_count: baggageCount,
      baggage_cost: baggageCost,
      total_cost: total,
    };
  },
});

export const validateEmail = new FunctionTool({
  name: 'validate_email',
  description: 'Checks if the provided string is a valid email format.',
  parameters: z.object({
    email: z.string(),
  }),
  execute: ({email}) => {
    return validateEmailLogic(email);
  },
});

export const getUserId = new FunctionTool({
  name: 'get_user_id',
  description: 'Retrieves a user ID based on their email.',
  parameters: z.object({
    email: z.string(),
  }),
  execute: ({email}) => {
    if (!validateEmailLogic(email)) {
      throw new Error('Invalid email format provided.');
    }

    let hash = 0;
    for (let i = 0; i < email.length; i++) {
      const char = email.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash) % 10000;
  },
});

export const createBooking = new FunctionTool({
  name: 'create_booking',
  description: 'Creates a booking for a user.',
  parameters: z.object({
    userId: z.number().describe('The unique identifier for the user.'),
    isConfirmed: z.boolean().describe('Whether the booking is confirmed.'),
    details: z.string().describe('Any additional details for the booking.'),
  }),
  execute: ({userId, isConfirmed, details}) => {
    return {
      user_id: userId,
      is_confirmed: isConfirmed,
      details: details,
      user_id_type: `<class '${
        typeof userId === 'number' ? 'int' : typeof userId
      }'>`,
      is_confirmed_type: `<class '${
        typeof isConfirmed === 'boolean' ? 'bool' : typeof isConfirmed
      }'>`,
      details_type: `<class '${
        typeof details === 'string' ? 'str' : typeof details
      }'>`,
    };
  },
});
