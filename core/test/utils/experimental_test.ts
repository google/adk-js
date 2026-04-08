/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
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
    setLogger(mockLogger);
  });

  afterEach(() => {
    resetLogger();
  });

  // Verify class decorator behavior
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

    it('preserves constructor arguments and behavior', () => {
      @experimental
      class ArgClass {
        constructor(public value: number) {}
      }

      const instance = new ArgClass(42);
      expect(instance.value).toBe(42);
    });
  });

  // Verify method decorator behavior
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
  });
});
