import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const STALE_TEMP_AGE_MS = 60 * 60 * 1000;
const MAX_SAFE_SEGMENT_LENGTH = 160;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export async function writeJsonAtomic(filePath, value, {
  renameRetryDelaysMs = [10, 25, 50],
  testHooks = {},
  staleTempAgeMs = STALE_TEMP_AGE_MS,
} = {}) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const normalized = jsonSafeClone(value);
  const serialized = JSON.stringify(normalized, null, 2);
  await mkdir(directory, { recursive: true });
  await cleanupStaleTemps(filePath, staleTempAgeMs);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(`${serialized}\n`, 'utf8');
    await handle.sync();
    await testHooks.afterTempSync?.({ temporaryPath, filePath });
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporaryPath, filePath, renameRetryDelaysMs, testHooks);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true });
  }
}

export function jsonSafeClone(value) {
  assertJsonSafe(value, new WeakSet(), '$');
  const normalized = JSON.parse(JSON.stringify(value));
  assertJsonSafe(normalized, new WeakSet(), '$');
  return normalized;
}

function assertJsonSafe(value, active, location) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`JSON-safe number must be finite at ${location}`);
    return;
  }
  if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) {
    throw new TypeError(`Unsupported JSON-safe value at ${location}: ${typeof value}`);
  }
  if (active.has(value)) throw new TypeError(`Circular JSON-safe value at ${location}`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`JSON-safe objects must be plain objects at ${location}`);
  }
  if (typeof value.toJSON === 'function') throw new TypeError(`Custom toJSON is not JSON-safe at ${location}`);
  active.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`Sparse arrays are not JSON-safe at ${location}`);
      assertJsonSafe(value[index], active, `${location}[${index}]`);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError(`Symbol keys are not JSON-safe at ${location}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`Accessors are not JSON-safe at ${location}.${key}`);
      assertJsonSafe(descriptor.value, active, `${location}.${key}`);
    }
  }
  active.delete(value);
}

async function renameWithRetry(sourcePath, targetPath, retryDelaysMs, testHooks) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await testHooks.beforeRenameAttempt?.({ attempt: attempt + 1, sourcePath, targetPath });
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error?.code) || attempt >= retryDelaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }
}

async function cleanupStaleTemps(filePath, staleAgeMs) {
  const directory = path.dirname(filePath);
  const pattern = new RegExp(`^\\.${escapeRegex(path.basename(filePath))}\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`, 'i');
  const now = Date.now();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const temporaryPath = path.join(directory, entry.name);
    const stats = await lstat(temporaryPath);
    if (!stats.isFile() || now - stats.mtimeMs < staleAgeMs) continue;
    await rm(temporaryPath);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function appendNdjson(filePath, value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('NDJSON value is not serializable');
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${serialized}\n`, 'utf8');
}

export function sanitizeFileName(value) {
  let result = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!result || result === '.' || result === '..') result = '_';
  if (WINDOWS_RESERVED_NAME.test(result)) result = `_${result}`;
  if (result.length > MAX_SAFE_SEGMENT_LENGTH) {
    const suffix = createHash('sha256').update(result).digest('hex').slice(0, 12);
    result = `${result.slice(0, MAX_SAFE_SEGMENT_LENGTH - suffix.length - 1)}-${suffix}`;
  }
  return result;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
