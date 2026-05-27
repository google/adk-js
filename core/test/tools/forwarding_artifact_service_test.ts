/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  DeleteArtifactRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from '../../src/artifacts/base_artifact_service.js';
import {ForwardingArtifactService} from '../../src/tools/forwarding_artifact_service.js';

function makeArtifactServiceStub() {
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

function makeToolContext(
  artifactService?: ReturnType<typeof makeArtifactServiceStub>,
) {
  return {
    saveArtifact: vi.fn(),
    loadArtifact: vi.fn(),
    listArtifacts: vi.fn(),
    invocationContext: {
      artifactService,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('ForwardingArtifactService', () => {
  describe('saveArtifact', () => {
    it('delegates to toolContext.saveArtifact', async () => {
      const toolContext = makeToolContext();
      toolContext.saveArtifact.mockResolvedValue(0);
      const service = new ForwardingArtifactService(toolContext);

      const request: SaveArtifactRequest = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'file.txt',
        artifact: {text: 'hello'},
      };

      const version = await service.saveArtifact(request);
      expect(toolContext.saveArtifact).toHaveBeenCalledWith('file.txt', {
        text: 'hello',
      });
      expect(version).toBe(0);
    });
  });

  describe('loadArtifact', () => {
    it('delegates to toolContext.loadArtifact', async () => {
      const toolContext = makeToolContext();
      const part: Part = {text: 'content'};
      toolContext.loadArtifact.mockResolvedValue(part);
      const service = new ForwardingArtifactService(toolContext);

      const request: LoadArtifactRequest = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'file.txt',
        version: 2,
      };

      const result = await service.loadArtifact(request);
      expect(toolContext.loadArtifact).toHaveBeenCalledWith('file.txt', 2);
      expect(result).toBe(part);
    });

    it('passes undefined version when not specified', async () => {
      const toolContext = makeToolContext();
      toolContext.loadArtifact.mockResolvedValue(undefined);
      const service = new ForwardingArtifactService(toolContext);

      await service.loadArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'file.txt',
      });
      expect(toolContext.loadArtifact).toHaveBeenCalledWith(
        'file.txt',
        undefined,
      );
    });
  });

  describe('listArtifactKeys', () => {
    it('delegates to toolContext.listArtifacts', async () => {
      const toolContext = makeToolContext();
      toolContext.listArtifacts.mockResolvedValue(['a.txt', 'b.txt']);
      const service = new ForwardingArtifactService(toolContext);

      const result = await service.listArtifactKeys();
      expect(toolContext.listArtifacts).toHaveBeenCalled();
      expect(result).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('deleteArtifact', () => {
    it('delegates to invocationContext.artifactService.deleteArtifact', async () => {
      const artifactService = makeArtifactServiceStub();
      artifactService.deleteArtifact.mockResolvedValue(undefined);
      const toolContext = makeToolContext(artifactService);
      const service = new ForwardingArtifactService(toolContext);

      const request: DeleteArtifactRequest = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'file.txt',
      };

      await service.deleteArtifact(request);
      expect(artifactService.deleteArtifact).toHaveBeenCalledWith(request);
    });

    it('throws when artifactService is undefined', async () => {
      const toolContext = makeToolContext(undefined);
      const service = new ForwardingArtifactService(toolContext);

      await expect(
        service.deleteArtifact({
          appName: 'app',
          userId: 'user',
          sessionId: 'session',
          filename: 'file.txt',
        }),
      ).rejects.toThrow('Artifact service is not initialized.');
    });
  });

  describe('listVersions', () => {
    it('delegates to invocationContext.artifactService.listVersions', async () => {
      const artifactService = makeArtifactServiceStub();
      artifactService.listVersions.mockResolvedValue([0, 1, 2]);
      const toolContext = makeToolContext(artifactService);
      const service = new ForwardingArtifactService(toolContext);

      const request: ListVersionsRequest = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'file.txt',
      };

      const result = await service.listVersions(request);
      expect(artifactService.listVersions).toHaveBeenCalledWith(request);
      expect(result).toEqual([0, 1, 2]);
    });

    it('throws when artifactService is undefined', async () => {
      const toolContext = makeToolContext(undefined);
      const service = new ForwardingArtifactService(toolContext);

      await expect(
        service.listVersions({
          appName: 'app',
          userId: 'user',
          sessionId: 'session',
          filename: 'file.txt',
        }),
      ).rejects.toThrow('Artifact service is not initialized.');
    });
  });

  describe('listArtifactVersions', () => {
    it('delegates to invocationContext.artifactService.listArtifactVersions', async () => {
      const artifactService = makeArtifactServiceStub();
      const versions = [{version: 0}, {version: 1}];
      artifactService.listArtifactVersions.mockResolvedValue(versions);
      const toolContext = makeToolContext(artifactService);
      const service = new ForwardingArtifactService(toolContext);

      const request: ListVersionsRequest = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'file.txt',
      };

      const result = await service.listArtifactVersions(request);
      expect(artifactService.listArtifactVersions).toHaveBeenCalledWith(
        request,
      );
      expect(result).toEqual(versions);
    });

    it('throws when artifactService is undefined', () => {
      const toolContext = makeToolContext(undefined);
      const service = new ForwardingArtifactService(toolContext);

      expect(() =>
        service.listArtifactVersions({
          appName: 'app',
          userId: 'user',
          sessionId: 'session',
          filename: 'file.txt',
        }),
      ).toThrow('Artifact service is not initialized.');
    });
  });

  describe('getArtifactVersion', () => {
    it('delegates to invocationContext.artifactService.getArtifactVersion', async () => {
      const artifactService = makeArtifactServiceStub();
      const versionMeta = {version: 1, mimeType: 'text/plain'};
      artifactService.getArtifactVersion.mockResolvedValue(versionMeta);
      const toolContext = makeToolContext(artifactService);
      const service = new ForwardingArtifactService(toolContext);

      const request: LoadArtifactRequest = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'file.txt',
        version: 1,
      };

      const result = await service.getArtifactVersion(request);
      expect(artifactService.getArtifactVersion).toHaveBeenCalledWith(request);
      expect(result).toEqual(versionMeta);
    });

    it('throws when artifactService is undefined', () => {
      const toolContext = makeToolContext(undefined);
      const service = new ForwardingArtifactService(toolContext);

      expect(() =>
        service.getArtifactVersion({
          appName: 'app',
          userId: 'user',
          sessionId: 'session',
          filename: 'file.txt',
          version: 0,
        }),
      ).toThrow('Artifact service is not initialized.');
    });
  });
});
