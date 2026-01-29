/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {
  getTempDir,
  isFile,
  isFolderExists,
  loadFileData,
  saveToFile,
  tryToFindFileRecursively,
} from '../../src/utils/file_utils.js';

vi.mock('node:fs/promises', async () => {
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
  };
});

vi.mock('node:os', async () => {
  return {
    tmpdir: vi.fn(),
  };
});

describe('file_utils', () => {
  let fsPromises: {
    readFile: Mock;
    writeFile: Mock;
    unlink: Mock;
    access: Mock;
    stat: Mock;
  };
  let osMock: {tmpdir: Mock};

  const testPath = '/tmp/test.txt';
  const testContent = 'Hello, world!';

  beforeEach(async () => {
    vi.clearAllMocks();
    fsPromises = (await import('node:fs/promises')) as unknown as {
      readFile: Mock;
      writeFile: Mock;
      unlink: Mock;
      access: Mock;
      stat: Mock;
    };
    osMock = (await import('node:os')) as unknown as {tmpdir: Mock};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isFolderExists returns true when access resolves', async () => {
    fsPromises.access.mockResolvedValue(undefined);
    await expect(isFolderExists('/some/dir')).resolves.toBe(true);
  });

  it('isFolderExists returns false when access rejects', async () => {
    fsPromises.access.mockRejectedValue(new Error('no access'));
    await expect(isFolderExists('/no/dir')).resolves.toBe(false);
  });

  it('isFile returns true when stat.isFile is true', async () => {
    fsPromises.stat.mockResolvedValue({isFile: () => true});
    await expect(isFile('/some/file')).resolves.toBe(true);
  });

  it('isFile returns false when stat rejects', async () => {
    fsPromises.stat.mockRejectedValue(new Error('not found'));
    await expect(isFile('/missing/file')).resolves.toBe(false);
  });

  it('loadFileData parses JSON and returns the object', async () => {
    const obj = {hello: 'world'};
    fsPromises.readFile.mockResolvedValue(JSON.stringify(obj));
    await expect(loadFileData<{hello: string}>(testPath)).resolves.toEqual(obj);
  });

  it('loadFileData throws when readFile rejects', async () => {
    fsPromises.readFile.mockRejectedValue(new Error('read error'));
    await expect(loadFileData(testPath)).rejects.toThrow('read error');
  });

  it('saveToFile writes string data as-is', async () => {
    fsPromises.writeFile.mockResolvedValue(undefined);
    await expect(saveToFile(testPath, testContent)).resolves.toBeUndefined();
    expect(fsPromises.writeFile).toHaveBeenCalledWith(testPath, testContent, {
      encoding: 'utf-8',
    });
  });

  it('saveToFile writes objects as pretty JSON', async () => {
    const data = {a: 1};
    fsPromises.writeFile.mockResolvedValue(undefined);
    await expect(saveToFile('/tmp/data.json', data)).resolves.toBeUndefined();
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      '/tmp/data.json',
      JSON.stringify(data, null, 2),
      {encoding: 'utf-8'},
    );
  });

  it('getTempDir uses os.tmpdir and optional prefix and Date.now', () => {
    osMock.tmpdir.mockReturnValue('/tmp');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    const dir = getTempDir('myprefix');
    expect(dir).toBe(path.join('/tmp', 'myprefix', '1234567890'));
    nowSpy.mockRestore();
  });

  it('tryToFindFileRecursively finds a file in a parent folder', async () => {
    fsPromises.access.mockImplementation((p: string) => {
      if (p.endsWith(path.join('/a', 'target.txt'))) {
        return Promise.resolve();
      }
      return Promise.reject(new Error('not found'));
    });

    const found = await tryToFindFileRecursively('/a/b/c', 'target.txt', 5);
    expect(found).toBe(path.join('/a', 'target.txt'));
  });

  it('tryToFindFileRecursively throws when file not found within maxIterations', async () => {
    fsPromises.access.mockRejectedValue(new Error('not found'));
    await expect(
      tryToFindFileRecursively('/a/b/c', 'target.txt', 2),
    ).rejects.toThrow(/No target.txt found/);
  });
});
