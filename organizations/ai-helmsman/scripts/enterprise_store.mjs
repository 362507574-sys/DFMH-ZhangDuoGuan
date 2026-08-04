import { lstat, readFile } from 'node:fs/promises';

import {
  jsonSafeClone,
  sha256File,
  writeJsonAtomic,
} from '../../../scripts/feishu-commander/atomic_store.mjs';
import { createOrganizationPaths } from './organization_paths.mjs';
import { deepFreeze, readStrictJson } from './strict_json.mjs';

const SENSITIVE_SCOPE_BY_FIELD = Object.freeze({
  financials: 'enterprise.financials.read',
  ownership: 'enterprise.ownership.read',
  legal: 'enterprise.legal.read',
});

export async function createEnterpriseStore({ projectRoot, now = () => new Date() } = {}) {
  const paths = await createOrganizationPaths({ projectRoot });
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const readRawProfile = async (enterpriseId) => {
    const value = await readStrictJson(paths.enterpriseProfile(enterpriseId), {
      label: `enterprise profile ${enterpriseId}`,
    });
    validateProfile(value, enterpriseId);
    return value;
  };

  return Object.freeze({
    async createProfile(profile) {
      validateProfile(profile, profile?.enterpriseId);
      const filePath = paths.enterpriseProfile(profile.enterpriseId);
      if (await exists(filePath)) throw new Error(`enterprise profile already exists: ${profile.enterpriseId}`);
      await writeJsonAtomic(filePath, profile);
      const stored = await readRawProfile(profile.enterpriseId);
      return deepFreeze(stored);
    },

    async readProfile({
      enterpriseId,
      accessEnvelope,
      requiredSensitiveScopes = [],
    } = {}) {
      validateAccess(accessEnvelope, enterpriseId, 'strategy.read', now);
      if (!Array.isArray(requiredSensitiveScopes)) {
        throw new TypeError('requiredSensitiveScopes must be an array');
      }
      for (const scope of requiredSensitiveScopes) {
        requireScope(accessEnvelope, scope, now);
      }
      const stored = await readRawProfile(enterpriseId);
      const result = jsonSafeClone(stored);
      result.sensitive = {};
      for (const [field, scope] of Object.entries(SENSITIVE_SCOPE_BY_FIELD)) {
        if (stored.sensitive?.[field] !== undefined && hasScope(accessEnvelope, scope, now)) {
          result.sensitive[field] = stored.sensitive[field];
        }
      }
      return deepFreeze(result);
    },

    async updateProfile({
      enterpriseId,
      expectedVersion,
      patch,
      accessEnvelope,
    } = {}) {
      validateAccess(accessEnvelope, enterpriseId, 'strategy.draft.write', now);
      const stored = await readRawProfile(enterpriseId);
      if (stored.version !== expectedVersion) throw new Error('enterprise profile version conflict');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError('patch must be a plain object');
      }
      for (const forbidden of ['enterpriseId', 'schemaVersion', 'version', 'createdAt', 'authorization']) {
        if (Object.hasOwn(patch, forbidden)) throw new Error(`patch cannot modify ${forbidden}`);
      }
      const next = {
        ...stored,
        ...jsonSafeClone(patch),
        version: stored.version + 1,
        updatedAt: timestamp(now),
      };
      validateProfile(next, enterpriseId);
      await writeJsonAtomic(paths.enterpriseProfile(enterpriseId), next);
      return deepFreeze(await readRawProfile(enterpriseId));
    },

    async writeFormalAsset({
      enterpriseId,
      capabilityId,
      version,
      asset,
      approval,
      accessEnvelope,
    } = {}) {
      validateAccess(accessEnvelope, enterpriseId, 'strategy.formal.write', now);
      if (asset?.enterpriseId !== enterpriseId) throw new Error('formal asset enterprise mismatch');
      if (approval?.decision !== 'approve' || approval.enterpriseId !== enterpriseId) {
        throw new Error('formal asset requires matching user approval');
      }
      const filePath = paths.enterpriseAssetVersion(enterpriseId, capabilityId, version);
      if (await exists(filePath)) throw new Error('approved formal asset version already exists');
      const record = {
        schemaVersion: 1,
        enterpriseId,
        capabilityId,
        version: Number(version),
        asset: jsonSafeClone(asset),
        approval: jsonSafeClone(approval),
        archivedAt: timestamp(now),
      };
      await writeJsonAtomic(filePath, record);
      return deepFreeze({
        filePath,
        sha256: await sha256File(filePath),
        record: await readStrictJson(filePath, { label: 'formal enterprise asset' }),
      });
    },

    async readFormalAsset({
      enterpriseId,
      capabilityId,
      version,
      accessEnvelope,
    } = {}) {
      validateAccess(accessEnvelope, enterpriseId, 'strategy.read', now);
      const filePath = paths.enterpriseAssetVersion(enterpriseId, capabilityId, version);
      return deepFreeze(await readStrictJson(filePath, { label: 'formal enterprise asset' }));
    },
  });
}

function validateProfile(value, expectedEnterpriseId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('enterprise profile must be an object');
  }
  if (value.schemaVersion !== 1 || value.enterpriseId !== expectedEnterpriseId) {
    throw new Error('enterprise profile identity mismatch');
  }
  if (typeof value.displayName !== 'string' || !value.displayName.trim()) {
    throw new Error('enterprise displayName is required');
  }
  if (!Number.isInteger(value.version) || value.version < 1) {
    throw new Error('enterprise profile version is invalid');
  }
  for (const field of ['createdAt', 'updatedAt']) validateTimestamp(value[field], field);
  if (!value.authorization || !Array.isArray(value.authorization.allowedScopes)
    || !Array.isArray(value.authorization.deniedScopes)) {
    throw new Error('enterprise authorization is invalid');
  }
}

function validateAccess(envelope, enterpriseId, scope, now) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('access envelope is required');
  }
  if (envelope.enterpriseId !== enterpriseId) throw new Error('cross-enterprise access: enterprise must match');
  requireScope(envelope, scope, now);
}

function requireScope(envelope, scope, now) {
  ensureNotExpired(envelope, now);
  if (envelope.deniedScopes?.includes(scope)) throw new Error(`scope is explicitly denied: ${scope}`);
  if (!envelope.allowedScopes?.includes(scope)) throw new Error(`required scope is missing: ${scope}`);
}

function hasScope(envelope, scope, now) {
  ensureNotExpired(envelope, now);
  return !envelope.deniedScopes?.includes(scope) && envelope.allowedScopes?.includes(scope);
}

function ensureNotExpired(envelope, now) {
  if (!Array.isArray(envelope.allowedScopes) || !Array.isArray(envelope.deniedScopes)) {
    throw new Error('access envelope scopes are invalid');
  }
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= now().getTime()) {
    throw new Error('access envelope expired');
  }
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date');
  return date.toISOString();
}

function validateTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

async function exists(filePath) {
  return Boolean(await lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }));
}
