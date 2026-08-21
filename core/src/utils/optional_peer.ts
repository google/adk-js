/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loader for ADK's optional peer dependencies.
 *
 * A handful of ADK subsystems are backed by large, situational packages (a
 * cloud storage client, an MCP client, a SQL driver, an HTTP server). Those
 * packages are declared as optional `peerDependencies` so that installing
 * `@google/adk` does not download them for the many applications that never
 * touch the corresponding subsystem. They are loaded lazily, at the point of
 * first use, and a missing one has to produce an error that names both the
 * feature and the exact install command instead of a bare
 * `ERR_MODULE_NOT_FOUND`.
 */

/** Node's error codes for an unresolvable module, in ESM and in CJS. */
const MODULE_NOT_FOUND_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
]);

/** Describes the optional peer dependency a feature is asking for. */
export interface OptionalPeer {
  /** The npm package name, e.g. `@google-cloud/storage`. */
  packageName: string;
  /** The ADK feature that needs it, used in the error message. */
  feature: string;
}

/**
 * Returns true when `err` is Node reporting that `packageName` itself could
 * not be resolved, as opposed to any other failure raised while evaluating
 * the module (a syntax error, a failing side effect, a missing transitive
 * dependency), which must be surfaced unchanged.
 */
function isMissingModule(err: unknown, packageName: string): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & {code?: string}).code;
  return (
    code !== undefined &&
    MODULE_NOT_FOUND_CODES.has(code) &&
    err.message.includes(packageName)
  );
}

/**
 * Loads an optional peer dependency, translating "not installed" into an
 * actionable error.
 *
 * The dynamic `import()` is passed in as a thunk rather than being built from
 * `packageName`, so that the specifier stays a literal in the calling module
 * and remains visible to bundlers and to test doubles installed with
 * `vi.mock()`.
 *
 * ```ts
 * const {Storage} = await loadOptionalPeer(
 *   {packageName: '@google-cloud/storage', feature: 'GcsArtifactService'},
 *   () => import('@google-cloud/storage'),
 * );
 * ```
 *
 * @param peer The package being loaded and the feature that needs it.
 * @param load Thunk performing the dynamic `import()`.
 * @return The imported module namespace.
 * @throws If the package is not installed, an error naming the feature and
 *   the `npm install` command that fixes it. Any other load failure is
 *   rethrown unchanged.
 */
export async function loadOptionalPeer<T>(
  peer: OptionalPeer,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (err: unknown) {
    if (!isMissingModule(err, peer.packageName)) {
      throw err;
    }
    throw new Error(
      `${peer.feature} requires the optional peer dependency ` +
        `"${peer.packageName}", which is not installed. It is optional so ` +
        `that applications that do not use ${peer.feature} are not made to ` +
        `download it. Install it with:\n\n` +
        `  npm install ${peer.packageName}\n`,
      {cause: err},
    );
  }
}
