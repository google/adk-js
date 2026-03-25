import {Storage} from './storage.js';

export class InMemoryFileStorage implements Storage {
  private prefix: string;
  private storage: Map<string, string> = new Map();

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  set(key: string, value: string): Promise<void> {
    this.storage.set(`${this.prefix}:${key}`, value);
    return Promise.resolve();
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.storage.get(`${this.prefix}:${key}`));
  }

  delete(key: string): Promise<void> {
    this.storage.delete(`${this.prefix}:${key}`);

    return Promise.resolve();
  }
}

export const FILE_STORAGE = new InMemoryFileStorage('local_file');
