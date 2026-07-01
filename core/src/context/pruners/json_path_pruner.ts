/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {JSONPath} from 'jsonpath-plus';
import {get, set} from 'lodash-es';
import {logger} from '../../utils/logger.js';
import {BasePruner} from './base_pruner.js';

export interface JsonPathPrunerOptions {
  paths: string[];
}

export class JsonPathPruner implements BasePruner {
  constructor(private readonly options: JsonPathPrunerOptions) {}

  prune(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) {
      return value;
    }

    try {
      const isArray = Array.isArray(value);
      const pruned: Record<string, unknown> | unknown[] = isArray ? [] : {};

      for (const path of this.options.paths) {
        const pointers = JSONPath({
          path,
          json: value,
          resultType: 'pointer',
        }) as string[];

        for (const pointer of pointers) {
          // Convert JSON Pointer (/a/b/c) to lodash path (a.b.c or ['a', 'b', 'c'])
          const lodashPath = pointer
            .split('/')
            .slice(1)
            .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));

          const val = get(value, lodashPath);

          set(pruned, lodashPath, val);
        }
      }

      return pruned;
    } catch (error) {
      logger.warn('JsonPathPruner failed, returning original value:', error);
      return value;
    }
  }
}
