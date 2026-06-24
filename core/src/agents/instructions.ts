/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from '../sessions/state.js';
import {ReadonlyContext} from './readonly_context.js';

const ARTIFACT_PREFIX = 'artifact.';

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
  if (key.startsWith(ARTIFACT_PREFIX)) {
    const fileName = key.substring(ARTIFACT_PREFIX.length);
    if (invocationContext.artifactService === undefined) {
      throw new Error('Artifact service is not initialized.');
    }
    const artifact = await invocationContext.artifactService.loadArtifact({
      filename: fileName,
    });
    if (!artifact) {
      if (isOptional) {
        return '';
      }
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

  // Pre-parse matches to avoid redundant string manipulation in loops
  const parsedMatches = matches.map((match) => {
    const raw = match[0];
    let key = raw.replace(/^\{+/, '').replace(/\}+$/, '').trim();
    const isOptional = key.endsWith('?');
    if (isOptional) {
      key = key.slice(0, -1);
    }
    const isValid = key.startsWith(ARTIFACT_PREFIX) || isValidStateName(key);
    return {
      raw,
      key,
      isOptional,
      isValid,
      index: match.index!,
    };
  });

  // Deduplicate only valid keys by base key, merging optionality
  const uniqueKeys = new Map<
    string,
    {key: string; isOptional: boolean; raw: string}
  >();

  for (const pm of parsedMatches) {
    if (!pm.isValid) {
      continue;
    }
    const existing = uniqueKeys.get(pm.key);
    if (existing) {
      if (existing.isOptional && !pm.isOptional) {
        existing.isOptional = false;
      }
    } else {
      uniqueKeys.set(pm.key, {
        key: pm.key,
        isOptional: pm.isOptional,
        raw: pm.raw,
      });
    }
  }

  // Map of unique key -> resolution promise
  const resolutions = new Map<string, Promise<string>>();
  for (const info of uniqueKeys.values()) {
    resolutions.set(
      info.key,
      resolveKey(info.key, info.isOptional, info.raw, readonlyContext),
    );
  }

  // Trigger concurrent resolution
  await Promise.all(resolutions.values());

  // Reconstruct template using pre-parsed matches
  const result: string[] = [];
  let lastEnd = 0;
  for (const pm of parsedMatches) {
    result.push(template.slice(lastEnd, pm.index));
    if (pm.isValid) {
      const replacement = await resolutions.get(pm.key)!;
      result.push(replacement);
    } else {
      result.push(pm.raw);
    }
    lastEnd = pm.index + pm.raw.length;
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
