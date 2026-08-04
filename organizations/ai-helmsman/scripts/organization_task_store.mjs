import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../../../scripts/feishu-commander/atomic_store.mjs';
import { createOrganizationPaths } from './organization_paths.mjs';
import { deepFreeze, readStrictJson } from './strict_json.mjs';

export const ORGANIZATION_TASK_STATUSES = Object.freeze([
  'received',
  'identifying_context',
  'knowledge_preflight',
  'waiting_input',
  'analyzing',
  'candidate_building',
  'waiting_collaboration',
  'collaboration_received',
  'quality_review',
  'waiting_decision',
  'pilot_running',
  'revising',
  'approved',
  'archived_formal',
  'health_review_due',
  'cancelled',
  'failed',
]);

const TERMINAL = new Set(['cancelled', 'failed']);
const CAPABILITIES = new Set([
  'enterprise-analysis',
  'strategy-planning',
  'business-model',
]);
const ALLOWED = new Map([
  ['received', ['identifying_context', 'cancelled', 'failed']],
  ['identifying_context', ['knowledge_preflight', 'waiting_input', 'cancelled', 'failed']],
  ['knowledge_preflight', ['analyzing', 'waiting_input', 'cancelled', 'failed']],
  ['waiting_input', ['identifying_context', 'analyzing', 'cancelled', 'failed']],
  ['analyzing', ['candidate_building', 'waiting_collaboration', 'cancelled', 'failed']],
  ['candidate_building', ['waiting_collaboration', 'quality_review', 'revising', 'cancelled', 'failed']],
  ['waiting_collaboration', ['collaboration_received', 'cancelled', 'failed']],
  ['collaboration_received', ['quality_review', 'revising', 'cancelled', 'failed']],
  ['quality_review', ['waiting_decision', 'revising', 'cancelled', 'failed']],
  ['waiting_decision', ['approved', 'revising', 'cancelled', 'failed']],
  ['pilot_running', ['revising', 'approved', 'cancelled', 'failed']],
  ['revising', ['candidate_building', 'quality_review', 'cancelled', 'failed']],
  ['approved', ['archived_formal', 'cancelled', 'failed']],
  ['archived_formal', ['health_review_due']],
  ['health_review_due', ['analyzing', 'cancelled', 'failed']],
]);

export async function createOrganizationTaskStore({
  projectRoot,
  now = () => new Date(),
  maxRevisionRetries = 3,
} = {}) {
  const paths = await createOrganizationPaths({ projectRoot });
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(maxRevisionRetries) || maxRevisionRetries < 1 || maxRevisionRetries > 3) {
    throw new Error('maxRevisionRetries must be 1-3');
  }

  const read = async (enterpriseId, taskId) => {
    const value = await readStrictJson(paths.taskFile(enterpriseId, taskId), {
      label: `organization task ${taskId}`,
    });
    validateTask(value);
    if (value.enterpriseId !== enterpriseId || value.taskId !== taskId) {
      throw new Error('organization task identity mismatch');
    }
    return value;
  };

  return Object.freeze({
    async createTask(input) {
      validateTask(input);
      const indexPath = idempotencyIndexPath(paths.organizationRoot, input.idempotencyKey);
      const indexed = await readOptional(indexPath);
      if (indexed) {
        if (indexed.enterpriseId !== input.enterpriseId || indexed.taskId !== input.taskId) {
          throw new Error('idempotency conflict across enterprise or task');
        }
        return deepFreeze(await read(input.enterpriseId, input.taskId));
      }
      const filePath = paths.taskFile(input.enterpriseId, input.taskId);
      if (await exists(filePath)) {
        const existing = await read(input.enterpriseId, input.taskId);
        if (existing.idempotencyKey !== input.idempotencyKey) {
          throw new Error('task already exists with different idempotency key');
        }
        return deepFreeze(existing);
      }
      await writeJsonAtomic(filePath, input);
      await writeJsonAtomic(indexPath, {
        schemaVersion: 1,
        idempotencyKey: input.idempotencyKey,
        enterpriseId: input.enterpriseId,
        taskId: input.taskId,
      });
      return deepFreeze(await read(input.enterpriseId, input.taskId));
    },

    async readTask({ enterpriseId, taskId, accessEnvelope } = {}) {
      validateAccess(accessEnvelope, enterpriseId, 'strategy.read', now);
      return deepFreeze(await read(enterpriseId, taskId));
    },

    async transition({
      enterpriseId,
      taskId,
      from,
      to,
      expectedRevision,
      evidenceRefs = [],
      knowledgeStatus,
      candidateVersion,
      decisionRef,
      candidateSha256,
      gatesPassed,
      accessEnvelope,
    } = {}) {
      validateAccess(accessEnvelope, enterpriseId, 'strategy.draft.write', now);
      const current = await read(enterpriseId, taskId);
      if (TERMINAL.has(current.status)) throw new Error(`terminal task cannot transition: ${current.status}`);
      if (current.status !== from) throw new Error('task transition source does not match');
      if (current.revision !== expectedRevision) throw new Error('task revision conflict');
      if (!ALLOWED.get(from)?.includes(to)) throw new Error(`task transition not allowed: ${from} -> ${to}`);
      if (from === 'knowledge_preflight' && to === 'analyzing'
        && !['matched', 'no_hit', 'degraded'].includes(knowledgeStatus)) {
        throw new Error('knowledge preflight must complete before diagnosis');
      }
      if (to === 'approved' && !(decisionRef || evidenceRefs.some((ref) => /decision/u.test(ref)))) {
        throw new Error('user decision reference is required for approval');
      }
      if (candidateVersion !== undefined
        && (!Number.isInteger(candidateVersion) || candidateVersion < current.candidateVersion)) {
        throw new Error('candidateVersion must be a non-decreasing positive integer');
      }
      if (to === 'archived_formal'
        && (!/^[a-f0-9]{64}$/u.test(candidateSha256 ?? '') || gatesPassed !== true)) {
        throw new Error('formal archive requires candidate hash and passed gates');
      }
      const next = {
        ...current,
        status: to,
        knowledgeStatus: knowledgeStatus ?? current.knowledgeStatus,
        candidateVersion: candidateVersion ?? current.candidateVersion,
        decisionRef: decisionRef ?? current.decisionRef,
        approvedCandidateSha256: candidateSha256 ?? current.approvedCandidateSha256,
        revision: current.revision + 1,
        updatedAt: timestamp(now),
        lastEvidenceRefs: [...evidenceRefs],
      };
      await writeJsonAtomic(paths.taskFile(enterpriseId, taskId), next);
      return deepFreeze(await read(enterpriseId, taskId));
    },

    async recordFailure({
      enterpriseId,
      taskId,
      rootCauseId,
      errorCode,
      evidenceRefs = [],
      accessEnvelope,
    } = {}) {
      validateAccess(accessEnvelope, enterpriseId, 'strategy.draft.write', now);
      if (typeof rootCauseId !== 'string' || rootCauseId.split('|').length !== 4) {
        throw new Error('rootCauseId must use enterprise|capability|scope|failure format');
      }
      if (typeof errorCode !== 'string' || !errorCode) throw new Error('errorCode is required');
      const stableRootCauseId = createHash('sha256').update(rootCauseId).digest('hex');
      const current = await read(enterpriseId, taskId);
      if (TERMINAL.has(current.status)) throw new Error('terminal task cannot record another failure');
      const count = (current.failureCounts?.[stableRootCauseId] ?? 0) + 1;
      const next = {
        ...current,
        status: count >= 3 ? 'failed' : current.status,
        failureCounts: { ...(current.failureCounts ?? {}), [stableRootCauseId]: count },
        lastFailure: {
          rootCauseId: stableRootCauseId,
          errorCode,
          evidenceRefs: [...evidenceRefs],
          occurredAt: timestamp(now),
        },
        revision: current.revision + 1,
        updatedAt: timestamp(now),
      };
      await writeJsonAtomic(paths.taskFile(enterpriseId, taskId), next);
      return deepFreeze(await read(enterpriseId, taskId));
    },

    async cancel({ enterpriseId, taskId, reason, decidedBy, accessEnvelope } = {}) {
      validateAccess(accessEnvelope, enterpriseId, 'strategy.draft.write', now);
      const current = await read(enterpriseId, taskId);
      if (TERMINAL.has(current.status)) return deepFreeze(current);
      if (typeof reason !== 'string' || !reason.trim() || typeof decidedBy !== 'string' || !decidedBy.trim()) {
        throw new Error('cancellation reason and decision owner are required');
      }
      const next = {
        ...current,
        status: 'cancelled',
        cancellation: { reason: reason.trim(), decidedBy: decidedBy.trim(), decidedAt: timestamp(now) },
        revision: current.revision + 1,
        updatedAt: timestamp(now),
      };
      await writeJsonAtomic(paths.taskFile(enterpriseId, taskId), next);
      return deepFreeze(await read(enterpriseId, taskId));
    },
  });
}

function validateTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('organization task must be an object');
  }
  if (value.schemaVersion !== 1
    || value.primaryOrganization !== 'ai-helmsman'
    || !ORGANIZATION_TASK_STATUSES.includes(value.status)) {
    throw new Error('organization task identity or status is invalid');
  }
  if (!CAPABILITIES.has(value.capabilityId)) {
    throw new Error('organization task capability is invalid');
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new Error('task revision is invalid');
  if (typeof value.idempotencyKey !== 'string' || !value.idempotencyKey) {
    throw new Error('task idempotencyKey is required');
  }
}

function validateAccess(envelope, enterpriseId, scope, now) {
  if (!envelope || envelope.enterpriseId !== enterpriseId) throw new Error('access enterprise mismatch');
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= now().getTime()) {
    throw new Error('access envelope expired');
  }
  if (envelope.deniedScopes?.includes(scope)) throw new Error(`scope explicitly denied: ${scope}`);
  if (!envelope.allowedScopes?.includes(scope)) throw new Error(`required scope missing: ${scope}`);
}

function idempotencyIndexPath(organizationRoot, key) {
  const digest = createHash('sha256').update(key).digest('hex');
  return path.join(organizationRoot, 'tasks', '.idempotency', `${digest}.json`);
}

async function readOptional(filePath) {
  if (!(await exists(filePath))) return null;
  return readStrictJson(filePath, { label: 'task idempotency index' });
}

async function exists(filePath) {
  return Boolean(await lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }));
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date');
  return date.toISOString();
}
