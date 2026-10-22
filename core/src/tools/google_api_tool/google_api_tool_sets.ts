/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {
  createLazyGoogleApiToolSet,
  GoogleApiToolset,
  type GoogleApiToolsetOptions,
} from './google_api_tool_set.js';

/**
 * Toolset for the Google BigQuery v2 API.
 */
@experimental
export class BigQueryToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetOptions = {}) {
    super({...options, apiName: 'bigquery', apiVersion: 'v2'});
  }
}

/**
 * Toolset for the Google Calendar v3 API.
 */
@experimental
export class CalendarToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetOptions = {}) {
    super({...options, apiName: 'calendar', apiVersion: 'v3'});
  }
}

/**
 * Toolset for the Gmail v1 API.
 */
@experimental
export class GmailToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetOptions = {}) {
    super({...options, apiName: 'gmail', apiVersion: 'v1'});
  }
}

/**
 * Toolset for the YouTube Data v3 API.
 */
@experimental
export class YoutubeToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetOptions = {}) {
    super({...options, apiName: 'youtube', apiVersion: 'v3'});
  }
}

/**
 * Toolset for the Google Slides v1 API.
 */
@experimental
export class SlidesToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetOptions = {}) {
    super({...options, apiName: 'slides', apiVersion: 'v1'});
  }
}

/**
 * Toolset for the Google Sheets v4 API.
 */
@experimental
export class SheetsToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetOptions = {}) {
    super({...options, apiName: 'sheets', apiVersion: 'v4'});
  }
}

/**
 * Toolset for the Google Docs v1 API.
 */
@experimental
export class DocsToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetOptions = {}) {
    super({...options, apiName: 'docs', apiVersion: 'v1'});
  }
}

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
