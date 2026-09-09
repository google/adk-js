/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EntitySchema,
  JsonType,
  type Opt,
  PrimaryKeyProp,
} from '@mikro-orm/core';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';

export const SCHEMA_VERSION_KEY = 'schema_version';
export const SCHEMA_VERSION_1_JSON = '1';
export const STORAGE_KEY_COLUMN_LENGTH = 191;

/**
 * Fractional-second digits requested for the stored event timestamp.
 *
 * MySQL and MariaDB round a `datetime` column to whole seconds unless a
 * precision is given. That collapses events written in the same second onto one
 * value and leaves their order undefined. Other backends are unaffected:
 * PostgreSQL already defaults to six digits and SQLite ignores the precision.
 */
export const EVENT_TIMESTAMP_PRECISION = 6;

/**
 * Custom type for serializing and deserializing ADK Event objects.
 *
 * This type handles the conversion between camelCase (TypeScript ADK) and
 * snake_case (Python ADK) for Event objects, ensuring that nested
 * properties are converted correctly while preserving specific keys.
 */
class CamelCaseToSnakeCaseJsonType extends JsonType {
  convertToDatabaseValue(value: Event): string {
    return JSON.stringify(transformToSnakeCaseEvent(value));
  }

  convertToJSValue(value: string | Record<string, unknown>): Event {
    if (typeof value === 'string') {
      return transformToCamelCaseEvent(JSON.parse(value));
    }

    return transformToCamelCaseEvent(value);
  }
}

/**
 * The shape shared by every storage key column, which is capped so that a
 * composite primary key still fits inside MySQL's index size limit.
 */
const KEY_COLUMN = {
  type: 'string',
  length: STORAGE_KEY_COLUMN_LENGTH,
  primary: true,
} as const;

// The entities below are plain classes paired with an `EntitySchema`, rather
// than decorated classes. MikroORM v7 moved the decorators into
// `@mikro-orm/decorators`, whose legacy entry pulls in `reflect-metadata`;
// declaring the mapping separately keeps both off the dependency list while
// leaving the classes usable as values (`em.create(StorageEvent, ...)`) and as
// types (`InstanceType<...>`) exactly as before.

export class StorageMetadata {
  key!: string;
  value!: string;
}

export const storageMetadataSchema = new EntitySchema<StorageMetadata>({
  class: StorageMetadata,
  tableName: 'adk_internal_metadata',
  properties: {
    key: {type: 'string', primary: true},
    value: {type: 'string'},
  },
});

export class StorageAppState {
  appName!: string;
  state!: Record<string, unknown>;
  updateTime: Opt<Date> = new Date();
}

export const storageAppStateSchema = new EntitySchema<StorageAppState>({
  class: StorageAppState,
  tableName: 'app_states',
  properties: {
    appName: {...KEY_COLUMN, fieldName: 'app_name'},
    state: {type: 'json'},
    updateTime: {
      type: 'datetime',
      fieldName: 'update_time',
      onCreate: () => new Date(),
      onUpdate: () => new Date(),
    },
  },
});

export class StorageUserState {
  appName!: string;
  userId!: string;
  state!: Record<string, unknown>;
  updateTime: Opt<Date> = new Date();

  [PrimaryKeyProp]?: ['appName', 'userId'];
}

export const storageUserStateSchema = new EntitySchema<StorageUserState>({
  class: StorageUserState,
  tableName: 'user_states',
  properties: {
    appName: {...KEY_COLUMN, fieldName: 'app_name'},
    userId: {...KEY_COLUMN, fieldName: 'user_id'},
    state: {type: 'json'},
    updateTime: {
      type: 'datetime',
      fieldName: 'update_time',
      onCreate: () => new Date(),
      onUpdate: () => new Date(),
    },
  },
});

export class StorageSession {
  id!: string;
  appName!: string;
  userId!: string;
  state!: Record<string, unknown>;
  createTime: Opt<Date> = new Date();
  updateTime: Opt<Date> = new Date();

  [PrimaryKeyProp]?: ['id', 'appName', 'userId'];
}

export const storageSessionSchema = new EntitySchema<StorageSession>({
  class: StorageSession,
  tableName: 'sessions',
  properties: {
    id: KEY_COLUMN,
    appName: {...KEY_COLUMN, fieldName: 'app_name'},
    userId: {...KEY_COLUMN, fieldName: 'user_id'},
    state: {type: 'json'},
    createTime: {
      type: 'datetime',
      fieldName: 'create_time',
      onCreate: () => new Date(),
    },
    updateTime: {
      type: 'datetime',
      fieldName: 'update_time',
      onCreate: () => new Date(),
    },
  },
});

export class StorageEvent {
  id!: string;
  appName!: string;
  userId!: string;
  sessionId!: string;
  invocationId!: string;
  timestamp!: Date;
  eventData!: Event;

  [PrimaryKeyProp]?: ['id', 'appName', 'userId', 'sessionId'];
}

export const storageEventSchema = new EntitySchema<StorageEvent>({
  class: StorageEvent,
  tableName: 'events',
  properties: {
    id: KEY_COLUMN,
    appName: {...KEY_COLUMN, fieldName: 'app_name'},
    userId: {...KEY_COLUMN, fieldName: 'user_id'},
    sessionId: {...KEY_COLUMN, fieldName: 'session_id'},
    invocationId: {type: 'string', fieldName: 'invocation_id'},
    timestamp: {type: 'datetime', length: EVENT_TIMESTAMP_PRECISION},
    eventData: {type: CamelCaseToSnakeCaseJsonType, fieldName: 'event_data'},
  },
});

/*
 * Export entities for Mikro-ORM configuration
 */
export const ENTITIES = [
  storageMetadataSchema,
  storageAppStateSchema,
  storageUserStateSchema,
  storageSessionSchema,
  storageEventSchema,
];
