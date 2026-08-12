/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';

const warnedItems = new Set<string>();

/** Resets the warned-once registry. Test-only. */
export function resetDeprecationWarnings(): void {
  warnedItems.clear();
}

// `any[]` rather than `unknown[]`: a class whose constructor takes a typed
// config (every agent) is not assignable to `new (...args: unknown[]) => …`,
// so the stricter signature would reject exactly the classes this decorates.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
type Constructor = new (...args: any[]) => any;

/**
 * Marks a class as deprecated, logging `reason` once the first time it is
 * instantiated.
 *
 * The JSDoc `@deprecated` tag is what a reader and an editor see; this is what
 * someone running the code sees, so a deprecation is not silent to a caller who
 * never opens the source. Mirrors `typing_extensions.deprecated`, which
 * adk-python applies to the same classes, and follows the shape of
 * {@link experimental}: one warning per class, not per instance, so a hot loop
 * does not turn into a wall of logs.
 */
export function deprecated(reason: string) {
  return function <T extends Constructor>(target: T): T {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Function is safe because we know it's a constructor
    const className = (target as Function).name;
    const wrapped = class extends (target as Constructor) {
      constructor(...args: unknown[]) {
        if (!warnedItems.has(className)) {
          logger.warn(reason);
          warnedItems.add(className);
        }
        // eslint-disable-next-line constructor-super -- super is required, ESLint can't figure it out.
        super(...args);
      }
    };

    // The subclass above is anonymous, so it would otherwise report the binding
    // name to anyone reading `SomeClass.name` — which agent code does, since a
    // class name reaches events and logs.
    Object.defineProperty(wrapped, 'name', {
      value: className,
      configurable: true,
    });

    return wrapped as T;
  };
}
