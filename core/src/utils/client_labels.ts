/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '../version.js';

import {isBrowser} from './env_aware_utils.js';

const ADK_LABEL = 'google-adk';
const LANGUAGE_LABEL = 'gl-typescript';
const AGENT_ENGINE_TELEMETRY_TAG = 'remote_reasoning_engine';
const AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

// TODO: b/468053794 - Configurable client labels in AsyncLocalStorage and/or
// browser equivalent

function _getDefaultLabels(): string[] {
  let frameworkLabel = `${ADK_LABEL}/${version}`;

  if (!isBrowser() && process.env[AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME]) {
    frameworkLabel = `${frameworkLabel}+${AGENT_ENGINE_TELEMETRY_TAG}`;
  }

  // TODO: b/468051563 - Consider extracting browser name and version from
  // userAgent string
  const languageLabel = `${LANGUAGE_LABEL}/${
      isBrowser() ? window.navigator.userAgent : process.version}`;
  return [frameworkLabel, languageLabel];
}

/**
 * Returns the current list of client labels that can be added to HTTP Headers.
 */
export function getClientLabels(): string[] {
  const labels = _getDefaultLabels();
  // TODO: b/468053794 - Configurable client labels in AsyncLocalStorage and/or
  // browser equivalent
  return labels;
}
