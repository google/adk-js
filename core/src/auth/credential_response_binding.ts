/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, OAuth2Auth} from './auth_credential.js';
import {AuthConfig} from './auth_tool.js';

/**
 * Reads a field that may arrive in either casing.
 *
 * Request args are normalised by `camelCaseKeys` before they get here, but a
 * response is whatever the client sent, and the two producers of an
 * `adk_request_credential` call already disagree on casing.
 */
function readField(source: unknown, name: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (name in record) {
    return record[name];
  }
  return record[name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
}

/** Reads a field only if the client sent it as a string. */
function readString(source: unknown, name: string): string | undefined {
  const value = readField(source, name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Builds the credential to store from the one the client supplied.
 *
 * Two shapes, matching the two an agent can raise. If the request carries an
 * `authUri` then an authorization-code flow is in progress: the credential is
 * the agent's, and the only thing the client is answering with is the redirect
 * it landed on. Otherwise nothing was pinned to answer — an API key, an HTTP
 * credential, a service account — and the supplied credential is the answer.
 *
 * On the authorization-code path this deliberately drops a supplied
 * `accessToken`. The agent asked for a code; a response bearing a ready-made
 * token is not an answer to that question but a way to skip it, and the
 * exchanger returns early on any token it finds. It also drops a supplied
 * `state`, which is what makes the exchanger's CSRF check mean something: the
 * state it compares against the redirect is now the one the agent issued, not
 * one the same message chose.
 *
 * Returns `undefined` when a pending authorization-code flow gets no answer at
 * all, so that shape is refused here alongside every other unusable response
 * rather than travelling on to fail deeper in the exchanger.
 */
function bindCredential(
  request: Partial<AuthConfig>,
  supplied: unknown,
): AuthCredential | undefined {
  const requested = request.exchangedAuthCredential;
  if (!requested?.oauth2?.authUri) {
    return supplied as AuthCredential;
  }

  const suppliedOAuth2 = readField(supplied, 'oauth2');
  const answer: Partial<OAuth2Auth> = {};
  const authResponseUri = readString(suppliedOAuth2, 'authResponseUri');
  if (authResponseUri !== undefined) {
    answer.authResponseUri = authResponseUri;
  }
  const authCode = readString(suppliedOAuth2, 'authCode');
  if (authCode !== undefined) {
    answer.authCode = authCode;
  }
  if (authResponseUri === undefined && authCode === undefined) {
    return undefined;
  }

  return {
    ...requested,
    oauth2: {...requested.oauth2, ...answer},
  };
}

/**
 * Reconciles a credential response with the request that asked for it.
 *
 * The request is agent-authored and defines the question: which scheme, from
 * which authorization server, under which key, on behalf of which client. The
 * response is client-authored and carries one thing — the credential material
 * the user obtained. Everything else it contains is discarded, because a
 * response that gets to restate the question also decides whether the
 * credential is exchanged at all, where the exchange sends the client secret,
 * and which waiting tool picks the result up.
 *
 * The request is typed loosely on purpose: it is read back off the wire out of
 * a function call's args, so it can arrive missing the fields its type
 * promises. Returns `undefined` when it is too incomplete to be an authority,
 * or when the response carries nothing that answers it — either way there is
 * nothing that can safely be stored.
 */
export function bindCredentialResponse(
  request: Partial<AuthConfig>,
  response: unknown,
): AuthConfig | undefined {
  const {authScheme, credentialKey} = request;
  if (!authScheme || !credentialKey) {
    return undefined;
  }

  const supplied = readField(response, 'exchangedAuthCredential');
  if (typeof supplied !== 'object' || supplied === null) {
    return undefined;
  }

  const exchangedAuthCredential = bindCredential(request, supplied);
  if (!exchangedAuthCredential) {
    return undefined;
  }

  return {
    authScheme,
    credentialKey,
    rawAuthCredential: request.rawAuthCredential,
    exchangedAuthCredential,
  };
}
