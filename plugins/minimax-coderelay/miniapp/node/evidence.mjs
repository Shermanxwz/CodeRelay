import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { problem, text } from './state.mjs';

export async function workspaceIdentity(directory, platform = process.platform) {
  if (!isAbsolute(directory)) throw problem('WORKSPACE_NOT_ABSOLUTE');
  const canonical = await realpath(directory);
  const keyPath = platform === 'win32' ? canonical.toLowerCase() : canonical;
  return {
    workspaceDir: canonical,
    workspaceKey: createHash('sha256').update(keyPath).digest('hex'),
  };
}

/** Owner-controlled argv only. The remote task never chooses a command. */
export function validateCommands(commands) {
  if (!Array.isArray(commands) || commands.length > 8)
    throw problem('INVALID_VERIFICATION_COMMANDS');
  return commands.map((input) => {
    if (!input || typeof input !== 'object') throw problem('INVALID_VERIFICATION_COMMAND');
    const name = text(input.name, 'COMMAND_NAME', 80);
    const file = text(input.file, 'COMMAND_EXECUTABLE', 1000);
    if (
      !Array.isArray(input.args) ||
      input.args.length > 64 ||
      input.args.some((arg) => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0'))
    ) {
      throw problem('INVALID_COMMAND_ARGUMENTS');
    }
    const timeoutMs = input.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)
      throw problem('INVALID_COMMAND_TIMEOUT');
    return { name, file, args: input.args, timeoutMs };
  });
}

export function runCommand(file, args, { cwd, signal, timeoutMs = 15000, maxBytes = 65536 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    let stdout = '';
    let stderr = '';
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let errorCode = null;
    let settled = false;
    let killTimer;
    let cleanupTimer;
    const killTree = (force) => {
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => {
          try {
            child.kill('SIGKILL');
          } catch {}
        });
        killer.unref();
      } else {
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') {
            try {
              child.kill(force ? 'SIGKILL' : 'SIGTERM');
            } catch {}
          }
        }
      }
    };
    const capture = (chunk, isError) => {
      const room = Math.max(0, maxBytes - total);
      const part = chunk.subarray(0, room).toString('utf8');
      if (isError) stderr += part;
      else stdout += part;
      total += Math.min(room, chunk.length);
      truncated ||= chunk.length > room;
    };
    const stop = () => {
      if (!child || settled) return;
      killTree(false);
      killTimer = setTimeout(() => {
        killTree(true);
        cleanupTimer = setTimeout(() => {
          if (settled) return;
          errorCode = 'PROCESS_CLEANUP_UNCONFIRMED';
          child.stdout.destroy();
          child.stderr.destroy();
          finish(child.exitCode, child.signalCode);
        }, 1000);
        cleanupTimer.unref();
      }, 3000);
      killTimer.unref();
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();
    const finish = (exitCode, terminationSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        file,
        args,
        exitCode,
        signal: terminationSignal,
        stdout,
        stderr,
        truncated,
        timedOut,
        cancelled,
        errorCode,
        durationMs: Date.now() - startedAt,
      });
    };
    if (signal?.aborted) {
      cancelled = true;
      finish(null, null);
      return;
    }
    try {
      child = spawn(file, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Git subprocesses must not invoke credential or password prompts.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      });
      child.stdout.on('data', (chunk) => capture(chunk, false));
      child.stderr.on('data', (chunk) => capture(chunk, true));
      child.on('error', (error) => {
        errorCode = error.code || 'SPAWN_FAILED';
        finish(null, null);
      });
      child.on('close', (code, terminationSignal) => finish(code, terminationSignal));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch (error) {
      errorCode = error.code || 'SPAWN_FAILED';
      finish(null, null);
    }
  });
}

export async function gitEvidence(cwd, signal) {
  const checks = [
    ['head', ['rev-parse', '--verify', 'HEAD']],
    ['status', ['status', '--porcelain=v1', '--untracked-files=normal']],
    ['diff', ['diff', '--no-ext-diff', '--no-textconv', '--binary']],
    ['stagedDiff', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary']],
  ];
  const evidence = { source: 'independent-git-process', capturedAt: Date.now(), cwd };
  for (const [name, args] of checks) {
    evidence[name] = await runCommand('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      signal,
      maxBytes: name.includes('Diff') || name === 'diff' ? 65536 : 16384,
    });
  }
  return evidence;
}
