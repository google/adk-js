/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {BaseArtifactService} from '../../src/artifacts/base_artifact_service.js';
import {InMemoryArtifactService} from '../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {
  isSessionArtifactService,
  SessionArtifactService,
} from '../../src/artifacts/session_artifact_service.js';
import {ForwardingArtifactService} from '../../src/tools/forwarding_artifact_service.js';

/**
 * The signature symbol carried by session-scoped artifact services. It is
 * module-private in `session_artifact_service.ts`; `Symbol.for` resolves to the
 * very same symbol through the global symbol registry.
 */
const SESSION_ARTIFACT_SERVICE_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.sessionArtifactService',
);

function makeBaseArtifactServiceStub(): BaseArtifactService {
  return {
    saveArtifact: vi.fn(),
    loadArtifact: vi.fn(),
    listArtifactKeys: vi.fn(),
    deleteArtifact: vi.fn(),
    listVersions: vi.fn(),
    listArtifactVersions: vi.fn(),
    getArtifactVersion: vi.fn(),
  };
}

describe('isSessionArtifactService', () => {
  it('detects ScopedArtifactService', () => {
    const service = new ScopedArtifactService(
      makeBaseArtifactServiceStub(),
      'test-app',
      'test-user',
      'test-session',
    );

    expect(isSessionArtifactService(service)).toBe(true);
  });

  it('detects ForwardingArtifactService', () => {
    const toolContext = {
      saveArtifact: vi.fn(),
      loadArtifact: vi.fn(),
      listArtifacts: vi.fn(),
      invocationContext: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    expect(
      isSessionArtifactService(new ForwardingArtifactService(toolContext)),
    ).toBe(true);
  });

  it('detects any object carrying the signature symbol', () => {
    const branded: SessionArtifactService & Record<symbol, unknown> = {
      [SESSION_ARTIFACT_SERVICE_SIGNATURE_SYMBOL]: true,
      saveArtifact: vi.fn(),
      loadArtifact: vi.fn(),
      listArtifactKeys: vi.fn(),
      deleteArtifact: vi.fn(),
      listVersions: vi.fn(),
      listArtifactVersions: vi.fn(),
      getArtifactVersion: vi.fn(),
    };

    expect(isSessionArtifactService(branded)).toBe(true);
  });

  it('does not detect a BaseArtifactService implementation', () => {
    expect(isSessionArtifactService(new InMemoryArtifactService())).toBe(false);
  });

  it('does not detect a BaseArtifactService stub', () => {
    expect(isSessionArtifactService(makeBaseArtifactServiceStub())).toBe(false);
  });

  it('does not detect an unbranded object with a session-scoped shape', () => {
    const unbranded = {
      saveArtifact: vi.fn(),
      loadArtifact: vi.fn(),
      listArtifactKeys: vi.fn(),
      deleteArtifact: vi.fn(),
      listVersions: vi.fn(),
      listArtifactVersions: vi.fn(),
      getArtifactVersion: vi.fn(),
    } as unknown as SessionArtifactService;

    expect(isSessionArtifactService(unbranded)).toBe(false);
  });

  it('does not detect an object whose signature symbol is not true', () => {
    const notBranded = {
      [SESSION_ARTIFACT_SERVICE_SIGNATURE_SYMBOL]: 'yes',
    } as unknown as SessionArtifactService;

    expect(isSessionArtifactService(notBranded)).toBe(false);
  });
});
