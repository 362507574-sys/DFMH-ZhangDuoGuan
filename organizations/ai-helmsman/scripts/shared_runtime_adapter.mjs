import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from '../../../scripts/feishu-commander/atomic_store.mjs';
import { deepFreeze } from './strict_json.mjs';

const locks = new Map();

export function createSharedRuntimeAdapter({
  now = () => new Date(),
  maxFailureAttempts = 3,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(maxFailureAttempts)
    || maxFailureAttempts < 1
    || maxFailureAttempts > 3) {
    throw new Error('maxFailureAttempts must be 1-3');
  }

  const readState = async (stateFile, label = 'shared runtime state') => {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    validateState(value, label);
    return deepFreeze(value);
  };

  return Object.freeze({
    exclusive,
    readState,

    async initializeState({
      stateFile,
      identity,
      initialState,
      label,
    } = {}) {
      validateIdentity(identity);
      const existing = await readOptionalState(stateFile, label);
      if (existing) {
        assertIdentity(existing, identity);
        return Object.freeze({ created: false, state: deepFreeze(existing) });
      }
      validateState(initialState, label);
      assertIdentity(initialState, identity);
      await writeJsonAtomic(stateFile, initialState);
      return Object.freeze({ created: true, state: deepFreeze(initialState) });
    },

    async pauseState({
      stateFile,
      expectedRevision,
      reason,
      checkpoint,
      label,
    } = {}) {
      const current = await readState(stateFile, label);
      assertRevision(current, expectedRevision);
      assertMutable(current);
      if (typeof reason !== 'string' || !reason.trim()) throw new Error('pause reason is required');
      const next = {
        ...current,
        status: 'paused',
        revision: current.revision + 1,
        checkpoint: validateCheckpoint(checkpoint, reason.trim()),
        pausedAt: isoNow(now),
        updatedAt: isoNow(now),
      };
      await writeJsonAtomic(stateFile, next);
      return deepFreeze(next);
    },

    async resumeState({
      stateFile,
      expectedRevision,
      resumeKey,
      nextStatus = 'analyzing',
      label,
    } = {}) {
      const current = await readState(stateFile, label);
      if (typeof resumeKey !== 'string' || !resumeKey.trim()) {
        throw new Error('resumeKey is required for idempotent resume');
      }
      if (current.lastResume?.resumeKey === resumeKey.trim()) return current;
      assertRevision(current, expectedRevision);
      if (!['paused', 'waiting_input'].includes(current.status)) {
        throw new Error(`runtime task cannot resume from ${current.status}`);
      }
      const next = {
        ...current,
        status: nextStatus,
        revision: current.revision + 1,
        lastResume: {
          resumeKey: resumeKey.trim(),
          resumedAt: isoNow(now),
        },
        updatedAt: isoNow(now),
      };
      await writeJsonAtomic(stateFile, next);
      return deepFreeze(next);
    },

    async recordFailure({
      stateFile,
      expectedRevision,
      rootCauseId,
      errorCode,
      label,
    } = {}) {
      const current = await readState(stateFile, label);
      assertRevision(current, expectedRevision);
      assertMutable(current);
      if (typeof rootCauseId !== 'string' || !rootCauseId.trim()) {
        throw new Error('rootCauseId is required');
      }
      if (typeof errorCode !== 'string' || !errorCode.trim()) {
        throw new Error('errorCode is required');
      }
      const key = rootCauseId.trim();
      const count = (current.failureCounts?.[key] ?? 0) + 1;
      const next = {
        ...current,
        status: count >= maxFailureAttempts ? 'failed' : current.status,
        revision: current.revision + 1,
        failureCounts: {
          ...(current.failureCounts ?? {}),
          [key]: count,
        },
        lastFailure: {
          rootCauseId: key,
          errorCode: errorCode.trim(),
          attempt: count,
          maxAttempts: maxFailureAttempts,
          occurredAt: isoNow(now),
        },
        updatedAt: isoNow(now),
      };
      await writeJsonAtomic(stateFile, next);
      return deepFreeze(next);
    },
  });
}

async function exclusive(key, operation) {
  if (typeof key !== 'string' || !key) throw new Error('runtime lock key is required');
  if (typeof operation !== 'function') throw new TypeError('runtime operation must be a function');
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

async function readOptionalState(stateFile, label) {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    validateState(value, label);
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function validateState(value, label = 'shared runtime state') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (value.schemaVersion !== 1
    || typeof value.capabilityId !== 'string'
    || typeof value.enterpriseId !== 'string'
    || typeof value.businessProjectId !== 'string'
    || typeof value.taskId !== 'string'
    || !Number.isInteger(value.revision)
    || value.revision < 1
    || typeof value.status !== 'string') {
    throw new Error(`${label} identity or revision is invalid`);
  }
}

function validateIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('runtime identity is required');
  }
  for (const key of [
    'capabilityId',
    'enterpriseId',
    'businessProjectId',
    'taskId',
    'objective',
    'artifactBindingsKey',
  ]) {
    if (typeof identity[key] !== 'string') throw new Error(`runtime identity ${key} is required`);
  }
}

function assertIdentity(state, identity) {
  for (const key of [
    'capabilityId',
    'enterpriseId',
    'businessProjectId',
    'taskId',
    'objective',
  ]) {
    if (state[key] !== identity[key]) throw new Error(`runtime identity conflict: ${key}`);
  }
  if (JSON.stringify(state.artifactBindings ?? []) !== identity.artifactBindingsKey) {
    throw new Error('runtime identity conflict: artifactBindings');
  }
}

function assertRevision(current, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || current.revision !== expectedRevision) {
    throw new Error('runtime state revision conflict');
  }
}

function assertMutable(current) {
  if (['failed', 'cancelled', 'published'].includes(current.status)) {
    throw new Error(`terminal runtime task cannot change: ${current.status}`);
  }
}

function validateCheckpoint(value, reason) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('checkpoint is required');
  }
  if (!Array.isArray(value.completedStageIds)
    || typeof value.nextStageId !== 'string'
    || !value.nextStageId.trim()
    || !Array.isArray(value.unresolvedItems)) {
    throw new Error('checkpoint is invalid');
  }
  return {
    completedStageIds: [...value.completedStageIds],
    nextStageId: value.nextStageId.trim(),
    reason,
    unresolvedItems: [...value.unresolvedItems],
  };
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date');
  return date.toISOString();
}
