/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {BaseArtifactService} from '../../src/artifacts/base_artifact_service.js';
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {
  SessionLoadArtifactRequest,
  SessionSaveArtifactRequest,
} from '../../src/artifacts/session_artifact_service.js';

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

describe('ScopedArtifactService', () => {
  const appName = 'test-app';
  const userId = 'test-user';
  const sessionId = 'test-session';

  describe('saveArtifact', () => {
    it('delegates with scoped context', async () => {
      const delegate = makeBaseArtifactServiceStub();
      vi.mocked(delegate.saveArtifact).mockResolvedValue(42);
      const service = new ScopedArtifactService(
        delegate,
        appName,
        userId,
        sessionId,
      );

      const request: SessionSaveArtifactRequest = {
        filename: 'file.txt',
        artifact: {text: 'hello'},
        customMetadata: {foo: 'bar'},
      };

      const result = await service.saveArtifact(request);

      expect(delegate.saveArtifact).toHaveBeenCalledWith({
        appName,
        userId,
        sessionId,
        filename: 'file.txt',
        artifact: {text: 'hello'},
        customMetadata: {foo: 'bar'},
      });
      expect(result).toBe(42);
    });
  });

  describe('loadArtifact', () => {
    it('delegates with scoped context', async () => {
      const delegate = makeBaseArtifactServiceStub();
      const part: Part = {text: 'content'};
      vi.mocked(delegate.loadArtifact).mockResolvedValue(part);
      const service = new ScopedArtifactService(
        delegate,
        appName,
        userId,
        sessionId,
      );

      const request: SessionLoadArtifactRequest = {
        filename: 'file.txt',
        version: 2,
      };

      const result = await service.loadArtifact(request);

      expect(delegate.loadArtifact).toHaveBeenCalledWith({
        appName,
        userId,
        sessionId,
        filename: 'file.txt',
        version: 2,
      });
      expect(result).toBe(part);
    });
  });

  describe('listArtifactKeys', () => {
    it('delegates with scoped context', async () => {
      const delegate = makeBaseArtifactServiceStub();
      vi.mocked(delegate.listArtifactKeys).mockResolvedValue(['a', 'b']);
      const service = new ScopedArtifactService(
        delegate,
        appName,
        userId,
        sessionId,
      );

      const result = await service.listArtifactKeys();

      expect(delegate.listArtifactKeys).toHaveBeenCalledWith({
        appName,
        userId,
        sessionId,
      });
      expect(result).toEqual(['a', 'b']);
    });
  });

  describe('deleteArtifact', () => {
    it('delegates with scoped context', async () => {
      const delegate = makeBaseArtifactServiceStub();
      const service = new ScopedArtifactService(
        delegate,
        appName,
        userId,
        sessionId,
      );

      await service.deleteArtifact('file.txt');

      expect(delegate.deleteArtifact).toHaveBeenCalledWith({
        appName,
        userId,
        sessionId,
        filename: 'file.txt',
      });
    });
  });

  describe('listVersions', () => {
    it('delegates with scoped context', async () => {
      const delegate = makeBaseArtifactServiceStub();
      vi.mocked(delegate.listVersions).mockResolvedValue([1, 2]);
      const service = new ScopedArtifactService(
        delegate,
        appName,
        userId,
        sessionId,
      );

      const result = await service.listVersions('file.txt');

      expect(delegate.listVersions).toHaveBeenCalledWith({
        appName,
        userId,
        sessionId,
        filename: 'file.txt',
      });
      expect(result).toEqual([1, 2]);
    });
  });

  describe('listArtifactVersions', () => {
    it('delegates with scoped context', async () => {
      const delegate = makeBaseArtifactServiceStub();
      const versions = [{version: 1}];
      vi.mocked(delegate.listArtifactVersions).mockResolvedValue(versions);
      const service = new ScopedArtifactService(
        delegate,
        appName,
        userId,
        sessionId,
      );

      const result = await service.listArtifactVersions('file.txt');

      expect(delegate.listArtifactVersions).toHaveBeenCalledWith({
        appName,
        userId,
        sessionId,
        filename: 'file.txt',
      });
      expect(result).toEqual(versions);
    });
  });

  describe('getArtifactVersion', () => {
    it('delegates with scoped context', async () => {
      const delegate = makeBaseArtifactServiceStub();
      const version = {version: 1};
      vi.mocked(delegate.getArtifactVersion).mockResolvedValue(version);
      const service = new ScopedArtifactService(
        delegate,
        appName,
        userId,
        sessionId,
      );

      const request: SessionLoadArtifactRequest = {
        filename: 'file.txt',
        version: 1,
      };

      const result = await service.getArtifactVersion(request);

      expect(delegate.getArtifactVersion).toHaveBeenCalledWith({
        appName,
        userId,
        sessionId,
        filename: 'file.txt',
        version: 1,
      });
      expect(result).toBe(version);
    });
  });
});
