/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EditFileTool} from '../../../src/tools/environment/edit_file_tool.js';
import {EnvironmentToolset} from '../../../src/tools/environment/environment_toolset.js';
import {ExecuteTool} from '../../../src/tools/environment/execute_tool.js';
import {ReadFileTool} from '../../../src/tools/environment/read_file_tool.js';
import {
  resolveAndValidatePath,
  truncate,
} from '../../../src/tools/environment/utils.js';
import {WriteFileTool} from '../../../src/tools/environment/write_file_tool.js';

describe('Environment Tools Parity', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-env-tools-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true});
  });

  describe('utils', () => {
    it('truncates correctly', () => {
      expect(truncate('1234567890', 5)).toBe(
        '12345\n... (truncated to 10 chars)',
      );
      expect(truncate('12', 5)).toBe('12');
      expect(truncate('1234567890', 0)).toBe('');
    });

    it('validates paths to not escape working dir', () => {
      expect(() => resolveAndValidatePath(tmpDir, '../root')).toThrowError(
        'escapes',
      );
      expect(() => resolveAndValidatePath(tmpDir, '/etc/passwd')).toThrowError(
        'escapes',
      );
      expect(resolveAndValidatePath(tmpDir, 'ok/file.txt')).toBe(
        path.join(tmpDir, 'ok', 'file.txt'),
      );
    });
  });

  describe('ExecuteTool', () => {
    // `cmd.exe` terminates lines with CRLF and preserves the trailing space
    // before `&&`, so normalize shell output before comparing.
    const normalizeShellOutput = (value: string) =>
      value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');

    it('executes successfully', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir});
      expect(tool._getDeclaration()).toBeDefined();

      let res: any = await tool.runAsync({args: {}, toolContext: {} as any});
      expect(res.status).toBe('error');

      res = await tool.runAsync({
        args: {command: 'echo test && echo err >&2'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('ok');
      expect(normalizeShellOutput(res.stdout)).toBe('test\n');
      expect(normalizeShellOutput(res.stderr)).toBe('err\n');
    });

    it('reports failure on nonzero exit code with stdout/err', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir});
      const res: any = await tool.runAsync({
        args: {command: 'echo out && echo err >&2 && exit 10'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.exit_code).toBe(10);
      expect(normalizeShellOutput(res.stdout)).toBe('out\n');
      expect(normalizeShellOutput(res.stderr)).toBe('err\n');
    });

    it('reports timeout', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir, executeTimeoutMs: 100});
      const res: any = await tool.runAsync({
        args: {command: 'sleep 1'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.error).toMatch(/timed out/i);
    });

    it('handles spawn errors and includes stdout/stderr on exit code', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir});
      const res: any = await tool.runAsync({
        args: {command: 'non_existent_command_123'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
    });
  });

  describe('WriteFileTool', () => {
    it('writes files', async () => {
      const tool = new WriteFileTool({workingDir: tmpDir});
      expect(tool._getDeclaration()).toBeDefined();

      const res: any = await tool.runAsync({
        args: {path: 'test.txt', content: 'hello'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('ok');
      const content = await fs.readFile(path.join(tmpDir, 'test.txt'), 'utf8');
      expect(content).toBe('hello');
    });

    it('fails if path invalid', async () => {
      const tool = new WriteFileTool({workingDir: tmpDir});
      const res: any = await tool.runAsync({
        args: {path: '../test.txt', content: 'hello'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
    });

    it('fails on missing arguments', async () => {
      const tool = new WriteFileTool({workingDir: tmpDir});
      let res: any = await tool.runAsync({args: {}, toolContext: {} as any});
      expect(res.status).toBe('error');
      expect(res.error).toContain('path');

      res = await tool.runAsync({
        args: {path: 'test.txt'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('content');
    });

    it('handles write errors', async () => {
      const tool = new WriteFileTool({
        workingDir: '/invalid/path/that/does_not_exist',
      });
      const res: any = await tool.runAsync({
        args: {path: 'test.txt', content: 'hello'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
    });
  });

  describe('ReadFileTool', () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(tmpDir, 'lines.txt'),
        'line1\nline2\nline3\nline4',
        'utf8',
      );
    });

    it('reads all lines', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      expect(tool._getDeclaration()).toBeDefined();

      const res: any = await tool.runAsync({
        args: {path: 'lines.txt'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('ok');
      expect(res.content).toContain('1\tline1\n');
      expect(res.content).toContain('4\tline4');
    });

    it('reads specific lines', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      const res: any = await tool.runAsync({
        args: {path: 'lines.txt', start_line: 2, end_line: 3},
        toolContext: {} as any,
      });
      expect(res.status).toBe('ok');
      expect(res.content.trim()).toBe('2\tline2\n     3\tline3'.trim());
      expect(res.total_lines).toBe(4);
    });

    it('handles out of bounds', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      let res: any = await tool.runAsync({
        args: {path: 'lines.txt', start_line: 10},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.total_lines).toBe(4);

      res = await tool.runAsync({
        args: {path: 'lines.txt', start_line: 2, end_line: 1},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
    });

    it('fails if path invalid or missing', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      let res: any = await tool.runAsync({args: {}, toolContext: {} as any});
      expect(res.status).toBe('error');

      res = await tool.runAsync({
        args: {path: '../escape'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
    });

    it('fails if file not found or read error', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      let res: any = await tool.runAsync({
        args: {path: 'notfound.txt'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('File not found');

      // non-ENOENT error (like EISDIR)
      res = await tool.runAsync({args: {path: '.'}, toolContext: {} as any});
      expect(res.status).toBe('error');
    });

    it('validates args', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      const res: any = await tool.runAsync({
        args: {path: 'lines.txt', start_line: 'not_number'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('integer');
    });
  });

  describe('EditFileTool', () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(tmpDir, 'edit.txt'),
        'hello world\nhello universe\n',
        'utf8',
      );
    });

    it('replaces exact match', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      expect(tool._getDeclaration()).toBeDefined();

      const res: any = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'world', new_string: 'mars'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('ok');

      const content = await fs.readFile(path.join(tmpDir, 'edit.txt'), 'utf8');
      expect(content).toContain('hello mars');
      expect(content).toContain('universe');
    });

    it('fails if non-unique match', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      const res: any = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'hello', new_string: 'hi'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('appears 2 times');
    });

    it('fails if zero matches', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      const res: any = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'notfound', new_string: 'hi'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('not found');
    });

    it('validates args', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      let res: any = await tool.runAsync({
        args: {path: 'edit.txt', old_string: '', new_string: 'hi'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('cannot be empty');

      res = await tool.runAsync({args: {}, toolContext: {} as any});
      expect(res.status).toBe('error');

      res = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'hello'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
    });

    it('fails if path invalid or file does not exist', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      let res: any = await tool.runAsync({
        args: {path: '../escape', old_string: 'h', new_string: 'b'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');

      res = await tool.runAsync({
        args: {path: 'missing.txt', old_string: 'h', new_string: 'b'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('File not found');

      res = await tool.runAsync({
        args: {path: '.', old_string: 'h', new_string: 'b'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
    });

    it('handles write errors', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});

      // We need to trigger an error writing to an existing file.
      // We can make the file read-only!
      await fs.chmod(path.join(tmpDir, 'edit.txt'), 0o444);
      const res: any = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'world', new_string: 'mars'},
        toolContext: {} as any,
      });
      expect(res.status).toBe('error');
    });
  });

  describe('EnvironmentToolset', () => {
    it('provides tools and injects instructions', async () => {
      const set = new EnvironmentToolset({workingDir: tmpDir});
      const tools = await set.getTools();
      expect(tools.length).toBe(4);
      expect(tools.some((t) => t.name === 'Execute')).toBe(true);

      const request: any = {
        config: {},
        toolsDict: {},
        contents: [],
      };
      const appendInstructionsSpy = vi.fn();

      // Override or mock it? No, wait! `appendInstructions` is a utility method imported by the toolset.
      // Wait, let's just observe if the config is updated! The actual `appendInstructions` method updates llmRequest.config.systemInstruction.

      await set.processLlmRequest({} as any, request);
      expect(request.config.systemInstruction).toContain('Environment Rules');
      expect(request.config.systemInstruction).toContain(tmpDir);
    });

    it('returns filtered and unfiltered tools', async () => {
      const set = new EnvironmentToolset({
        workingDir: tmpDir,
        toolFilter: ['Execute'],
      });
      let tools = await set.getTools(); // no context, unfiltered
      expect(tools.length).toBeGreaterThan(1);

      tools = await set.getTools({} as any); // filtered
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('Execute');
    });

    it('closes without error', async () => {
      const set = new EnvironmentToolset({workingDir: tmpDir});
      await expect(set.close()).resolves.toBeUndefined();
    });
  });
});
