import { deepFreeze } from './strict_json.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,80}$/u;
const TASK_ID = /^[0-9]{8}-[0-9]{3}-[a-z0-9-]{3,80}$/u;
const REQUIRED_UPSTREAMS = Object.freeze(['enterprise-analysis', 'strategy-planning']);

const COVERAGE = Object.freeze([
  'product-structure',
  'profit-model',
  'customer-value-chain',
  'growth-model',
]);

const STAGES = Object.freeze([
  stage('bind-context', '绑定企业、项目、任务、双上游和项目证据精确版本', [], [
    'runtime-state.json',
  ]),
  stage('knowledge-preflight', '完成飞书知识前置并保存来源凭证', ['bind-context'], [
    'evidence/knowledge-context.json',
  ]),
  stage('build-evidence-ledger', '区分事实、推断、假设和未知商业变量', [
    'knowledge-preflight',
  ], ['evidence/evidence-ledger.json']),
  stage('map-customer-and-products', '建立客户角色、产品层级、交付物和升级路径', [
    'build-evidence-ledger',
  ], ['drafts/product-structure.json']),
  stage('connect-value-and-delivery', '连接客户问题、价值主张、产品交付与范围边界', [
    'map-customer-and-products',
  ], ['drafts/value-and-delivery.json']),
  stage('model-profit-engine', '建立收入、成本、回款、单位经济和盈亏平衡条件', [
    'connect-value-and-delivery',
  ], ['drafts/profit-model.json']),
  stage('map-customer-value-chain', '建立获客到复购的完整价值链、负责人和指标', [
    'model-profit-engine',
  ], ['drafts/customer-value-chain.json']),
  stage('design-growth-model', '建立增长公式、杠杆、容量约束和验证实验', [
    'map-customer-value-chain',
  ], ['drafts/growth-model.json']),
  stage('debug-and-handoff', '调试商业闭环并准备控制中心发布请求', [
    'design-growth-model',
  ], [
    'candidates/business-model-v<n>.json',
    'debug-reports/candidate-v<n>/<root-cause>/attempt-<n>.json',
    'publication-requests/business-model-v<n>.json',
  ]),
]);

export function buildBusinessModelPlan({
  enterpriseId,
  businessProjectId,
  taskId,
  objective,
  planVersion = 1,
  artifactBindings = [],
  evidenceBindings = [],
  createdAt = new Date().toISOString(),
} = {}) {
  requireId(enterpriseId, 'enterpriseId', SAFE_ID);
  requireId(businessProjectId, 'businessProjectId', TASK_ID);
  requireId(taskId, 'taskId', TASK_ID);
  if (typeof objective !== 'string' || !objective.trim()) throw new Error('objective is required');
  if (!Number.isInteger(planVersion) || planVersion < 1) {
    throw new Error('planVersion must be a positive integer');
  }
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('createdAt must be an ISO date');
  const bindings = validateArtifactBindings(artifactBindings);
  const ids = bindings.map((item) => item.artifactId);
  if (bindings.length !== REQUIRED_UPSTREAMS.length
    || REQUIRED_UPSTREAMS.some((id) => !ids.includes(id))) {
    throw new Error('business model requires exact enterprise-analysis and strategy-planning bindings');
  }
  return deepFreeze({
    schemaVersion: 1,
    capabilityId: 'business-model',
    enterpriseId,
    businessProjectId,
    taskId,
    planVersion,
    objective: objective.trim(),
    businessModelCoverage: [...COVERAGE],
    artifactBindings: bindings,
    evidenceBindings: validateEvidenceBindings(evidenceBindings),
    requiredInputs: [
      'published-enterprise-analysis-version-and-sha256',
      'published-strategy-planning-version-and-sha256',
      'customer-product-delivery-materials',
      'price-cost-conversion-repurchase-evidence-or-unknown-register',
      'knowledge-preflight-credential',
    ],
    stages: STAGES.map((item) => structuredClone(item)),
    reviewCheckpoints: [
      'dual-upstream-and-evidence-review',
      'customer-product-value-review',
      'profit-and-unit-economics-review',
      'value-chain-growth-and-publication-boundary-review',
    ],
    stopConditions: [
      'project-cancelled-or-archived',
      'enterprise-project-or-task-identity-mismatch',
      'pinned-upstream-identity-or-hash-mismatch',
      'same-root-cause-failed-three-times',
      'missing-irreplaceable-customer-or-cost-fact',
      'new-permission-payment-or-external-publication-required',
    ],
    outputRoot: `organizations/ai-helmsman/tasks/${taskId}`,
    createdAt,
  });
}

function stage(id, purpose, dependencies, outputs) {
  return Object.freeze({
    id,
    purpose,
    dependencies: Object.freeze([...dependencies]),
    outputs: Object.freeze([...outputs]),
  });
}

function validateArtifactBindings(value) {
  if (!Array.isArray(value)) throw new TypeError('artifactBindings must be an array');
  const seen = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`artifactBindings[${index}] must be an object`);
    }
    requireId(item.artifactId, `artifactBindings[${index}].artifactId`, SAFE_ID);
    requireId(
      item.sourceOrganizationId,
      `artifactBindings[${index}].sourceOrganizationId`,
      SAFE_ID,
    );
    if (!Number.isInteger(item.version) || item.version < 1) {
      throw new Error(`artifactBindings[${index}].version must be exact`);
    }
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      throw new Error(`artifactBindings[${index}].sha256 is invalid`);
    }
    const key = `${item.artifactId}@${item.version}`;
    if (seen.has(key)) throw new Error('artifact binding is duplicated');
    seen.add(key);
    return {
      artifactId: item.artifactId,
      version: item.version,
      sha256: item.sha256,
      sourceOrganizationId: item.sourceOrganizationId,
    };
  }).sort((left, right) => (
    left.artifactId.localeCompare(right.artifactId) || left.version - right.version
  ));
}

function validateEvidenceBindings(value) {
  if (!Array.isArray(value)) throw new TypeError('evidenceBindings must be an array');
  const seen = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`evidenceBindings[${index}] must be an object`);
    }
    requireId(item.evidenceId, `evidenceBindings[${index}].evidenceId`, SAFE_ID);
    if (!Number.isInteger(item.revision) || item.revision < 1) {
      throw new Error(`evidenceBindings[${index}].revision must be positive`);
    }
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      throw new Error(`evidenceBindings[${index}].sha256 is invalid`);
    }
    if (typeof item.sourceRef !== 'string' || !item.sourceRef.trim() || escapes(item.sourceRef)) {
      throw new Error(`evidenceBindings[${index}].sourceRef is invalid`);
    }
    const key = `${item.evidenceId}@${item.revision}`;
    if (seen.has(key)) throw new Error('evidence binding is duplicated');
    seen.add(key);
    return {
      evidenceId: item.evidenceId,
      revision: item.revision,
      sha256: item.sha256,
      sourceRef: item.sourceRef.trim().replace(/\\/gu, '/'),
    };
  }).sort((left, right) => (
    left.evidenceId.localeCompare(right.evidenceId) || left.revision - right.revision
  ));
}

function requireId(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is invalid or unsafe`);
  }
}

function escapes(value) {
  const normalized = value.trim().replace(/\\/gu, '/');
  return normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').includes('..');
}
