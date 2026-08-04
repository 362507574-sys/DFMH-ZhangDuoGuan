import { deepFreeze } from './strict_json.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,80}$/u;
const TASK_ID = /^[0-9]{8}-[0-9]{3}-[a-z0-9-]{3,80}$/u;

const ANALYSIS_COVERAGE = Object.freeze([
  'enterprise-status',
  'industry-environment',
  'competitive-situation',
  'strengths-and-constraints',
  'core-problems',
]);

const STAGES = Object.freeze([
  stage('bind-context', '绑定企业、项目、任务和精确输入版本', [], [
    'runtime-state.json',
  ]),
  stage('knowledge-preflight', '完成飞书知识前置并保存来源凭证', ['bind-context'], [
    'evidence/knowledge-context.json',
  ]),
  stage('build-evidence-ledger', '区分事实、推断、假设和未知项并登记冲突', [
    'knowledge-preflight',
  ], ['evidence/evidence-ledger.json']),
  stage('analyze-enterprise-status', '分析企业目标、产品、客户、经营阶段和指标基线', [
    'build-evidence-ledger',
  ], ['drafts/enterprise-status.json']),
  stage('analyze-environment-and-competition', '分析行业环境、竞争情况、机会和风险', [
    'build-evidence-ledger',
  ], ['drafts/environment-and-competition.json']),
  stage('diagnose-capabilities-and-problems', '分析内部优劣势并建立问题树和核心问题优先级', [
    'analyze-enterprise-status',
    'analyze-environment-and-competition',
  ], ['drafts/problem-tree.json']),
  stage('build-review-and-handoff', '形成候选、运行调试门禁并准备下游简报', [
    'diagnose-capabilities-and-problems',
  ], [
    'candidates/enterprise-analysis-v<n>.json',
    'debug-reports/attempt-<n>.json',
    'publication-requests/enterprise-analysis-v<n>.json',
  ]),
]);

export function buildEnterpriseAnalysisPlan({
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
  if (typeof objective !== 'string' || !objective.trim()) {
    throw new Error('objective is required');
  }
  if (!Number.isInteger(planVersion) || planVersion < 1) {
    throw new Error('planVersion must be a positive integer');
  }
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('createdAt must be an ISO date');
  const bindings = validateBindings(artifactBindings);
  const evidence = validateEvidenceBindings(evidenceBindings);
  return deepFreeze({
    schemaVersion: 1,
    capabilityId: 'enterprise-analysis',
    enterpriseId,
    businessProjectId,
    taskId,
    planVersion,
    objective: objective.trim(),
    analysisCoverage: [...ANALYSIS_COVERAGE],
    artifactBindings: bindings,
    evidenceBindings: evidence,
    requiredInputs: [
      'enterprise-objective',
      'products-and-services',
      'customer-and-market-materials',
      'operating-and-financial-materials-if-authorized',
      'knowledge-preflight-credential',
    ],
    stages: STAGES.map((item) => structuredClone(item)),
    reviewCheckpoints: [
      'context-and-input-version-review',
      'evidence-conflict-and-unknown-review',
      'candidate-quality-and-publication-boundary-review',
    ],
    stopConditions: [
      'project-cancelled-or-archived',
      'enterprise-project-or-task-identity-mismatch',
      'pinned-artifact-hash-mismatch',
      'same-root-cause-failed-three-times',
      'missing-irreplaceable-business-fact',
      'new-permission-payment-or-external-publication-required',
    ],
    outputRoot: `organizations/ai-helmsman/tasks/${taskId}`,
    createdAt,
  });
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
    if (typeof item.sourceRef !== 'string'
      || !item.sourceRef.trim()
      || pathLikeEscape(item.sourceRef)) {
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

function stage(id, purpose, dependencies, outputs) {
  return Object.freeze({
    id,
    purpose,
    dependencies: Object.freeze([...dependencies]),
    outputs: Object.freeze([...outputs]),
  });
}

function validateBindings(value) {
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

function requireId(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is invalid or unsafe`);
  }
}

function pathLikeEscape(value) {
  const normalized = value.trim().replace(/\\/gu, '/');
  return normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').includes('..');
}
