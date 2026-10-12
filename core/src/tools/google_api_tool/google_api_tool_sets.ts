/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createLazyGoogleApiToolSet} from './google_api_tool_set.js';

/**
 * Pre-configured {@link GoogleApiToolSet} for the Google Calendar v3 API.
 */
export const calendarToolSet = createLazyGoogleApiToolSet('calendar', 'v3');

/**
 * Pre-configured {@link GoogleApiToolSet} for the Google BigQuery v2 API.
 */
export const bigqueryToolSet = createLazyGoogleApiToolSet('bigquery', 'v2');

/**
 * Pre-configured {@link GoogleApiToolSet} for the Gmail v1 API.
 */
export const gmailToolSet = createLazyGoogleApiToolSet('gmail', 'v1');

/**
 * Pre-configured {@link GoogleApiToolSet} for the YouTube Data v3 API.
 */
export const youtubeToolSet = createLazyGoogleApiToolSet('youtube', 'v3');

/**
 * Pre-configured {@link GoogleApiToolSet} for the Google Slides v1 API.
 */
export const slidesToolSet = createLazyGoogleApiToolSet('slides', 'v1');

/**
 * Pre-configured {@link GoogleApiToolSet} for the Google Sheets v4 API.
 */
export const sheetsToolSet = createLazyGoogleApiToolSet('sheets', 'v4');

/**
 * Pre-configured {@link GoogleApiToolSet} for the Google Docs v1 API.
 */
export const docsToolSet = createLazyGoogleApiToolSet('docs', 'v1');
