/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DatabaseSessionService} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';

// @ts-expect-error - Overriding MikroORM.init for testing purposes
MikroORM.init = async () => {
  return {
    schema: {
      ensureDatabase: async () => {},
      updateSchema: async () => {},
    },
    em: {
      fork: () => ({
        findOne: async () => null,
        create: () => ({}),
        persist: () => ({flush: async () => {}}),
      }),
    },
  };
};

async function testInit() {
  try {
    const service = new DatabaseSessionService('sqlite://:memory:');
    await service.init();
    console.log('DYNAMIC_IMPORT_SUCCESS');
  } catch (e) {
    console.error('DYNAMIC_IMPORT_FAILED', e);
  }
}
testInit();
