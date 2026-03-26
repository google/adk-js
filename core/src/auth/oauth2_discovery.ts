/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

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
    let baseUrl: string;
    let path: string;

    try {
      const url = new URL(issuerUrl);
      baseUrl = `${url.protocol}//${url.host}`;
      path = url.pathname;
    } catch (e) {
      console.warn(`Failed to parse issuerUrl ${issuerUrl}: ${e}`);
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
          console.warn(
            `Issuer in metadata ${metadata.issuer} does not match issuerUrl ${issuerUrl}`,
          );
        }
      } catch (e) {
        console.debug(`Failed to fetch metadata from ${endpoint}: ${e}`);
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
    let baseUrl: string;
    let path: string;

    try {
      const url = new URL(resourceUrl);
      baseUrl = `${url.protocol}//${url.host}`;
      path = url.pathname;
    } catch (e) {
      console.warn(`Failed to parse resourceUrl ${resourceUrl}: ${e}`);
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
        console.warn(
          `Resource in metadata ${metadata.resource} does not match resourceUrl ${resourceUrl}`,
        );
      }
    } catch (e) {
      console.debug(`Failed to fetch metadata from ${wellKnownEndpoint}: ${e}`);
    }

    return undefined;
  }
}
