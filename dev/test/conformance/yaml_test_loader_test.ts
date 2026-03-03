/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fg from 'fast-glob';
import * as fs from 'node:fs/promises';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {batchLoadYamlTestDefs} from '../../src/conformance/yaml_test_loader.js';

// Mock fast-glob
vi.mock('fast-glob', () => ({
  default: {
    stream: vi.fn(),
  },
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const SPEC_YAML = `
description: Test description
agent: test-agent
initial_state:
  key: value
user_messages:
  - text: hello
`;

const SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
events:
  - author: user
    content:
      parts:
        - text: hello
`;

const RECORDINGS_YAML = `
recordings:
  - user_message_index: 0
    agent_name: test-agent
    llm_recording:
      llm_response:
        content:
          parts:
            - text: hi
`;

describe('batchLoadYamlTestDefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Silence console.log during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should load and parse test definitions recursively', async () => {
    const rootDir = '/root/tests';
    const mockFiles = ['/root/tests/category/test1/spec.yaml'];

    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    (fs.readFile as Mock).mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('spec.yaml')) return SPEC_YAML;
      if (filePath.endsWith('generated-session.yaml')) return SESSION_YAML;
      if (filePath.endsWith('generated-recordings.yaml'))
        return RECORDINGS_YAML;
      throw new Error(`File not found: ${filePath}`);
    });

    const tests = await batchLoadYamlTestDefs(rootDir);

    expect(fg.stream).toHaveBeenCalledWith('**/spec.{yaml,yml}', {
      cwd: rootDir,
      absolute: true,
    });

    expect(tests.size).toBe(1);
    const test = tests.get('category/test1');
    expect(test).toBeDefined();
    expect(test?.name).toBe('category/test1');

    // Check spec parsing and camelCase conversion
    expect(test?.spec).toMatchObject({
      description: 'Test description',
      agent: 'test-agent',
      initialState: {key: 'value'},
      userMessages: [{text: 'hello'}],
    });

    // Check session parsing and camelCase conversion
    expect(test?.session).toMatchObject({
      appName: 'test-app',
      userId: 'user-1',
      id: 'session-1',
    });

    // Check recordings parsing and camelCase conversion
    expect(test?.recordings.recordings[0]).toMatchObject({
      userMessageIndex: 0,
      agentName: 'test-agent',
    });
  });

  it('should handle multiple tests in different directories', async () => {
    const rootDir = '/root/tests';
    const mockFiles = ['/root/tests/t1/spec.yaml', '/root/tests/t2/spec.yaml'];

    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);
    (fs.readFile as Mock).mockResolvedValue('{}');

    const tests = await batchLoadYamlTestDefs(rootDir);
    expect(tests.size).toBe(2);
    expect(tests.has('t1')).toBe(true);
    expect(tests.has('t2')).toBe(true);
  });

  it('should load and parse test definitions with Windows-style paths', async () => {
    const rootDir = 'C:\\root\\tests';
    const mockFiles = ['C:\\root\\tests\\category\\test1\\spec.yaml'];

    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    (fs.readFile as Mock).mockImplementation(async (filePath: string) => {
      if (filePath.includes('spec.yaml')) return SPEC_YAML;
      if (filePath.includes('generated-session.yaml')) return SESSION_YAML;
      if (filePath.includes('generated-recordings.yaml'))
        return RECORDINGS_YAML;
      throw new Error(`File not found: ${filePath}`);
    });

    const tests = await batchLoadYamlTestDefs(rootDir);

    expect(fg.stream).toHaveBeenCalledWith('**/spec.{yaml,yml}', {
      cwd: rootDir,
      absolute: true,
    });

    expect(tests.size).toBe(1);
    const expectedKey = 'category/test1';
    const test = tests.get(expectedKey);
    expect(test).toBeDefined();
    expect(test?.name).toBe(expectedKey);
    expect(test?.spec.agent).toBe('test-agent');
  });

  it('should throw an error if a required file is missing', async () => {
    const rootDir = '/root/tests';
    (fg.stream as unknown as Mock).mockReturnValue([
      '/root/tests/t1/spec.yaml',
    ]);
    (fs.readFile as Mock).mockRejectedValue(new Error('File not found'));

    await expect(batchLoadYamlTestDefs(rootDir)).rejects.toThrow(
      'File not found',
    );
  });
});
