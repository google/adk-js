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
      const pruned = Array.isArray(value) ? [] : {};

      for (const path of this.options.paths) {
        const pointers = JSONPath({
          path,
          json: value,
          resultType: 'pointer',
        }) as string[];

        for (const p of pointers) {
          const lPath = p
            .split('/')
            .slice(1)
            .map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
          set(pruned, lPath, get(value, lPath));
        }
      }

      return pruned;
    } catch (error) {
      logger.warn('JsonPathPruner failed, returning original value:', error);
      return value;
    }
  }
}
