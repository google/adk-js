/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Schema and view SQL emitted by adk-python's plugin, captured as a fixture.
 */
export interface Golden {
  source: string;
  schema: Array<{
    name: string;
    type: string;
    mode: string;
    description: string;
    fields?: unknown[];
  }>;
  analytics: Array<{
    project: string;
    dataset: string;
    table: string;
    prefix: string;
    denied: string[];
    sql: string[];
  }>;
  eval: Array<{
    fullTableId: string;
    prefix: string;
    denied: string[];
    session: string;
    turn: string;
  }>;
}

export const golden = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures/python_schema_views.json',
    ),
    'utf8',
  ),
) as Golden;
