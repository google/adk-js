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
      const {window: _window, document} = parseHTML(value);

      if (this.options.removeSelectors) {
        for (const selector of this.options.removeSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            el.remove();
          }
        }
      }

      if (this.options.keepSelectors && this.options.keepSelectors.length > 0) {
        const matchedElements: InstanceType<typeof _window.Node>[] = [];
        for (const selector of this.options.keepSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            matchedElements.push(el.cloneNode(true));
          }
        }
        if (document.body) {
          document.body.innerHTML = '';
          for (const el of matchedElements) {
            document.body.appendChild(el);
          }
        }
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
