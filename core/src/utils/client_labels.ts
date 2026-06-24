/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { version } from '../version.js';
import { isBrowser } from './env_aware_utils.js';

const ADK_LABEL = 'google-adk';
const LANGUAGE_LABEL = 'gl-typescript';
const AGENT_ENGINE_TELEMETRY_TAG = 'remote_reasoning_engine';
const AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

export const EVAL_CLIENT_LABEL = `google-adk-eval/${version}`;

const clientLabelLocalStorage = new AsyncLocalStorage<string>();

export function parseUserAgent(userAgent: string): string {
  if (!userAgent) {
    return 'Browser';
  }

  // Edge
  const edgeMatch = userAgent.match(/(?:Edg|Edge|EdgA)\/([0-9\.]+)/i);
  if (edgeMatch) {
    return `Edge/${edgeMatch[1]}`;
  }

  // Firefox
  const firefoxMatch = userAgent.match(/(?:Firefox|FxiOS)\/([0-9\.]+)/i);
  if (firefoxMatch) {
    return `Firefox/${firefoxMatch[1]}`;
  }

  // Chrome
  const chromeMatch = userAgent.match(/(?:Chrome|CriOS)\/([0-9\.]+)/i);
  if (chromeMatch) {
    return `Chrome/${chromeMatch[1]}`;
  }

  // Safari
  const safariMatch = userAgent.match(/Version\/([0-9\.]+).*Safari/i);
  if (safariMatch) {
    return `Safari/${safariMatch[1]}`;
  }

  return 'Browser';
}

function _getDefaultLabels(): string[] {
  let frameworkLabel = `${ADK_LABEL}/${version}`;

  if (!isBrowser() && process.env[AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME]) {
    frameworkLabel = `${frameworkLabel}+${AGENT_ENGINE_TELEMETRY_TAG}`;
  }

  let languageLabelDetail: string;
  if (isBrowser()) {
    // eslint-disable-next-line no-undef
    languageLabelDetail = parseUserAgent(window.navigator.userAgent);
  } else {
    languageLabelDetail = process.version;
  }

  const languageLabel = `${LANGUAGE_LABEL}/${languageLabelDetail}`;
  return [frameworkLabel, languageLabel];
}

export function runWithClientLabel<R>(clientLabel: string, callback: () => R): R {
  if (typeof clientLabel !== 'string' || clientLabel.trim() === '') {
    throw new Error('Client label must be a non-empty string.');
  }

  const existingLabel = clientLabelLocalStorage.getStore();
  if (existingLabel) {
    throw new Error('Client label already exists. You can only add one client label.');
  }

  return clientLabelLocalStorage.run(clientLabel, callback);
}

/**
 * Returns the current list of client labels that can be added to HTTP Headers.
 */
export function getClientLabels(): string[] {
  const labels = _getDefaultLabels();
  const contextLabel = clientLabelLocalStorage.getStore();
  if (contextLabel) {
    labels.push(contextLabel);
  }
  return labels;
}
