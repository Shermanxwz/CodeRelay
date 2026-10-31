import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
let completed = false;
for (const executable of candidates) {
  const result = spawnSync(executable, [join(root, 'scripts/package.py')], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error?.code === 'ENOENT') continue;
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  completed = true;
  break;
}
if (!completed) throw new Error('Python 3 is required only for release packaging.');
