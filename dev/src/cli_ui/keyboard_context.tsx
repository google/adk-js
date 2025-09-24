import React, { createContext, useRef, useCallback, useEffect } from 'react';
import { useStdin } from 'ink';
import readline from 'readline';

export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  paste: boolean;
  sequence: string;
}

export type KeypressHandler = (key: Key) => void;

interface KeyboardContextValue {
  subscribe: (handler: KeypressHandler) => void;
  unsubscribe: (handler: KeypressHandler) => void;
}

export const KeyboardContext = createContext<KeyboardContextValue | undefined>(undefined);

export function KeyboardProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const subscribers = useRef<Set<KeypressHandler>>(new Set()).current;
  const { stdin, setRawMode } = useStdin();

  const subscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.add(handler);
    },
    [subscribers],
  );

  const unsubscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.delete(handler);
    },
    [subscribers],
  );

  const notifyListeners = useCallback(
    (key: Key) => {
      subscribers.forEach((handler) => handler(key));
    },
    [subscribers],
  );

  useEffect(() => {
    if (stdin.isRaw === false) {
      setRawMode?.(true);
    }

    const rl = readline.createInterface({ input: stdin, escapeCodeTimeout: 0 });
    readline.emitKeypressEvents(stdin, rl);

    const handleKeypress = (str: string, key: Key) => {
      notifyListeners(key);
    };

    stdin.on('keypress', handleKeypress);

    return () => {
      stdin.off('keypress', handleKeypress);
      rl.close();
      setRawMode?.(false);
    };
  }, []);

  return (
    <KeyboardContext.Provider value={{ subscribe, unsubscribe }}>
      {children}
    </KeyboardContext.Provider>
  );
}