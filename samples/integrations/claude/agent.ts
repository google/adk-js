/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude on Vertex AI (`Claude`)
 * ../../../docs/guides/integrations/models/anthropic_llm/index.md
 *
 * An `LlmAgent` backed by `Claude` from `@google/adk-integrations` on Vertex AI
 * (`claude-sonnet-4-6@default`), registered in `LLMRegistry` and equipped with
 * a `FunctionTool` (`estimate_shipping`) that takes a nested Zod object
 * parameter and returns a structured object result.
 *
 * Prerequisites:
 *   npm install @anthropic-ai/sdk @anthropic-ai/vertex-sdk
 *   gcloud auth application-default login
 *   export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
 *   export GOOGLE_CLOUD_LOCATION="global"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/claude/agent.ts
 * Try "Estimate express shipping for a 2.5 kg package to Tokyo, Japan (100-0001)."
 */

import {FunctionTool, LLMRegistry, LlmAgent} from '@google/adk';
import {Claude} from '@google/adk-integrations';
import {z} from 'zod';

LLMRegistry.register(Claude);

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
  name: 'claude_shipping_assistant',
  model: new Claude({
    model:
      process.env['ADK_SAMPLE_CLAUDE_MODEL'] ?? 'claude-sonnet-4-6@default',
  }),
  description:
    'Answers shipping quote questions using Claude on Vertex AI and a structured tool.',
  instruction:
    'You are a shipping assistant. Always call estimate_shipping when asked ' +
    'for a shipping quote or transit estimate, then summarize the returned ' +
    'breakdown clearly.',
  tools: [estimateShippingTool],
});
