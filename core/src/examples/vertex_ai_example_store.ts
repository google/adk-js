/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  VertexAiExampleStore,
  VertexAiExampleStoreApiClient,
} from './example.js';
export type {
  ExampleStoreApiClient,
  SearchExamplesRequest,
  SearchExamplesResponse,
  SearchExamplesResult,
  StoredContentsExample,
  VertexAiExampleStoreApiClientOptions,
} from './example.js';
export {
  _getLatestMessageFromUser,
  buildExampleSi,
  convertExamplesToText,
  getLatestMessageFromUser,
  validateExamples,
} from './example_util.js';
