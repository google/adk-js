/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from '../sessions/state.js';
import {ReadonlyContext} from './readonly_context.js';

/**
 * Resolves a single key from the context (state or artifact).
 */
async function resolveKey(
  key: string,
  isOptional: boolean,
  rawMatch: string,
  readonlyContext: ReadonlyContext,
): Promise<string> {
  const invocationContext = readonlyContext.invocationContext;

  // Step 2: handle artifact injection
  if (key.startsWith('artifact.')) {
    const fileName = key.substring('artifact.'.length);
    if (invocationContext.artifactService === undefined) {
      throw new Error('Artifact service is not initialized.');
    }
    const artifact = await invocationContext.artifactService.loadArtifact({
      appName: invocationContext.session.appName,
      userId: invocationContext.session.userId,
      sessionId: invocationContext.session.id,
      filename: fileName,
    });
    if (!artifact) {
      throw new Error(`Artifact ${fileName} not found.`);
    }
    return String(artifact);
  }

  // Step 3: Handle state variable injection.
  if (!isValidStateName(key)) {
    return rawMatch;
  }

  if (key in invocationContext.session.state) {
    return String(invocationContext.session.state[key]);
  }

  if (isOptional) {
    return '';
  }

  throw new Error(`Context variable not found: \`${key}\`.`);
}

/**
 * Populates values in the instruction template, e.g. state, artifact, etc.
 *
 * ```
 * async function buildInstruction(
 *     readonlyContext: ReadonlyContext,
 * ): Promise<string> {
 *   return await injectSessionState(
 *       'You can inject a state variable like {var_name} or an artifact ' +
 *       '{artifact.file_name} into the instruction template.',
 *       readonlyContext,
 *   );
 * }
 *
 * const agent = new LlmAgent({
 *     model: 'gemini-1.5-flash',
 *     name: 'agent',
 *     instruction: buildInstruction,
 * });
 * ```
 *
 * @param template The instruction template.
 * @param readonlyContext The read-only context
 * @returns The instruction template with values populated.
 */
export async function injectSessionState(
  template: string,
  readonlyContext: ReadonlyContext,
): Promise<string> {
  const pattern = /\{+[^{}]*}+/g;
  const matches = Array.from(template.matchAll(pattern));

  if (matches.length === 0) {
    return template;
  }

  // Map of unique placeholder specifier -> resolution promise
  const resolutions = new Map<string, Promise<string>>();

  const getSpecifier = (key: string, isOptional: boolean) => {
    return `${key}${isOptional ? '?' : ''}`;
  };

  for (const match of matches) {
    const rawMatch = match[0];
    let key = rawMatch.replace(/^\{+/, '').replace(/\}+$/, '').trim();
    const isOptional = key.endsWith('?');
    if (isOptional) {
      key = key.slice(0, -1);
    }

    const specifier = getSpecifier(key, isOptional);
    if (!resolutions.has(specifier)) {
      resolutions.set(
        specifier,
        resolveKey(key, isOptional, rawMatch, readonlyContext),
      );
    }
  }

  // Trigger concurrent resolution of all unique keys
  await Promise.all(resolutions.values());

  const result: string[] = [];
  let lastEnd = 0;
  for (const match of matches) {
    const rawMatch = match[0];
    let key = rawMatch.replace(/^\{+/, '').replace(/\}+$/, '').trim();
    const isOptional = key.endsWith('?');
    if (isOptional) {
      key = key.slice(0, -1);
    }
    const specifier = getSpecifier(key, isOptional);

    result.push(template.slice(lastEnd, match.index));
    const replacement = await resolutions.get(specifier)!;
    result.push(replacement);
    lastEnd = match.index! + rawMatch.length;
  }
  result.push(template.slice(lastEnd));
  return result.join('');
}

/**
 * An IIFE that checks if the JavaScript runtime supports Unicode property
 * escapes (`\p{...}`) in regular expressions and returns a RegExp object that
 * is used for all subsequent calls to isIdentifier().
 */
const isIdentifierPattern = (() => {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/;
})();

/**
 * Checks if a string is a valid identifier.
 */
function isIdentifier(s: string): boolean {
  if (s === '' || s === undefined) {
    return false;
  }

  return isIdentifierPattern.test(s);
}

const VALID_PREFIXES = [State.APP_PREFIX, State.USER_PREFIX, State.TEMP_PREFIX];
/**
 * Checks if a variable name is a valid state name.
 * A valid state name is either:
 *   - <identifier>
 *   - <prefix>:<identifier>
 *
 * @param variableName The variable name to check.
 * @returns True if the variable name is valid, False otherwise.
 */
function isValidStateName(variableName: string): boolean {
  const parts = variableName.split(':');
  if (parts.length === 0 || parts.length > 2) {
    return false;
  }
  if (parts.length === 1) {
    return isIdentifier(variableName);
  }
  if (VALID_PREFIXES.includes(parts[0] + ':')) {
    return isIdentifier(parts[1]);
  }
  return false;
}
