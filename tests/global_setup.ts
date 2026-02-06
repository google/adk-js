import {LogLevel, setLogLevel} from '@google/adk';

export function setup() {
  setLogLevel(LogLevel.ERROR);
}

export function teardown() {
  setLogLevel(LogLevel.INFO);
}
