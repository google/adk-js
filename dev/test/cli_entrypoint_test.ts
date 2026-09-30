/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';

const {createProgramMock} = vi.hoisted(() => ({
  createProgramMock: vi.fn<() => Command>(),
}));

vi.mock('../src/cli/cli', () => ({createProgram: createProgramMock}));

/**
 * Runs the entrypoint module for its import side effect.
 *
 * The extra `setImmediate` hop lets the `.catch()` microtask settle and lets
 * Node report an `unhandledRejection` if the entrypoint dropped the promise.
 */
async function runEntrypoint(args: string[]): Promise<void> {
  process.argv = ['node', 'adk', ...args];
  vi.resetModules();
  await import('../src/cli_entrypoint.js');
  await new Promise((resolve) => setImmediate(resolve));
}

describe('cli_entrypoint', () => {
  let errorSpy: MockInstance<typeof console.error>;
  let unhandled: unknown[];
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('reports a rejecting action through the catch handler', async () => {
    const failure = new Error('web command failed');
    const program = new Command('adk');
    program.command('web').action(async () => {
      throw failure;
    });
    createProgramMock.mockReturnValue(program);

    await runEntrypoint(['web']);

    expect(errorSpy).toHaveBeenCalledWith(failure);
    expect(process.exitCode).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('does not report anything when the action resolves', async () => {
    const action = vi.fn(async () => {});
    const program = new Command('adk');
    program.command('web').action(action);
    createProgramMock.mockReturnValue(program);

    await runEntrypoint(['web']);

    expect(action).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reports a synchronous parse failure through the catch handler', async () => {
    const program = new Command('adk');
    program.exitOverride().configureOutput({writeErr: () => {}});
    program.command('web').action(async () => {});
    createProgramMock.mockReturnValue(program);

    await runEntrypoint(['web', '--nope']);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({code: 'commander.unknownOption'}),
    );
  });

  it('does not report an error when commander exits for --help', async () => {
    const program = new Command('adk');
    program.configureOutput({writeOut: () => {}, writeErr: () => {}});
    program.command('web').action(async () => {});
    createProgramMock.mockReturnValue(program);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(vi.fn<typeof process.exit>());

    await runEntrypoint(['--help']);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
