/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';

const warnedItems = new Set<string>();

/**
 * Decorator to mark classes and methods as experimental.
 * Logs a warning once per item when the class is instantiated or the method is called.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- must return any, unknown does not work.
export type Constructor = new (...args: unknown[]) => any;

export function experimental<
  T extends Constructor | object,
  P extends string | symbol | undefined = undefined,
>(
  target: T,
  propertyKey?: P,
  descriptor?: PropertyDescriptor,
): P extends undefined ? T : PropertyDescriptor {
  // Handle class decoration
  if (propertyKey === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Function is safe because we know it's a constructor
    const className = (target as Function).name;
    const newConstructor = class extends (target as Constructor) {
      constructor(...args: unknown[]) {
        if (!warnedItems.has(className)) {
          logger.warn(
            `Class ${className} is experimental and may change in the future.`,
          );
          warnedItems.add(className);
        }
        // eslint-disable-next-line constructor-super -- super is required, ESLint can't figure it out.
        super(...args);
      }
    };

    // We must cast to the conditional return type because TS cannot
    // narrow return types based on control flow across conditional types.
    return newConstructor as P extends undefined ? T : PropertyDescriptor;
  }

  // Handle method decoration
  if (propertyKey !== undefined && descriptor !== undefined) {
    // Handle both instance and static methods
    const className =
      typeof target === 'function' ? target.name : target.constructor.name;
    const methodName = String(propertyKey);
    const identifier = `${className}.${methodName}`;
    const originalMethod = descriptor.value;

    descriptor.value = function (this: unknown, ...args: unknown[]) {
      if (!warnedItems.has(identifier)) {
        logger.warn(
          `Method ${identifier} is experimental and may change in the future.`,
        );
        warnedItems.add(identifier);
      }
      return originalMethod.apply(this, args);
    };

    return descriptor as P extends undefined ? T : PropertyDescriptor;
  }

  throw new Error('Invalid decorator usage');
}
