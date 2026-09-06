/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/multi_agent/three_layer_transfer.
 *
 * root_agent -> writer_agent -> translator_agent, and back up again. The whole
 * point of the sample is which agent the model picks, so names, descriptions
 * and instructions are byte-for-byte the Python ones.
 */
import {LlmAgent} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

// --- Leaf Agent (Grandchild) ---
const translatorAgent = new LlmAgent({
  name: 'translator_agent',
  model: PARITY_MODEL,
  description: 'Translates text into different languages.',
  instruction: `
      You are a translator. Your job is to translate the text provided to you into the requested language.
      Once the translation is complete, output the translated text, explain what you did, and then transfer back to the writer_agent.
    `,
});

// --- Middle Agent (Child) ---
const writerAgent = new LlmAgent({
  name: 'writer_agent',
  model: PARITY_MODEL,
  description:
    'Writes stories, articles, or essays, and manages translation requests.',
  instruction: `
      You are a professional writer.
      When asked to write something, perform the writing task and present the result to the user.
      If the user asks to translate the written content into another language, transfer the task to the translator_agent.
      If the user is satisfied and wants to return to the main coordinator, transfer back to the root_agent.
    `,
  subAgents: [translatorAgent],
});

// --- Root Agent (Parent) ---
export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: PARITY_MODEL,
  description:
    'Project coordinator that delegates writing and translation tasks.',
  instruction: `
      You are a project coordinator.
      If the user wants to write a story, essay, or article, transfer the task to the writer_agent.
      Answer general inquiries yourself, but delegate writing-related tasks.
    `,
  subAgents: [writerAgent],
});
