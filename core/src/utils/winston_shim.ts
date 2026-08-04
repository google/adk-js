/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface TransformableInfo {
  level: string;
  message: string;
  label?: string;
  timestamp?: string;
  rendered?: string;
}
export type Format = (info: TransformableInfo) => TransformableInfo;
export interface Logger {
  level: string;
  log(level: string, message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
const formatFn =
  (t: (i: TransformableInfo) => TransformableInfo) =>
  () =>
  (i: TransformableInfo) =>
    t(i) ?? i;
export const format = Object.assign(formatFn, {
  combine:
    (...fs: Format[]): Format =>
    (i) =>
      fs.reduce<TransformableInfo>((a, f) => f(a) ?? a, i),
  label:
    (o: {label?: string} = {}): Format =>
    (i) => ({...i, label: o.label}),
  colorize: (): Format => (i) => i,
  timestamp: (): Format => (i) => ({...i, timestamp: new Date().toISOString()}),
  printf:
    (t: (i: TransformableInfo) => string): Format =>
    (i) => ({...i, rendered: t(i)}),
});
class ConsoleTransport {}
export const transports = {Console: ConsoleTransport};
export function createLogger(
  o: {level?: string; format?: Format} = {},
): Logger {
  const write = (level: string, message: string) => {
    let out = message;
    if (o.format) {
      try {
        out = o.format({level, message})?.rendered ?? message;
      } catch {
        out = message;
      }
    }
    const c = globalThis.console;
    const fn =
      level === 'debug'
        ? c.debug
        : level === 'info'
          ? c.info
          : level === 'warn'
            ? c.warn
            : level === 'error'
              ? c.error
              : c.log;
    fn.call(c, out);
  };
  return {
    level: o.level ?? 'error',
    log: write,
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}
