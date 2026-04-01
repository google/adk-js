/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {logger} from '../../utils/logger.js';

/**
 * Represents the OAuth2 authorization server metadata per RFC8414.
 */
export const AuthorizationServerMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  scopes_supported: z.array(z.string()).optional(),
  registration_endpoint: z.string().optional(),
});

export type AuthorizationServerMetadata = z.infer<
  typeof AuthorizationServerMetadataSchema
>;

/**
 * Represents the OAuth2 protected resource metadata per RFC9728.
 */
export const ProtectedResourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).default([]),
});

export type ProtectedResourceMetadata = z.infer<
  typeof ProtectedResourceMetadataSchema
>;

/**
 * Implements Metadata discovery for OAuth2 following RFC8414 and RFC9728.
 */
export class OAuth2DiscoveryManager {
  /**
   * Discovers the OAuth2 authorization server metadata.
   */
  async discoverAuthServerMetadata(
    issuerUrl: string,
  ): Promise<AuthorizationServerMetadata | undefined> {
    if (!validateDiscoveryUrl(issuerUrl)) {
      return undefined;
    }

    let baseUrl: string;
    let path: string;

    try {
      const url = new URL(issuerUrl);
      baseUrl = `${url.protocol}//${url.host}`;
      path = url.pathname;
    } catch (e) {
      logger.warn(`Failed to parse issuerUrl ${issuerUrl}: ${e}`);
      return undefined;
    }

    const endpointsToTry: string[] = [];

    if (path && path !== '/') {
      endpointsToTry.push(
        `${baseUrl}/.well-known/oauth-authorization-server${path}`,
        `${baseUrl}/.well-known/openid-configuration${path}`,
        `${baseUrl}${path}/.well-known/openid-configuration`,
      );
    } else {
      endpointsToTry.push(
        `${baseUrl}/.well-known/oauth-authorization-server`,
        `${baseUrl}/.well-known/openid-configuration`,
      );
    }

    for (const endpoint of endpointsToTry) {
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          continue;
        }

        const data = await response.json();
        const metadata = AuthorizationServerMetadataSchema.parse(data);

        // Validate issuer to defend against MIX-UP attacks
        if (
          metadata.issuer.replace(/\/$/, '') === issuerUrl.replace(/\/$/, '')
        ) {
          return metadata;
        } else {
          logger.warn(
            `Issuer in metadata ${metadata.issuer} does not match issuerUrl ${issuerUrl}`,
          );
        }
      } catch (e) {
        logger.debug(`Failed to fetch metadata from ${endpoint}: ${e}`);
      }
    }

    return undefined;
  }

  /**
   * Discovers the OAuth2 protected resource metadata.
   */
  async discoverResourceMetadata(
    resourceUrl: string,
  ): Promise<ProtectedResourceMetadata | undefined> {
    if (!validateDiscoveryUrl(resourceUrl)) {
      return undefined;
    }

    let baseUrl: string;
    let path: string;

    try {
      const url = new URL(resourceUrl);
      baseUrl = `${url.protocol}//${url.host}`;
      path = url.pathname;
    } catch (e) {
      logger.warn(`Failed to parse resourceUrl ${resourceUrl}: ${e}`);
      return undefined;
    }

    let wellKnownEndpoint: string;
    if (path && path !== '/') {
      wellKnownEndpoint = `${baseUrl}/.well-known/oauth-protected-resource${path}`;
    } else {
      wellKnownEndpoint = `${baseUrl}/.well-known/oauth-protected-resource`;
    }

    try {
      const response = await fetch(wellKnownEndpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return undefined;
      }

      const data = await response.json();
      const metadata = ProtectedResourceMetadataSchema.parse(data);

      if (
        metadata.resource.replace(/\/$/, '') === resourceUrl.replace(/\/$/, '')
      ) {
        return metadata;
      } else {
        logger.warn(
          `Resource in metadata ${metadata.resource} does not match resourceUrl ${resourceUrl}`,
        );
      }
    } catch (e) {
      logger.debug(`Failed to fetch metadata from ${wellKnownEndpoint}: ${e}`);
    }

    return undefined;
  }
}

function validateDiscoveryUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'https:') {
      logger.warn(`Unsafe protocol for discovery URL: ${url.protocol}`);
      return false;
    }

    const host = url.hostname.toLowerCase();

    // Block localhost and common private IP ranges
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.')
    ) {
      logger.warn(`Unsafe host for discovery URL: ${host}`);
      return false;
    }

    // Check for 172.16.x.x - 172.31.x.x
    const match = host.match(/^172\.(\d+)\./);
    if (match) {
      const secondOctet = parseInt(match[1], 10);
      if (secondOctet >= 16 && secondOctet <= 31) {
        logger.warn(`Unsafe host for discovery URL: ${host}`);
        return false;
      }
    }

    return true;
  } catch (e) {
    logger.warn(`Failed to parse URL for validation ${urlStr}: ${e}`);
    return false;
  }
}
