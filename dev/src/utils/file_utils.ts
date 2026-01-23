/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Check if the given folder exists. */
export async function isFolderExists(folderPath: string): Promise<boolean> {
  try {
    await fs.access(folderPath);
    return true;
  } catch (e: unknown) {
    return false;
  }
}

/** Create a new folder at the specific path */
export async function createFolder(folderPath: string): Promise<void> {
  try {
    await fs.mkdir(folderPath);
  } catch (e) {
    console.error(`Failed to create folder ${folderPath}`, e);
  }
}

/** Remove a folder at the specified location */
export async function removeFolder(folderPath: string): Promise<void> {
  try {
    await fs.rm(folderPath, {recursive: true});
  } catch (e) {
    console.error(`Failed to remove folder ${folderPath}`, e);
  }
}

/** List files within a directory */
export async function listFiles(folderPath: string): Promise<string[]> {
  try {
    return await fs.readdir(folderPath);
  } catch (e) {
    console.error(`Failed to list files in folder ${folderPath}`, e);

    return [];
  }
}

/** Check if the given path is a file. */
export async function isFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (e: unknown) {
    return false;
  }
}

/** Load data from a file in JSON format. */
export async function loadFileData<T>(filePath: string): Promise<T|undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, {encoding: 'utf-8'})) as T;
  } catch (e) {
    console.error(`Failed to read or parse file ${filePath}:`, e);

    throw e;
  }
}

/** Save data to a file in JSON format. */
export async function saveToFile<T>(filePath: string, data: T): Promise<void> {
  try {
    await fs.writeFile(
        filePath,
        typeof data === 'string' ? data : JSON.stringify(data, null, 2),
        {encoding: 'utf-8'});
  } catch (e) {
    console.error(`Failed to write file ${filePath}:`, e);

    throw e;
  }
}

/**
 * Return a temporary directory path.
 * @param prefix Optional prefix for the temp directory
 * @returns
 */
export function getTempDir(prefix?: string): string {
  const pathParts = [os.tmpdir()];

  if (prefix) {
    pathParts.push(prefix);
  }

  pathParts.push(Date.now().toString());

  return path.join(...pathParts);
}

/**
 * Try to find a file recursively in the given folder.
 * @param sourceFolder The folder to search in.
 * @param fileName The name of the file to find.
 * @param maxIterations The maximum number of iterations to perform.
 * @returns The absolute path of the found file.
 * @throws Error if the file is not found after the maximum number of
 *     iterations.
 */
export async function tryToFindFileRecursively(
    sourceFolder: string,
    fileName: string,
    maxIterations: number,
    ): Promise<string> {
  let currentFolder = sourceFolder;

  for (let i = 0; i < maxIterations; i++) {
    const filePath = path.join(currentFolder, fileName);

    if (await isFolderExists(filePath)) {
      return filePath;
    }

    currentFolder = path.join(currentFolder, '../');
  }

  throw new Error(`No ${fileName} found in ${
      sourceFolder} or its parent folders up to ${maxIterations} levels.`);
};