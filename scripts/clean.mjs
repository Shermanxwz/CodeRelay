import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Only remove the known generated build directory, never an input path.
rmSync(fileURLToPath(new URL('../dist/', import.meta.url)), { recursive: true, force: true });
