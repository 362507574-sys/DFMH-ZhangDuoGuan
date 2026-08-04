import { deepFreeze } from './strict_json.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,80}$/u;
const TASK_ID = /^[0-9]{8}-[0-9]{3}-[a-z0-9-]{3,80}$/u;

const STRATEGY_COVERAGE = Object.freeze([
  'enterprise-direction',
  'development-path',
  'resource-allocation',
  'ninety-day-action-plan',
]);

const STAGES = Object.freeze([
  stage('bind-context', '绑定企业、项目、任务、上游企业分析和精确证据版本', [], [
    'runtime-state.json',
  ]),
  stage('knowledge-preflight', '完成飞书知识前置并保存来源凭证', ['bind-context'], [
    'evidence/knowledge-context.json',
  ]),
  stage('define-strategic-question', '把企业核心问题转成战略选择题和决策约束', [
    'knowledge-preflight',
  ], ['drafts/strategic-question.json']),
  stage('build-strategic-options', '形成至少两个实质不同的战略选项及机会成本', [
    'define-strategic-question',
  ], ['drafts/strategic-options.json']),
  stage('set-enterprise-direction', '明确企业方向、目标客户、价值焦点和不做边界', [
    'build-strategic-options',
  ], ['drafts/enterprise-direction.json']),
  stage('design-development-path', '设计阶段路径、依赖、退出标准和里程碑', [
    'set-enterprise-direction',
  ], ['drafts/development-path.json']),
  stage('allocate-resources', '配置预算、人力、渠道和管理注意力并消解冲突', [
    'design-development-path',
  ], ['drafts/resource-allocation.json']),
  stage('build-ninety-day-plan', '形成负责人、时间窗、指标、证据和停止条件完整的90天行动', [
    'allocate-resources',
  ], ['drafts/ninety-day-action-plan.json']),
  stage('debug-and-handoff', '调试战略一致性并准备商业模式和执行组织下游简报', [
    'build-ninety-day-plan',
  ], [
    'candidates/strategy-planning-v<n>.json',
    'debug-reports/candidate-v<n>/<root-cause>/attempt-<n>.json',
    'publication-requests/strategy-planning-v<n>.json',
  ]),
]);

export function buildStrategyPlanningPlan({
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
  const upstream = bindings.filter((item) => item.artifactId === 'enterprise-analysis');
  if (upstream.length !== 1) {
    throw new Error('strategy planning requires exactly one enterprise-analysis binding');
  }
  return deepFreeze({
    schemaVersion: 1,
    capabilityId: 'strategy-planning',
    enterpriseId,
    businessProjectId,
    taskId,
    planVersion,
    objective: objective.trim(),
    strategyCoverage: [...STRATEGY_COVERAGE],
    artifactBindings: bindings,
    evidenceBindings: validateEvidenceBindings(evidenceBindings),
    requiredInputs: [
      'published-enterprise-analysis-version-and-sha256',
      'enterprise-owner-strategic-objective',
      'resource-capacity-and-hard-constraints',
      'current-operating-metrics',
      'knowledge-preflight-credential',
    ],
    stages: STAGES.map((item) => structuredClone(item)),
    reviewCheckpoints: [
      'upstream-and-strategic-question-review',
      'option-distinctness-and-tradeoff-review',
      'path-and-resource-conflict-review',
      'ninety-day-executability-and-publication-boundary-review',
    ],
    stopConditions: [
      'project-cancelled-or-archived',
      'enterprise-project-or-task-identity-mismatch',
      'pinned-enterprise-analysis-hash-mismatch',
      'same-root-cause-failed-three-times',
      'missing-irreplaceable-resource-boundary',
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
