import { mkdir, readFile, open, rename, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Serialized, atomic durable journal. Never use browser storage for this state. */
export class Journal {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, 'coderelay-state.json');
    this.value = null;
    this.tail = Promise.resolve();
    this.initializing = null;
  }

  async init() {
    if (this.value) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const bytes = await readFile(this.path, 'utf8');
        if (bytes.length > 64 * 1024 * 1024) throw new Error('JOURNAL_TOO_LARGE');
        const parsed = JSON.parse(bytes);
        if (
          parsed.schemaVersion !== 1 ||
          !parsed.jobs ||
          !parsed.projects ||
          !parsed.verification
        ) {
          throw new Error('JOURNAL_INVALID');
        }
        this.value = parsed;
        await chmod(this.path, 0o600);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.value = {
          schemaVersion: 1,
          connection: null,
          projects: {},
          verification: {},
          jobs: {},
        };
        await this.persist(this.value);
      }
    })();
    return this.initializing;
  }

  async persist(value) {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
      // Directory fsync makes a rename durable on POSIX. Windows does not allow it.
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  change(mutator) {
    const pending = this.tail.then(async () => {
      await this.init();
      const next = structuredClone(this.value);
      const result = mutator(next);
      if (result && typeof result.then === 'function') throw new Error('ASYNC_JOURNAL_MUTATOR');
      await this.persist(next);
      this.value = next;
      return result;
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  async flush() {
    await this.tail;
  }
}

export function safeCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
    ? code
    : 'OPERATION_FAILED';
}

export function problem(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

export function text(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw problem(`INVALID_${name}`);
  }
  return value.trim();
}

export function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('INVALID_OBJECT');
  return value;
}
