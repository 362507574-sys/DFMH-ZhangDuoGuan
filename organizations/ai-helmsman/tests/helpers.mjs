import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const organizationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const projectRoot = path.resolve(organizationRoot, '..', '..');

export async function makeProjectFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-helmsman-'));
  await mkdir(path.join(root, 'organizations', 'ai-helmsman'), { recursive: true });
  return root;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function accessEnvelope(
  enterpriseId = 'acme-demo',
  scopes = ['strategy.read'],
) {
  return {
    enterpriseId,
    allowedScopes: scopes,
    deniedScopes: [],
    expiresAt: '2099-08-04T00:00:00.000Z',
  };
}

export function enterpriseProfile(id = 'acme-demo') {
  return {
    schemaVersion: 1,
    enterpriseId: id,
    displayName: id === 'acme-demo' ? '示例企业' : '第二企业',
    region: { country: 'CN', province: '浙江省', city: '杭州市' },
    timezone: 'Asia/Shanghai',
    authorization: {
      grantedBy: 'enterprise-owner',
      grantedAt: '2026-07-28T00:00:00.000Z',
      allowedScopes: ['strategy.read', 'strategy.draft.write'],
      deniedScopes: ['enterprise.financials.read', 'enterprise.legal.read'],
    },
    strategySummary: {
      stage: 'diagnosis',
      offerings: ['企业服务'],
      customers: ['中小企业'],
      revenueLogic: '收入数据待企业授权后核对',
    },
    sensitive: {
      financials: { revenue: 1000000, currency: 'CNY' },
      ownership: { owners: ['enterprise-owner'] },
      legal: { disputes: [] },
    },
    facts: [],
    unknowns: ['真实收入、成本和利润尚未授权'],
    version: 1,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

export function organizationTask(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: '20260728-001-enterprise-analysis',
    parentTaskId: '20260728-001-enterprise-analysis',
    requestId: '20260728-001-enterprise-analysis',
    idempotencyKey: 'acme-demo|20260728-001-enterprise-analysis',
    enterpriseId: 'acme-demo',
    primaryOrganization: 'ai-helmsman',
    capabilityId: 'enterprise-analysis',
    status: 'received',
    accessEnvelope: accessEnvelope('acme-demo', ['strategy.read', 'strategy.draft.write']),
    inputRefs: [],
    knowledgeStatus: 'pending',
    candidateVersion: 0,
    revision: 1,
    failureCounts: {},
    decisionRef: null,
    approvedCandidateSha256: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

export function knowledgeContext(status = 'no_hit') {
  return {
    requestId: '20260728-001-enterprise-analysis',
    capabilityId: 'ai-helmsman.enterprise-analysis',
    status,
    sources: [],
    ...(status === 'degraded' ? { degradedReason: 'temporary service unavailable' } : {}),
  };
}

export function validCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: '20260728-001-enterprise-analysis',
    enterpriseId: 'acme-demo',
    version: 1,
    enterpriseSnapshot: {
      objective: '建立可追溯的企业经营诊断基线',
      offerings: ['企业服务'],
      customers: ['中小企业经营者'],
      revenueLogic: '真实收入结构尚未获得授权，当前不形成数字结论',
      stage: 'diagnosis',
    },
    evidenceLedger: [
      {
        id: 'E-001',
        factClass: 'fact',
        statement: '企业负责人要求先完成企业分析再制定战略',
        sourceRef: 'inputs/request.md',
        observedAt: '2026-07-28T00:00:00.000Z',
        confidence: 'high',
      },
      {
        id: 'E-002',
        factClass: 'fact',
        statement: '当前资料未包含经授权的财务报表',
        sourceRef: 'enterprises/acme-demo/profile.json',
        observedAt: '2026-07-28T00:00:00.000Z',
        confidence: 'high',
      },
      {
        id: 'E-003',
        factClass: 'inference',
        statement: '应先补齐经营指标再形成确定性资源配置建议',
        sourceRef: 'analysis/reasoning.md',
        observedAt: '2026-07-28T00:00:00.000Z',
        confidence: 'medium',
      },
    ],
    unknowns: [
      {
        question: '真实收入、成本、利润和现金流分别是多少',
        impact: '决定商业模式与资源配置是否成立',
        owner: 'enterprise-owner',
      },
    ],
    externalContext: [
      {
        dimension: 'market',
        finding: '本次没有可直接使用的外部市场证据，保持未知',
        factClass: 'unknown',
        evidenceRefs: [],
      },
    ],
    internalCapabilities: [
      {
        area: 'strategy',
        rating: 'needs-evidence',
        evidenceRefs: ['E-001', 'E-002'],
        constraints: ['缺少完整经营指标'],
      },
    ],
    metricBaseline: [
      {
        metric: 'revenue',
        value: null,
        unit: 'CNY',
        status: 'unknown',
        evidenceRefs: [],
      },
    ],
    issueTree: [
      {
        issue: '经营事实基线不完整',
        causes: ['关键财务和客户指标尚未获得授权'],
        impacts: ['战略取舍缺少可量化边界'],
        evidenceRefs: ['E-002'],
        priority: 'high',
      },
    ],
    strengths: [
      { statement: '企业负责人明确要求先分析后决策', evidenceRefs: ['E-001'] },
    ],
    constraints: [
      { statement: '关键经营指标尚未获得授权', evidenceRefs: ['E-002'] },
    ],
    opportunities: [
      { statement: '补齐证据后可建立统一经营主线', evidenceRefs: ['E-001', 'E-002'] },
    ],
    risks: [
      { statement: '在证据不足时直接定战略会放大误判', evidenceRefs: ['E-002', 'E-003'] },
    ],
    coreProblems: [
      {
        problem: '企业事实、推断和未知项尚未形成统一证据账本',
        priority: 1,
        evidenceRefs: ['E-001', 'E-002', 'E-003'],
        decisionRequired: false,
      },
    ],
    downstreamBrief: {
      strategyPlanning: {
        inputs: ['经营事实基线', '核心问题优先级'],
        decisionsNeeded: ['企业负责人确认阶段目标和资源边界'],
      },
      businessModel: {
        inputs: ['客户、产品、收入与成本证据'],
        experimentsNeeded: ['取得授权财务数据后验证单位经济模型'],
      },
    },
    decisionsRequired: [
      {
        decision: '是否授权补充财务与客户指标用于下一阶段分析',
        owner: 'enterprise-owner',
        executed: false,
      },
    ],
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}
