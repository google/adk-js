/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {experimental} from '../../src/utils/experimental.js';
import {Logger, resetLogger, setLogger} from '../../src/utils/logger.js';

describe('experimental decorator', () => {
  let warnCalls: string[] = [];

  const mockLogger: Logger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(' '));
    },
    error: () => {},
  };

  beforeEach(() => {
    warnCalls = [];
    vi.stubEnv('ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS', undefined);
    setLogger(mockLogger);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetLogger();
  });

  describe('class decorator', () => {
    it('warns when an experimental class is instantiated', () => {
      @experimental
      class TestClass {}

      new TestClass();
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toContain('Class TestClass is experimental');
    });

    it('warns only once per class', () => {
      @experimental
      class TestClassOnce {}

      new TestClassOnce();
      new TestClassOnce();
      expect(warnCalls).toHaveLength(1);
    });

    it('does not warn for classes not marked as experimental', () => {
      class NormalClass {}
      new NormalClass();
      expect(warnCalls).toHaveLength(0);
    });

    it('keeps the class name, which the warning itself reports', () => {
      @experimental
      class NamedClass {}

      expect(NamedClass.name).toBe('NamedClass');
      expect(new NamedClass().constructor.name).toBe('NamedClass');
    });

    it('preserves constructor arguments and behavior', () => {
      @experimental
      class ArgClass {
        constructor(public value: number) {}
      }

      const instance = new ArgClass(42);
      expect(instance.value).toBe(42);
    });

    it('suppresses warnings for truthy ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS values and warns once cleared', () => {
      @experimental
      class SuppressedExperimentalClass {
        run(): string {
          return 'running experimental';
        }
      }

      for (const truthyValue of [
        'true',
        'True',
        'TRUE',
        '1',
        'yes',
        'YES',
        'on',
        'ON',
        ' true ',
      ]) {
        vi.stubEnv('ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS', truthyValue);
        const instance = new SuppressedExperimentalClass();
        expect(instance.run()).toBe('running experimental');
        expect(warnCalls).toHaveLength(0);
      }

      vi.stubEnv('ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS', undefined);
      new SuppressedExperimentalClass();
      new SuppressedExperimentalClass();
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toContain(
        'Class SuppressedExperimentalClass is experimental',
      );
    });

    it.each([
      ['false', 'FalsyFalseClass'],
      ['False', 'FalsyTitleFalseClass'],
      ['FALSE', 'FalsyUpperFalseClass'],
      ['0', 'FalsyZeroClass'],
      ['', 'FalsyEmptyClass'],
      ['no', 'FalsyNoClass'],
      ['off', 'FalsyOffClass'],
    ])(
      'still warns when ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS is %j',
      (falsyValue, className) => {
        vi.stubEnv('ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS', falsyValue);
        class CandidateClass {}
        Object.defineProperty(CandidateClass, 'name', {
          value: className,
          configurable: true,
        });
        const DecoratedClass = experimental(CandidateClass);

        new DecoratedClass();

        expect(warnCalls).toHaveLength(1);
        expect(warnCalls[0]).toContain(`Class ${className} is experimental`);
      },
    );
  });

  describe('method decorator', () => {
    it('warns when an experimental method is called', () => {
      class TestMethodClass {
        @experimental
        testMethod() {}
      }

      const instance = new TestMethodClass();
      instance.testMethod();
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toContain(
        'Method TestMethodClass.testMethod is experimental',
      );
    });

    it('warns only once per method', () => {
      class TestMethodClassOnce {
        @experimental
        testMethod() {}
      }

      const instance = new TestMethodClassOnce();
      instance.testMethod();
      instance.testMethod();
      expect(warnCalls).toHaveLength(1);
    });

    it('does not warn for methods not marked as experimental', () => {
      class NormalMethodClass {
        normalMethod() {}
      }
      const instance = new NormalMethodClass();
      instance.normalMethod();
      expect(warnCalls).toHaveLength(0);
    });

    it('warns when an experimental static method is called', () => {
      class TestStaticClass {
        @experimental
        static staticMethod() {}
      }

      TestStaticClass.staticMethod();
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toContain(
        'Method TestStaticClass.staticMethod is experimental',
      );
    });

    it('preserves method arguments and return value', () => {
      class ArgMethodClass {
        @experimental
        add(a: number, b: number) {
          return a + b;
        }
      }

      const instance = new ArgMethodClass();
      const result = instance.add(2, 3);
      expect(result).toBe(5);
    });

    it('suppresses instance and static method warnings for truthy ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS values and warns once cleared', () => {
      class SuppressedMethodClass {
        @experimental
        run(): string {
          return 'executing';
        }

        @experimental
        static runStatic(): string {
          return 'executing static';
        }
      }

      const instance = new SuppressedMethodClass();
      for (const truthyValue of [
        'true',
        'True',
        'TRUE',
        '1',
        'yes',
        'YES',
        'on',
        'ON',
        ' true ',
      ]) {
        vi.stubEnv('ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS', truthyValue);
        expect(instance.run()).toBe('executing');
        expect(SuppressedMethodClass.runStatic()).toBe('executing static');
        expect(warnCalls).toHaveLength(0);
      }

      vi.stubEnv('ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS', undefined);
      instance.run();
      instance.run();
      SuppressedMethodClass.runStatic();
      SuppressedMethodClass.runStatic();
      expect(warnCalls).toHaveLength(2);
      expect(warnCalls[0]).toContain(
        'Method SuppressedMethodClass.run is experimental',
      );
      expect(warnCalls[1]).toContain(
        'Method SuppressedMethodClass.runStatic is experimental',
      );
    });

    it.each([
      ['false', 'FalsyFalseMethodHost'],
      ['False', 'FalsyTitleFalseMethodHost'],
      ['FALSE', 'FalsyUpperFalseMethodHost'],
      ['0', 'FalsyZeroMethodHost'],
      ['', 'FalsyEmptyMethodHost'],
      ['no', 'FalsyNoMethodHost'],
      ['off', 'FalsyOffMethodHost'],
    ])(
      'still warns on methods when ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS is %j',
      (falsyValue, hostName) => {
        vi.stubEnv('ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS', falsyValue);
        class CandidateHost {
          run(): string {
            return 'executing';
          }
        }
        Object.defineProperty(CandidateHost, 'name', {
          value: hostName,
          configurable: true,
        });
        const descriptor = Object.getOwnPropertyDescriptor(
          CandidateHost.prototype,
          'run',
        );
        expect(descriptor).toBeDefined();
        if (descriptor) {
          Object.defineProperty(
            CandidateHost.prototype,
            'run',
            experimental(CandidateHost.prototype, 'run', descriptor),
          );
        }

        const instance = new CandidateHost();
        expect(instance.run()).toBe('executing');
        expect(warnCalls).toHaveLength(1);
        expect(warnCalls[0]).toContain(
          `Method ${hostName}.run is experimental`,
        );
      },
    );
  });
});
