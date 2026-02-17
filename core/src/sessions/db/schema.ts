/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Entity, JsonType, PrimaryKey, Property} from '@mikro-orm/core';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';

export const SCHEMA_VERSION_KEY = 'schema_version';
export const SCHEMA_VERSION_1_JSON = '1';

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

@Entity({tableName: 'adk_internal_metadata'})
export class StorageMetadata {
  @PrimaryKey({type: 'string'})
  key!: string;

  @Property({type: 'string'})
  value!: string;
}

@Entity({tableName: 'app_states'})
export class StorageAppState {
  @PrimaryKey({type: 'string', fieldName: 'app_name'})
  appName!: string;

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    fieldName: 'update_time',
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updateTime: Date = new Date();
}

@Entity({tableName: 'user_states'})
export class StorageUserState {
  @PrimaryKey({type: 'string', fieldName: 'app_name'})
  appName!: string;

  @PrimaryKey({type: 'string', fieldName: 'user_id'})
  userId!: string;

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    fieldName: 'update_time',
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string];
}

@Entity({tableName: 'sessions'})
export class StorageSession {
  @PrimaryKey({type: 'string'})
  id!: string;

  @PrimaryKey({type: 'string', fieldName: 'app_name'})
  appName!: string;

  @PrimaryKey({type: 'string', fieldName: 'user_id'})
  userId!: string;

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    fieldName: 'create_time',
    onCreate: () => new Date(),
  })
  createTime: Date = new Date();

  @Property({
    type: 'datetime',
    fieldName: 'update_time',
    onCreate: () => new Date(),
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string, string];
}

@Entity({tableName: 'events'})
export class StorageEvent {
  @PrimaryKey({type: 'string'})
  id!: string;

  @PrimaryKey({type: 'string', fieldName: 'app_name'})
  appName!: string;

  @PrimaryKey({type: 'string', fieldName: 'user_id'})
  userId!: string;

  @PrimaryKey({type: 'string', fieldName: 'session_id'})
  sessionId!: string;

  @Property({type: 'string', fieldName: 'invocation_id'})
  invocationId!: string;

  @Property({type: 'datetime'})
  timestamp!: Date;

  @Property({type: CamelCaseToSnakeCaseJsonType, fieldName: 'event_data'})
  eventData!: Event;

  [PrimaryKey.name]?: [string, string, string, string];
}

/*
 * Export entities for Mikro-ORM configuration
 */
export const ENTITIES = [
  StorageMetadata,
  StorageAppState,
  StorageUserState,
  StorageSession,
  StorageEvent,
];
