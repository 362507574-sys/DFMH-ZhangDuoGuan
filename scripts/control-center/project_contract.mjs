import { createHash } from 'node:crypto';

const ENTERPRISE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const BUSINESS_PROJECT_ID = /^[0-9]{8}-[0-9]{3}-[a-z0-9-]{3,80}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,119}$/u;
const PROJECT_FIELDS = new Set([
  'schemaVersion', 'enterpriseId', 'enterpriseDisplayName', 'enterpriseIdentityStatus',
  'businessProjectId', 'displayName', 'objective', 'scope', 'primaryOrganizationId',
  'collaboratingOrganizationIds', 'publicSkillIds', 'status', 'contextVersion',
  'sourceMessageId', 'commanderTaskId', 'feishuChatId', 'codexThreadId',
  'createdAt', 'updatedAt', 'completedAt', 'cancelledAt', 'archivedAt',
]);
const ASSIGNMENT_FIELDS = new Set([
  'schemaVersion', 'taskId', 'enterpriseId', 'businessProjectId',
  'projectContextVersion', 'createdAt',
]);
const IDENTITY_STATUSES = new Set(['resolved', 'provisional']);

export const BUSINESS_PROJECT_STATUSES = Object.freeze([
  'active', 'waiting_input', 'in_progress', 'waiting_review',
  'completed', 'cancelled', 'archived',
]);

export function requireEnterpriseId(value) {
  if (typeof value !== 'string' || !ENTERPRISE_ID.test(value)) {
    throw new Error('enterpriseId is invalid or unsafe');
  }
  return value;
}

export function requireBusinessProjectId(value) {
  if (typeof value !== 'string' || !BUSINESS_PROJECT_ID.test(value)) {
    throw new Error('businessProjectId is invalid or unsafe');
  }
  return value;
}

export function requireSafeId(value, label = 'id') {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`${label} is invalid or unsafe`);
  }
  return value;
}

export function provisionalEnterpriseId(sourceMessageId) {
  const source = nonEmpty(sourceMessageId, 'sourceMessageId', 500);
  return `pending-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
}

export function assertTextIntegrity(value, label = 'text') {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (/\?{8,}/u.test(value)) {
    throw new Error(`${label} failed content integrity: consecutive question marks detected`);
  }
  return value;
}

export function validateBusinessProject(value, registry) {
  assertPlainObject(value, 'business project');
  assertExactFields(value, PROJECT_FIELDS, 'business project');
  assertRegistry(registry);
  if (value.schemaVersion !== 1) throw new Error('business project schemaVersion must be 1');
  requireEnterpriseId(value.enterpriseId);
  assertTextIntegrity(nonEmpty(value.enterpriseDisplayName, 'enterpriseDisplayName', 200), 'enterpriseDisplayName');
  enumValue(value.enterpriseIdentityStatus, IDENTITY_STATUSES, 'enterpriseIdentityStatus');
  requireBusinessProjectId(value.businessProjectId);
  assertTextIntegrity(nonEmpty(value.displayName, 'displayName', 300), 'displayName');
  assertTextIntegrity(nonEmpty(value.objective, 'objective', 4_000), 'objective');
  assertTextIntegrity(nonEmpty(value.scope, 'scope', 20_000), 'scope');
  const organizations = new Set(registry.organizations.map((item) => item.id));
  if (!organizations.has(value.primaryOrganizationId)) {
    throw new Error('primary organization is not registered');
  }
  const collaborators = uniqueStrings(value.collaboratingOrganizationIds, 'collaborating organizations');
  if (collaborators.includes(value.primaryOrganizationId)) {
    throw new Error('collaborating organization cannot equal primary organization');
  }
  if (collaborators.some((item) => !organizations.has(item))) {
    throw new Error('collaborating organization is not registered');
  }
  const publicSkills = new Set(registry.publicSkills.map((item) => item.id));
  if (uniqueStrings(value.publicSkillIds, 'public skills').some((item) => !publicSkills.has(item))) {
    throw new Error('public skill is not registered');
  }
  enumValue(value.status, new Set(BUSINESS_PROJECT_STATUSES), 'project status');
  positiveInteger(value.contextVersion, 'contextVersion');
  nonEmpty(value.sourceMessageId, 'sourceMessageId', 500);
  assertTextIntegrity(nonEmpty(value.commanderTaskId, 'commanderTaskId', 500), 'commanderTaskId');
  optionalText(value.feishuChatId, 'feishuChatId', 500);
  optionalText(value.codexThreadId, 'codexThreadId', 500);
  isoTimestamp(value.createdAt, 'createdAt');
  isoTimestamp(value.updatedAt, 'updatedAt');
  for (const field of ['completedAt', 'cancelledAt', 'archivedAt']) {
    optionalIsoTimestamp(value[field], field);
  }
  return deepFreeze(structuredClone(value));
}

export function validateProjectAssignment(value) {
  assertPlainObject(value, 'project assignment');
  assertExactFields(value, ASSIGNMENT_FIELDS, 'project assignment');
  if (value.schemaVersion !== 1) throw new Error('project assignment schemaVersion must be 1');
  nonEmpty(value.taskId, 'taskId', 500);
  requireEnterpriseId(value.enterpriseId);
  requireBusinessProjectId(value.businessProjectId);
  positiveInteger(value.projectContextVersion, 'projectContextVersion');
  isoTimestamp(value.createdAt, 'createdAt');
  return deepFreeze(structuredClone(value));
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertRegistry(registry) {
  assertPlainObject(registry, 'registry');
  if (!Array.isArray(registry.organizations) || !Array.isArray(registry.publicSkills)) {
    throw new TypeError('registry is invalid');
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactFields(value, expected, label) {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} has unexpected field: ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required field: ${key}`);
  }
}

function nonEmpty(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${label} exceeds size limit`);
  return result;
}

function optionalText(value, label, maximum) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (value.length > maximum) throw new Error(`${label} exceeds size limit`);
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const items = value.map((item) => nonEmpty(item, label, 160));
  if (new Set(items).size !== items.length) throw new Error(`${label} contain duplicates`);
  return items;
}

function enumValue(value, values, label) {
  if (!values.has(value)) throw new Error(`${label} is invalid`);
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function optionalIsoTimestamp(value, label) {
  if (value === '') return;
  isoTimestamp(value, label);
}
