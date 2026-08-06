import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TIMEOUT_MS = 5_000;
const LOCK_DIRECTORY_NAME = 'codex-project-artifact-locks';
const LOCK_RETRY_DELAY_MS = 25;

export async function createProjectArtifactLock({
  projectRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('project artifact lock projectRoot must be an absolute path');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('project artifact lock timeoutMs must be a positive integer');
  }
  const physicalProjectRoot = normalizePhysicalPath(await realpath(projectRoot));
  const physicalTempRoot = normalizePhysicalPath(await realpath(os.tmpdir()));
  const projectHash = sha256(physicalProjectRoot);
  const sharedLockRoot = path.join(physicalTempRoot, LOCK_DIRECTORY_NAME);
  const projectLockRoot = path.join(sharedLockRoot, projectHash);
  await createAndAssertSafeLockDirectory(physicalTempRoot, sharedLockRoot);
  await createAndAssertSafeLockDirectory(sharedLockRoot, projectLockRoot);

  return Object.freeze({
    async run(identity, operation) {
      if (typeof operation !== 'function') {
        throw new TypeError('project artifact lock operation must be a function');
      }
      const lockKey = encodeArtifactLockKey(identity);
      await assertSafeLockDirectory(physicalTempRoot, sharedLockRoot);
      await assertSafeLockDirectory(sharedLockRoot, projectLockRoot);
      const databasePath = path.join(projectLockRoot, `${sha256(lockKey)}.sqlite`);
      await assertSafeLockDatabaseFile(databasePath, { allowMissing: true });
      const database = new DatabaseSync(databasePath);
      let transactionStarted = false;
      let result;
      let primaryError = null;
      const cleanupErrors = [];
      try {
        await assertSafeLockDatabaseFile(databasePath, { allowMissing: false });
        database.exec('PRAGMA busy_timeout = 0');
        const deadline = performance.now() + timeoutMs;
        let lastBusyError = null;
        for (;;) {
          if (lastBusyError && performance.now() >= deadline) {
            throw new Error('artifact publish lock timed out', { cause: lastBusyError });
          }
          try {
            database.exec('BEGIN IMMEDIATE');
            transactionStarted = true;
            break;
          } catch (error) {
            if (!isSqliteBusy(error)) throw error;
            lastBusyError = error;
            const remainingMs = deadline - performance.now();
            if (remainingMs <= 0) {
              throw new Error('artifact publish lock timed out', { cause: lastBusyError });
            }
            await delay(Math.min(LOCK_RETRY_DELAY_MS, remainingMs));
          }
        }
        result = await operation();
        database.exec('COMMIT');
        transactionStarted = false;
      } catch (error) {
        primaryError = error;
      }
      if (transactionStarted) {
        try { database.exec('ROLLBACK'); }
        catch (error) { cleanupErrors.push(error); }
        transactionStarted = false;
      }
      try { database.close(); }
      catch (error) { cleanupErrors.push(error); }
      if (primaryError) throw preservePrimaryError(primaryError, cleanupErrors);
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'project artifact lock cleanup failed');
      }
      return result;
    },
  });
}

function encodeArtifactLockKey(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('project artifact lock identity must be an object');
  }
  const values = ['enterpriseId', 'businessProjectId', 'artifactId'].map((field) => {
    const value = identity[field];
    if (typeof value !== 'string' || !value) {
      throw new TypeError(`project artifact lock ${field} must be a non-empty string`);
    }
    return value;
  });
  return JSON.stringify(values);
}

function normalizePhysicalPath(value) {
  let normalized = value;
  if (process.platform === 'win32') {
    if (normalized.startsWith('\\\\?\\UNC\\')) normalized = `\\\\${normalized.slice(8)}`;
    else if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
  }
  normalized = path.resolve(normalized);
  const parsed = path.parse(normalized);
  while (normalized.length > parsed.root.length && normalized.endsWith(path.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isSqliteBusy(error) {
  if (error?.errcode === 5) return true;
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_')) return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return /(?:database is (?:locked|busy)|SQLITE_BUSY)/iu.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function preservePrimaryError(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) return primaryError;
  try {
    Object.defineProperty(primaryError, 'cleanupErrors', {
      configurable: true,
      enumerable: false,
      value: Object.freeze([...cleanupErrors]),
      writable: false,
    });
    return primaryError;
  } catch {
    return new AggregateError(
      [primaryError, ...cleanupErrors],
      primaryError?.message ?? String(primaryError),
      { cause: primaryError },
    );
  }
}

async function createAndAssertSafeLockDirectory(anchor, directory) {
  await mkdir(directory, { recursive: true });
  await assertSafeLockDirectory(anchor, directory);
}

async function assertSafeLockDirectory(anchor, directory) {
  const direct = await lstat(directory);
  if (!direct.isDirectory() || direct.isSymbolicLink()) {
    throw new Error('project artifact lock directory is unsafe');
  }
  const canonical = normalizePhysicalPath(await realpath(directory));
  const expected = normalizePhysicalPath(directory);
  if (canonical !== expected || !isPathInside(anchor, canonical)) {
    throw new Error('project artifact lock directory is unsafe');
  }
}

async function assertSafeLockDatabaseFile(databasePath, { allowMissing }) {
  const direct = await lstat(databasePath).catch((error) => {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!direct) return;
  if (!direct.isFile() || direct.isSymbolicLink()) {
    throw new Error('project artifact lock database is unsafe');
  }
  const canonical = normalizePhysicalPath(await realpath(databasePath));
  if (canonical !== normalizePhysicalPath(databasePath)) {
    throw new Error('project artifact lock database is unsafe');
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}
