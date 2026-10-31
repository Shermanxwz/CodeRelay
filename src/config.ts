import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { RelayError } from './errors.js';

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    publicUrl: z.url(),
    host: z.enum(['127.0.0.1', '::1', '0.0.0.0', '::']),
    port: z.number().int().min(1).max(65535),
    adminToken: z.string().regex(/^cr_admin_[A-Za-z0-9_-]{43}$/),
    createdAt: z.number().int().positive(),
  })
  .strict();
export type PersistedConfig = z.infer<typeof configSchema>;
export interface RelayConfig extends PersistedConfig {
  dataDir: string;
}

export function defaultDataDir(): string {
  return resolve(process.env.CODERELAY_DATA_DIR ?? join(homedir(), '.coderelay'));
}

export function normalizePublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError('INVALID_CONFIG', 'Use an absolute PUBLIC_URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    value !== value.trim() ||
    value.includes('\\') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new RelayError(
      'INVALID_CONFIG',
      'PUBLIC_URL must be an HTTPS origin; HTTP is allowed only for loopback development.',
    );
  }
  return url.origin;
}

export function initConfig(
  options: { dataDir?: string; publicUrl?: string; host?: string; port?: number } = {},
): RelayConfig {
  const dataDir = resolve(options.dataDir ?? defaultDataDir());
  if (
    existsSync(dataDir) &&
    (!lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink())
  ) {
    throw new RelayError(
      'INVALID_CONFIG',
      'Data directory must be a real directory, not a symbolic link.',
    );
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const port = options.port ?? 8787;
  const config = configSchema.parse({
    schemaVersion: 1,
    publicUrl: normalizePublicUrl(options.publicUrl ?? `http://127.0.0.1:${port}`),
    host: options.host ?? '127.0.0.1',
    port,
    adminToken: `cr_admin_${randomBytes(32).toString('base64url')}`,
    createdAt: Date.now(),
  });
  if (
    config.host !== '127.0.0.1' &&
    config.host !== '::1' &&
    !config.publicUrl.startsWith('https://')
  ) {
    throw new RelayError(
      'INVALID_CONFIG',
      'A public bind requires an HTTPS PUBLIC_URL and a TLS reverse proxy.',
    );
  }
  let fd: number;
  try {
    fd = openSync(join(dataDir, 'config.json'), 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new RelayError(
        'ALREADY_INITIALIZED',
        'Configuration already exists; it was not overwritten.',
        409,
      );
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return { ...config, dataDir };
}

export function loadConfig(dataDir = defaultDataDir()): RelayConfig {
  const directory = resolve(dataDir);
  if (!existsSync(directory))
    throw new RelayError('NOT_INITIALIZED', 'Run coderelay init before starting the gateway.');
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new RelayError(
      'INVALID_CONFIG',
      'Data directory must be a real directory, not a symbolic link.',
    );
  if (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0)
    throw new RelayError('INSECURE_CONFIG', 'Data directory permissions must be 0700.');
  const path = join(directory, 'config.json');
  if (!existsSync(path))
    throw new RelayError('NOT_INITIALIZED', 'Run coderelay init before starting the gateway.');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new RelayError('INVALID_CONFIG', 'Configuration must be a regular file.');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    throw new RelayError('INSECURE_CONFIG', 'Configuration permissions must be 0600.');
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  config.publicUrl = normalizePublicUrl(process.env.CODERELAY_PUBLIC_URL ?? config.publicUrl);
  if (process.env.CODERELAY_HOST)
    config.host = configSchema.shape.host.parse(process.env.CODERELAY_HOST);
  if (process.env.CODERELAY_PORT)
    config.port = configSchema.shape.port.parse(Number(process.env.CODERELAY_PORT));
  if (
    config.host !== '127.0.0.1' &&
    config.host !== '::1' &&
    !config.publicUrl.startsWith('https://')
  ) {
    throw new RelayError(
      'INVALID_CONFIG',
      'A public bind requires an HTTPS PUBLIC_URL and a TLS reverse proxy.',
    );
  }
  return { ...config, dataDir: directory };
}
