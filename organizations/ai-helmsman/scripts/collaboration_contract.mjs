import path from 'node:path';

import {
  sha256File,
  writeJsonAtomic,
} from '../../../scripts/feishu-commander/atomic_store.mjs';
import { createOrganizationPaths } from './organization_paths.mjs';
import { deepFreeze, readStrictJson } from './strict_json.mjs';

const ORGANIZATIONS = new Set([
  'ai-helmsman',
  'ai-growth-strategist',
  'ai-deal-officer',
  'ai-organization-officer',
  'ai-brand-officer',
]);

export function createCollaborationRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('collaboration request must be an object');
  }
  if (value.schemaVersion !== 1 || value.contractVersion !== 1) {
    throw new Error('collaboration contract version is invalid');
  }
  if (value.primaryOrganization !== 'ai-helmsman'
    || value.requestingOrganization !== 'ai-helmsman') {
    throw new Error('collaboration request cannot change unique primary organization');
  }
  if (value.targetOrganization === value.requestingOrganization) {
    throw new Error('collaboration self-call is forbidden');
  }
  if (!ORGANIZATIONS.has(value.targetOrganization)) throw new Error('target organization is invalid');
  if (value.recursionDepth !== 1 || value.constraints?.maxDelegationDepth !== 1) {
    throw new Error('collaboration delegation depth must stay at one');
  }
  if (typeof value.scope !== 'string'
    || value.scope.trim().length < 10
    || /全部处理|全权处理|接管任务/u.test(value.scope)) {
    throw new Error('collaboration request requires a bounded scope');
  }
  if (!Array.isArray(value.evidenceRequirements) || value.evidenceRequirements.length < 3) {
    throw new Error('collaboration evidence requirements are incomplete');
  }
  if (value.accessEnvelope?.enterpriseId !== value.enterpriseId) {
    throw new Error('collaboration access enterprise mismatch');
  }
  if (value.status !== 'requested') throw new Error('collaboration request status must be requested');
  return deepFreeze(structuredClone(value));
}

export async function validateCollaborationResult({ request, result } = {}) {
  const expected = createCollaborationRequest(request);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('collaboration result must be an object');
  }
  const matches = [
    ['contractVersion', expected.contractVersion],
    ['parentTaskId', expected.parentTaskId],
    ['requestId', expected.requestId],
    ['enterpriseId', expected.enterpriseId],
    ['primaryOrganization', expected.primaryOrganization],
    ['respondingOrganization', expected.targetOrganization],
    ['requestedCapability', expected.requestedCapability],
  ];
  for (const [field, value] of matches) {
    if (result[field] !== value) throw new Error(`collaboration ${field.replace(/[A-Z]/gu, (m) => ` ${m.toLowerCase()}`)} mismatch`);
  }
  if (!['completed', 'partial', 'failed'].includes(result.status)) {
    throw new Error('collaboration result status is invalid');
  }
  if (!Array.isArray(result.artifacts) || !Array.isArray(result.evidence)) {
    throw new Error('collaboration result artifacts and evidence are required');
  }
  if (result.status === 'completed' && result.evidence.length === 0) {
    throw new Error('completed collaboration result requires evidence');
  }
  for (const [index, artifact] of result.artifacts.entries()) {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.path !== 'string') {
      throw new Error(`collaboration artifact is invalid at ${index}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? '')) {
      throw new Error(`collaboration artifact hash is invalid at ${index}`);
    }
    const actual = await sha256File(artifact.path);
    if (actual !== artifact.sha256) throw new Error(`collaboration artifact hash mismatch at ${index}`);
  }
  return deepFreeze({ ok: true, result: structuredClone(result) });
}

export async function writeCollaborationRequest({
  projectRoot,
  request,
  accessEnvelope,
} = {}) {
  const normalized = createCollaborationRequest(request);
  validateWriteAccess(accessEnvelope, normalized.enterpriseId);
  const paths = await createOrganizationPaths({ projectRoot });
  const filePath = paths.collaborationRequestFile(
    normalized.enterpriseId,
    normalized.parentTaskId,
    normalized.requestId,
  );
  await writeJsonAtomic(filePath, normalized);
  const stored = await readStrictJson(filePath, { label: 'collaboration request' });
  if (stored.requestId !== normalized.requestId || stored.enterpriseId !== normalized.enterpriseId) {
    throw new Error('collaboration request write verification failed');
  }
  return filePath;
}

export async function receiveCollaborationResult({
  projectRoot,
  request,
  result,
  accessEnvelope,
} = {}) {
  const normalizedRequest = createCollaborationRequest(request);
  validateWriteAccess(accessEnvelope, normalizedRequest.enterpriseId);
  await validateCollaborationResult({ request: normalizedRequest, result });
  const paths = await createOrganizationPaths({ projectRoot });
  const filePath = paths.collaborationResultFile(
    normalizedRequest.enterpriseId,
    normalizedRequest.parentTaskId,
    normalizedRequest.requestId,
  );
  await writeJsonAtomic(filePath, result);
  const stored = await readStrictJson(filePath, { label: 'collaboration result' });
  if (stored.requestId !== normalizedRequest.requestId
    || stored.enterpriseId !== normalizedRequest.enterpriseId) {
    throw new Error('collaboration result write verification failed');
  }
  return filePath;
}

function validateWriteAccess(envelope, enterpriseId) {
  if (!envelope || envelope.enterpriseId !== enterpriseId) {
    throw new Error('collaboration write access enterprise mismatch');
  }
  const scope = 'strategy.draft.write';
  if (envelope.deniedScopes?.includes(scope)) throw new Error('collaboration write scope is denied');
  if (!envelope.allowedScopes?.includes(scope)) throw new Error('collaboration write scope is missing');
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= Date.now()) {
    throw new Error('collaboration access expired');
  }
}
