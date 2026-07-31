/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  EditFileTool,
  EnvironmentToolset,
  ExecuteResult,
  ExecuteTool,
  InvocationContext,
  LlmRequest,
  ReadFileTool,
  ToolConfirmation,
  WriteFileTool,
} from '@google/adk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// `truncate`, `toError` and `resolveAndValidatePath` are implementation
// details and are deliberately not part of the package's public surface, so
// they are imported from their modules directly.
import {toError, truncate} from '../../../src/tools/environment/utils.js';
import {resolveAndValidatePath} from '../../../src/utils/file_utils.js';

const FUNCTION_CALL_ID = 'fc-1';

const IS_WINDOWS = os.platform() === 'win32';

/**
 * PowerShell start-up dominates these runs, and a cold Windows CI agent can
 * take several seconds before the first statement executes.
 */
const WINDOWS_SHELL_TIMEOUT_MS = 60_000;

const REQUIRE_CONFIRMATION_MESSAGE =
  'This tool call needs external confirmation before completion.';

/**
 * Builds the `Context` the framework hands to a tool call. Only the fields the
 * environment tools read are populated; the surrounding invocation is stubbed,
 * matching `run_skill_inline_script_tool_test.ts`.
 */
function createContext(toolConfirmation?: ToolConfirmation): Context {
  return new Context({
    invocationContext: {
      session: {state: {}},
      agent: {name: 'test-agent'},
    } as unknown as InvocationContext,
    functionCallId: FUNCTION_CALL_ID,
    toolConfirmation,
  });
}

/** A context whose tool call the client has already approved. */
function confirmedContext(): Context {
  return createContext(new ToolConfirmation({confirmed: true}));
}

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
        '12345\n... (truncated, 10 total chars)',
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

    it('normalizes thrown values to Error', () => {
      const err = new Error('boom');
      expect(toError(err)).toBe(err);
      expect(toError('boom').message).toBe('boom');
    });
  });

  describe('ExecuteTool', () => {
    // `cmd.exe` terminates lines with CRLF and preserves the trailing space
    // before `&&`, so normalize shell output before comparing.
    const normalizeShellOutput = (value: string) =>
      value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');

    /**
     * Runs the tool with an approved confirmation and narrows away the
     * confirmation-pending branch of the result union.
     */
    async function runExecute(
      tool: ExecuteTool,
      args: Record<string, unknown>,
    ): Promise<ExecuteResult> {
      const res = await tool.runAsync({args, toolContext: confirmedContext()});
      if (!('status' in res)) {
        throw new Error('Execute unexpectedly paused for confirmation.');
      }
      return res;
    }

    it('executes successfully', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir});
      expect(tool._getDeclaration()).toBeDefined();

      const missingArgs = await runExecute(tool, {});
      expect(missingArgs.status).toBe('error');

      const res = await runExecute(tool, {
        command: 'echo test && echo err >&2',
      });
      expect(res.status).toBe('ok');
      expect(normalizeShellOutput(res.stdout ?? '')).toBe('test\n');
      expect(normalizeShellOutput(res.stderr ?? '')).toBe('err\n');
    });

    it('reports failure on nonzero exit code with stdout/err', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir});
      const res = await runExecute(tool, {
        command: 'echo out && echo err >&2 && exit 10',
      });
      expect(res.status).toBe('error');
      expect(res.exit_code).toBe(10);
      expect(normalizeShellOutput(res.stdout ?? '')).toBe('out\n');
      expect(normalizeShellOutput(res.stderr ?? '')).toBe('err\n');
    });

    it('reports timeout', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir, executeTimeoutMs: 100});
      const res = await runExecute(tool, {command: 'sleep 1'});
      expect(res.status).toBe('error');
      expect(res.error).toMatch(/timed out/i);
    });

    it('handles spawn errors and includes stdout/stderr on exit code', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir});
      const res = await runExecute(tool, {command: 'non_existent_command_123'});
      expect(res.status).toBe('error');
    });

    it('requests confirmation and runs nothing until it is granted', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir});
      const toolContext = createContext();

      const res = await tool.runAsync({
        args: {command: 'echo marker > marker.txt'},
        toolContext,
      });

      expect(res).toEqual({partial: REQUIRE_CONFIRMATION_MESSAGE});
      expect(
        toolContext.actions.requestedToolConfirmations[FUNCTION_CALL_ID],
      ).toBeDefined();
      await expect(
        fs.access(path.join(tmpDir, 'marker.txt')),
      ).rejects.toThrowError();
    });

    it('refuses to run when the confirmation was rejected', async () => {
      const tool = new ExecuteTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {command: 'echo marker > marker.txt'},
        toolContext: createContext(new ToolConfirmation({confirmed: false})),
      });

      expect(res).toEqual({
        status: 'error',
        error: 'Command execution was not confirmed and was rejected.',
      });
      await expect(
        fs.access(path.join(tmpDir, 'marker.txt')),
      ).rejects.toThrowError();
    });

    describe('shell selection', () => {
      it.skipIf(IS_WINDOWS)(
        'hands the command to the configured shell instead of the default',
        async () => {
          // A stand-in shell that echoes back the command it was invoked
          // with. `child_process.exec` runs `<shell> -c <command>`, so the
          // command lands in `$2`. Seeing it here proves the configured shell
          // ran the command rather than the platform default.
          const fakeShell = path.join(tmpDir, 'fake-shell.sh');
          await fs.writeFile(
            fakeShell,
            '#!/bin/sh\necho "fake-shell ran: $2"\n',
            'utf8',
          );
          await fs.chmod(fakeShell, 0o755);

          const tool = new ExecuteTool({workingDir: tmpDir, shell: fakeShell});
          const res = await runExecute(tool, {command: 'echo hello'});

          expect(res.status).toBe('ok');
          expect((res.stdout ?? '').trim()).toBe('fake-shell ran: echo hello');
        },
      );

      it.skipIf(!IS_WINDOWS)(
        'runs through cmd.exe by default on Windows',
        async () => {
          // `%VAR%` is only expanded by `cmd.exe`; PowerShell and POSIX
          // shells would echo the text back verbatim.
          const tool = new ExecuteTool({workingDir: tmpDir});
          const res = await runExecute(tool, {command: 'echo %COMSPEC%'});

          expect(res.status).toBe('ok');
          expect((res.stdout ?? '').toLowerCase()).toContain('cmd.exe');
        },
        WINDOWS_SHELL_TIMEOUT_MS,
      );

      it.skipIf(!IS_WINDOWS)(
        'runs through cmd.exe when it is selected explicitly',
        async () => {
          const tool = new ExecuteTool({
            workingDir: tmpDir,
            shell: 'cmd.exe',
            executeTimeoutMs: WINDOWS_SHELL_TIMEOUT_MS,
          });
          const res = await runExecute(tool, {
            command: 'echo %COMSPEC% && exit 0',
          });

          expect(res.status).toBe('ok');
          expect((res.stdout ?? '').toLowerCase()).toContain('cmd.exe');
        },
        WINDOWS_SHELL_TIMEOUT_MS,
      );

      it.skipIf(!IS_WINDOWS)(
        'runs through powershell when it is selected',
        async () => {
          // `Write-Output` and parenthesised arithmetic are PowerShell
          // syntax; `cmd.exe` would report an unrecognised command.
          const tool = new ExecuteTool({
            workingDir: tmpDir,
            shell: 'powershell.exe',
            executeTimeoutMs: WINDOWS_SHELL_TIMEOUT_MS,
          });
          const res = await runExecute(tool, {command: 'Write-Output (3 + 4)'});

          expect(res.status).toBe('ok');
          expect(
            (res.stdout ?? '').split(/\r?\n/).map((l) => l.trim()),
          ).toContain('7');
        },
        WINDOWS_SHELL_TIMEOUT_MS * 2,
      );

      it.skipIf(!IS_WINDOWS)(
        'reports a nonzero exit code from powershell',
        async () => {
          const tool = new ExecuteTool({
            workingDir: tmpDir,
            shell: 'powershell.exe',
            executeTimeoutMs: WINDOWS_SHELL_TIMEOUT_MS,
          });
          const res = await runExecute(tool, {command: 'exit 3'});

          expect(res.status).toBe('error');
          expect(res.exit_code).toBe(3);
        },
        WINDOWS_SHELL_TIMEOUT_MS * 2,
      );
    });
  });

  describe('WriteFileTool', () => {
    it('writes files', async () => {
      const tool = new WriteFileTool({workingDir: tmpDir});
      expect(tool._getDeclaration()).toBeDefined();

      const res = await tool.runAsync({
        args: {path: 'test.txt', content: 'hello'},
        toolContext: createContext(),
      });
      expect(res.status).toBe('ok');
      const content = await fs.readFile(path.join(tmpDir, 'test.txt'), 'utf8');
      expect(content).toBe('hello');
    });

    it('fails if path invalid', async () => {
      const tool = new WriteFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {path: '../test.txt', content: 'hello'},
        toolContext: createContext(),
      });
      expect(res.status).toBe('error');
    });

    it('fails on missing arguments', async () => {
      const tool = new WriteFileTool({workingDir: tmpDir});
      const missingPath = await tool.runAsync({
        args: {},
        toolContext: createContext(),
      });
      expect(missingPath.status).toBe('error');
      expect(missingPath.error).toContain('path');

      const missingContent = await tool.runAsync({
        args: {path: 'test.txt'},
        toolContext: createContext(),
      });
      expect(missingContent.status).toBe('error');
      expect(missingContent.error).toContain('content');
    });

    it('handles write errors', async () => {
      const tool = new WriteFileTool({
        workingDir: '/invalid/path/that/does_not_exist',
      });
      const res = await tool.runAsync({
        args: {path: 'test.txt', content: 'hello'},
        toolContext: createContext(),
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

      const res = await tool.runAsync({
        args: {path: 'lines.txt'},
        toolContext: createContext(),
      });
      expect(res.status).toBe('ok');
      expect(res.content).toContain('1\tline1\n');
      expect(res.content).toContain('4\tline4');
    });

    it('reads specific lines', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {path: 'lines.txt', start_line: 2, end_line: 3},
        toolContext: createContext(),
      });
      expect(res.status).toBe('ok');
      expect((res.content ?? '').trim()).toBe('2\tline2\n     3\tline3'.trim());
      expect(res.total_lines).toBe(4);
    });

    it('handles out of bounds', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      const pastEnd = await tool.runAsync({
        args: {path: 'lines.txt', start_line: 10},
        toolContext: createContext(),
      });
      expect(pastEnd.status).toBe('error');
      expect(pastEnd.total_lines).toBe(4);

      const inverted = await tool.runAsync({
        args: {path: 'lines.txt', start_line: 2, end_line: 1},
        toolContext: createContext(),
      });
      expect(inverted.status).toBe('error');
    });

    it('fails if path invalid or missing', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      const missingPath = await tool.runAsync({
        args: {},
        toolContext: createContext(),
      });
      expect(missingPath.status).toBe('error');

      const escaping = await tool.runAsync({
        args: {path: '../escape'},
        toolContext: createContext(),
      });
      expect(escaping.status).toBe('error');
    });

    it('fails if file not found or read error', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      const notFound = await tool.runAsync({
        args: {path: 'notfound.txt'},
        toolContext: createContext(),
      });
      expect(notFound.status).toBe('error');
      expect(notFound.error).toContain('File not found');

      // non-ENOENT error (like EISDIR)
      const directory = await tool.runAsync({
        args: {path: '.'},
        toolContext: createContext(),
      });
      expect(directory.status).toBe('error');
    });

    it('validates args', async () => {
      const tool = new ReadFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {path: 'lines.txt', start_line: 'not_number'},
        toolContext: createContext(),
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

      const res = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'world', new_string: 'mars'},
        toolContext: createContext(),
      });
      expect(res.status).toBe('ok');

      const content = await fs.readFile(path.join(tmpDir, 'edit.txt'), 'utf8');
      expect(content).toContain('hello mars');
      expect(content).toContain('universe');
    });

    it('matches old_string literally rather than as a regex', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'meta.txt'),
        'value = compute(a.b)\n',
        'utf8',
      );
      const tool = new EditFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {
          path: 'meta.txt',
          old_string: 'compute(a.b)',
          new_string: 'compute(c)',
        },
        toolContext: createContext(),
      });
      expect(res.status).toBe('ok');
      expect(await fs.readFile(path.join(tmpDir, 'meta.txt'), 'utf8')).toBe(
        'value = compute(c)\n',
      );
    });

    it('does not edit text that only matches when metacharacters are live', async () => {
      await fs.writeFile(path.join(tmpDir, 'meta.txt'), 'axb\n', 'utf8');
      const tool = new EditFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {path: 'meta.txt', old_string: 'a.b', new_string: 'zzz'},
        toolContext: createContext(),
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('not found');
      expect(await fs.readFile(path.join(tmpDir, 'meta.txt'), 'utf8')).toBe(
        'axb\n',
      );
    });

    it('reports an unbalanced old_string as a missing match, not a crash', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'foo(bar', new_string: 'x'},
        toolContext: createContext(),
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('not found');
    });

    it('inserts new_string literally when it contains $ patterns', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {
          path: 'edit.txt',
          old_string: 'world',
          new_string: 'cost is $& dollars',
        },
        toolContext: createContext(),
      });
      expect(res.status).toBe('ok');
      const content = await fs.readFile(path.join(tmpDir, 'edit.txt'), 'utf8');
      expect(content).toContain('hello cost is $& dollars');
    });

    it('fails if non-unique match', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'hello', new_string: 'hi'},
        toolContext: createContext(),
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('appears 2 times');
    });

    it('fails if zero matches', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      const res = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'notfound', new_string: 'hi'},
        toolContext: createContext(),
      });
      expect(res.status).toBe('error');
      expect(res.error).toContain('not found');
    });

    it('validates args', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      const emptyOldString = await tool.runAsync({
        args: {path: 'edit.txt', old_string: '', new_string: 'hi'},
        toolContext: createContext(),
      });
      expect(emptyOldString.status).toBe('error');
      expect(emptyOldString.error).toContain('cannot be empty');

      const noArgs = await tool.runAsync({
        args: {},
        toolContext: createContext(),
      });
      expect(noArgs.status).toBe('error');

      const missingNewString = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'hello'},
        toolContext: createContext(),
      });
      expect(missingNewString.status).toBe('error');
    });

    it('fails if path invalid or file does not exist', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});
      const escaping = await tool.runAsync({
        args: {path: '../escape', old_string: 'h', new_string: 'b'},
        toolContext: createContext(),
      });
      expect(escaping.status).toBe('error');

      const missingFile = await tool.runAsync({
        args: {path: 'missing.txt', old_string: 'h', new_string: 'b'},
        toolContext: createContext(),
      });
      expect(missingFile.status).toBe('error');
      expect(missingFile.error).toContain('File not found');

      const directory = await tool.runAsync({
        args: {path: '.', old_string: 'h', new_string: 'b'},
        toolContext: createContext(),
      });
      expect(directory.status).toBe('error');
    });

    it('handles write errors', async () => {
      const tool = new EditFileTool({workingDir: tmpDir});

      // We need to trigger an error writing to an existing file.
      // We can make the file read-only!
      await fs.chmod(path.join(tmpDir, 'edit.txt'), 0o444);
      const res = await tool.runAsync({
        args: {path: 'edit.txt', old_string: 'world', new_string: 'mars'},
        toolContext: createContext(),
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

      // `appendInstructions` writes through to `config.systemInstruction`, so
      // the injected instruction is observable on the request itself.
      const request: LlmRequest = {
        config: {},
        toolsDict: {},
        contents: [],
        liveConnectConfig: {},
      };

      await set.processLlmRequest(createContext(), request);
      expect(request.config?.systemInstruction).toContain('Environment Rules');
      expect(request.config?.systemInstruction).toContain(tmpDir);
    });

    it('returns filtered and unfiltered tools', async () => {
      const set = new EnvironmentToolset({
        workingDir: tmpDir,
        toolFilter: ['Execute'],
      });
      let tools = await set.getTools(); // no context, unfiltered
      expect(tools.length).toBeGreaterThan(1);

      tools = await set.getTools(createContext()); // filtered
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('Execute');
    });

    it.skipIf(IS_WINDOWS)(
      'forwards the configured shell to Execute',
      async () => {
        const fakeShell = path.join(tmpDir, 'fake-shell.sh');
        await fs.writeFile(
          fakeShell,
          '#!/bin/sh\necho "fake-shell ran: $2"\n',
          'utf8',
        );
        await fs.chmod(fakeShell, 0o755);

        const set = new EnvironmentToolset({
          workingDir: tmpDir,
          shell: fakeShell,
        });
        const execute = (await set.getTools()).find(
          (t) => t.name === 'Execute',
        );
        if (!(execute instanceof ExecuteTool)) {
          throw new Error('Execute tool missing from the toolset.');
        }

        const res = await execute.runAsync({
          args: {command: 'echo hello'},
          toolContext: confirmedContext(),
        });
        if (!('status' in res)) {
          throw new Error('Execute unexpectedly paused for confirmation.');
        }
        expect(res.status).toBe('ok');
        expect((res.stdout ?? '').trim()).toBe('fake-shell ran: echo hello');
      },
    );

    it('closes without error', async () => {
      const set = new EnvironmentToolset({workingDir: tmpDir});
      await expect(set.close()).resolves.toBeUndefined();
    });
  });
});
