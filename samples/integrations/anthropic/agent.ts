/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Anthropic API (`AnthropicLlm`)
 * ../../../docs/guides/integrations/models/anthropic_llm/index.md
 *
 * An `LlmAgent` backed by `AnthropicLlm` from `@google/adk-integrations` using
 * the direct Anthropic Messages API (`claude-sonnet-5-5`), equipped with a
 * `FunctionTool` (`estimate_shipping`) that takes a nested Zod object parameter
 * and returns a structured object result.
 *
 * Prerequisites:
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY="your-anthropic-api-key"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/anthropic/agent.ts
 * Try "Estimate express shipping for a 2.5 kg package to Tokyo, Japan (100-0001)."
 */

import {FunctionTool, LlmAgent} from '@google/adk';
import {AnthropicLlm} from '@google/adk-integrations';
import {z} from 'zod';

const estimateShippingParameters = z.object({
  destination: z
    .object({
      city: z.string().describe('Destination city name.'),
      country: z.string().describe('Destination country name.'),
      postalCode: z.string().optional().describe('Destination postal code.'),
    })
    .describe('Recipient destination address.'),
  packageDetails: z
    .object({
      weightKg: z.number().describe('Package weight in kilograms.'),
      serviceTier: z
        .enum(['standard', 'express'])
        .describe('Requested delivery speed.'),
    })
    .describe('Package weight and delivery tier.'),
});

export const estimateShippingTool = new FunctionTool({
  name: 'estimate_shipping',
  description:
    'Estimates shipping cost and transit days for a destination and package.',
  parameters: estimateShippingParameters,
  execute: async ({destination, packageDetails}) => {
    const baseRateUsd = packageDetails.serviceTier === 'express' ? 28 : 12;
    const weightSurchargeUsd =
      Math.round(packageDetails.weightKg * 4.5 * 100) / 100;
    const estimatedDays = packageDetails.serviceTier === 'express' ? 2 : 6;

    return {
      destination: `${destination.city}, ${destination.country}`,
      postalCode: destination.postalCode ?? 'unspecified',
      serviceTier: packageDetails.serviceTier,
      weightKg: packageDetails.weightKg,
      totalUsd: baseRateUsd + weightSurchargeUsd,
      currency: 'USD',
      estimatedTransitDays: estimatedDays,
    };
  },
});

export const rootAgent = new LlmAgent({
  name: 'anthropic_shipping_assistant',
  model: new AnthropicLlm({
    model: process.env['ADK_SAMPLE_ANTHROPIC_MODEL'] ?? 'claude-sonnet-5-5',
  }),
  description:
    'Answers shipping quote questions using Claude via the Anthropic API and a structured tool.',
  instruction:
    'You are a shipping assistant. Always call estimate_shipping when asked ' +
    'for a shipping quote or transit estimate, then summarize the returned ' +
    'breakdown clearly.',
  tools: [estimateShippingTool],
});
