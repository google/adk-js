/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../auth/auth_credential.js';

/**
 * Applies the given credential to the request headers and URL.
 *
 * An HTTP credential that carries no usable token throws, so the caller never
 * sends an unauthenticated request in place of an authenticated one.
 *
 * @param url The target URL.
 * @param headers The request headers.
 * @param credential The auth credential.
 * @param authScheme The auth scheme from OpenAPI spec.
 * @returns The updated URL (if modified by query params).
 * @throws {Error} If an HTTP credential holds basic credentials, or holds no
 *   credentials at all.
 */
export function applyCredential(
  url: string,
  headers: Record<string, string>,
  credential?: AuthCredential,
  authScheme?: OpenAPIV3.SecuritySchemeObject,
): string {
  if (!credential) return url;

  if (credential.apiKey) {
    let inLocation: string | undefined;
    let name = 'key';

    if (authScheme && authScheme.type === 'apiKey') {
      const apiKeyScheme = authScheme as OpenAPIV3.ApiKeySecurityScheme;
      inLocation = apiKeyScheme.in;
      name = apiKeyScheme.name;
    }

    if (inLocation === 'header') {
      headers[name] = credential.apiKey;
    } else if (inLocation === 'query') {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${name}=${encodeURIComponent(credential.apiKey)}`;
    } else {
      // Default to header Authorization if not specified or unknown location
      headers['Authorization'] = credential.apiKey;
    }
  } else if (
    credential.authType === AuthCredentialTypes.HTTP ||
    credential.http
  ) {
    const httpCredentials = credential.http?.credentials;
    if (httpCredentials?.token) {
      // The 'Bearer' prefix is hardcoded, and http.scheme is ignored, to match
      // adk-python's credential_to_param. Every exchanger in this repo mints
      // scheme 'bearer', and any other scheme arrives without a token and
      // throws below, so no mislabelled header reaches the wire.
      headers['Authorization'] = `Bearer ${httpCredentials.token}`;
    } else if (httpCredentials?.username || httpCredentials?.password) {
      throw new Error('Basic Authentication is not supported.');
    } else {
      throw new Error('Invalid HTTP auth credentials');
    }
  }

  return url;
}

/**
 * Helper to create a simple API Key auth scheme.
 */
export function createApiKeyScheme(
  name: string,
  inLocation: 'header' | 'query' | 'cookie',
): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'apiKey',
    name,
    in: inLocation,
  };
}

/**
 * Helper to create a simple Bearer Token auth scheme.
 */
export function createBearerScheme(): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'http',
    scheme: 'bearer',
  };
}
