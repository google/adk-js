/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {parseHTML} from 'linkedom';
import {logger} from '../../utils/logger.js';
import {BasePruner} from './base_pruner.js';

export interface HtmlPrunerOptions {
  removeSelectors?: string[];
  keepSelectors?: string[];
  textOnly?: boolean;
}

export class HtmlPruner implements BasePruner {
  constructor(private readonly options: HtmlPrunerOptions) {}

  prune(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    try {
      const {document} = parseHTML(value);

      if (this.options.removeSelectors?.length) {
        document
          .querySelectorAll(this.options.removeSelectors.join(','))
          .forEach((el) => el.remove());
      }

      if (this.options.keepSelectors?.length && document.body) {
        const matched = document.querySelectorAll(
          this.options.keepSelectors.join(','),
        );
        const cloned = Array.from(matched, (el) => el.cloneNode(true));
        document.body.innerHTML = '';
        cloned.forEach((el) => document.body!.appendChild(el));
      }

      if (this.options.textOnly) {
        return document.body?.textContent ?? document.textContent ?? '';
      }

      return document.toString();
    } catch (error) {
      logger.warn('HtmlPruner failed, returning original value:', error);
      return value;
    }
  }
}
