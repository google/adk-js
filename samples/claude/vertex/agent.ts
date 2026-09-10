/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude on Vertex AI
 *
 * The same models, served from Google Cloud Model Garden instead of Anthropic:
 * authentication and quota come from your Google Cloud project, so there is no
 * Anthropic API key. Note that Vertex spells the model version with an `@`
 * (`claude-sonnet-4-5@20250929`) where the Anthropic API uses a dash.
 *
 * A bare `claude-*` name is ambiguous between the two services and always
 * resolves to the Anthropic API, so the Vertex model is constructed explicitly.
 * Passing the full resource name instead — `projects/<p>/locations/<l>/
 * publishers/anthropic/models/<id>` — is unambiguous and works as a plain
 * string, project and region included.
 *
 * REQUIRES:
 *   - `npm install @anthropic-ai/vertex-sdk` (an optional peer dependency)
 *   - Application Default Credentials: `gcloud auth application-default login`
 *   - the model enabled in Model Garden for your project and region
 *
 *   export GOOGLE_CLOUD_PROJECT=my-project
 *   export GOOGLE_CLOUD_LOCATION=us-east5
 *   npm run sample -- samples/claude/vertex/agent.ts
 */

import {LlmAgent} from '@google/adk';
import {Claude} from '@google/adk-integrations';

export const rootAgent = new LlmAgent({
  name: 'claude_vertex_agent',
  model: new Claude({
    model: 'claude-sonnet-4-5@20250929',
    // Both default to GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.
    project: process.env['GOOGLE_CLOUD_PROJECT'],
    location: process.env['GOOGLE_CLOUD_LOCATION'] ?? 'us-east5',
  }),
  description: 'A Claude assistant served from Vertex AI Model Garden.',
  instruction:
    'You are a helpful assistant. Answer in at most three sentences.',
});
