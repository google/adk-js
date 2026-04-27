/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session} from '@google/adk';
import camelcaseKeys from 'camelcase-keys';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {Recordings, TestInfo, TestSpec} from '../integration/test_types.js';

/**
 * batchLoadYamlTestDefs will recursively search the directory given
 * and load all of the YAML files into in-memory config.
 */
export async function batchLoadYamlTestDefs(
  directory: string,
): Promise<Map<string, TestInfo>> {
  // Tests have 3 parts:
  //
  // 1. spec.yaml - the defined test config and input
  // 2. generated-recordings.yaml - the recorded event information
  // 3. generated-session.yaml - the recorded session information
  //
  // Assume any directory with a spec.yaml is a test with all 3 files
  const files = fg.stream('**/spec.{yaml,yml}', {
    cwd: directory,
    absolute: true,
  });
  const tests = new Map<string, TestInfo>();

  for await (const file of files) {
    // Normalize paths to POSIX to ensure consistent behavior across platforms
    // and when handling Windows paths.
    const normalizedFile = (file as string).replaceAll('\\', '/');

    // Test directory
    const baseDir = path.posix.dirname(normalizedFile);

    // Spec file
    const specFile = path.posix.join(baseDir, 'spec.yaml');
    const filePath = specFile;
    const content = await fs.readFile(filePath, 'utf-8');
    const parsedSpec = yaml.load(content);
    if (typeof parsedSpec !== 'object' || parsedSpec === null) {
      throw new Error('Spec file must be a YAML mapping');
    }
    const testSpec = camelcaseKeys(parsedSpec, {
      deep: true,
    }) as TestSpec;

    // Session file
    const sessionFile = path.posix.join(baseDir, 'generated-session.yaml');
    const sessionContent = await fs.readFile(sessionFile, 'utf-8');
    const parsedSession = yaml.load(sessionContent);
    if (typeof parsedSession !== 'object' || parsedSession === null) {
      throw new Error('Session file must be a YAML mapping');
    }
    const session = camelcaseKeys(parsedSession, {
      deep: true,
    }) as Session;

    // Recordings file
    const recordingsFile = path.posix.join(
      baseDir,
      'generated-recordings.yaml',
    );
    const recordingsContent = await fs.readFile(recordingsFile, 'utf-8');
    const parsedRecordings = yaml.load(recordingsContent);
    if (typeof parsedRecordings !== 'object' || parsedRecordings === null) {
      throw new Error('Recording file must be a YAML mapping');
    }
    const recordings = camelcaseKeys(parsedRecordings, {
      deep: true,
    }) as Recordings;

    // Make test names unique by including relative file path from given root dir
    const normalizedDir = directory.replaceAll('\\', '/');
    const relativePath = path.posix.relative(normalizedDir, baseDir);
    const parsedPath = path.posix.parse(relativePath);
    const name = path.posix.join(parsedPath.dir, parsedPath.name);

    tests.set(name, {
      name: name,
      spec: testSpec,
      session: session,
      recordings: recordings,
    });

    console.log('loaded test', name, 'from', baseDir);
  }

  return tests;
}
