import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectArtifactStore } from '../../../scripts/control-center/project_artifact_store.mjs';
import {
  enterpriseProfile,
  knowledgeContext,
  organizationTask,
  writeJson,
} from './helpers.mjs';
import { validBusinessModelCandidate } from './business_model.test.mjs';

const plannerModule = await import('../scripts/business_model_planner.mjs').catch(() => null);
const debuggerModule = await import('../scripts/business_model_debugger.mjs').catch(() => null);
const runtimeModule = await import('../scripts/business_model_runtime.mjs').catch(() => null);

const enterpriseId = 'enterprise-4433221100998877';
const businessProjectId = '20260730-003-business-model-project';
const taskId = '20260730-003-business-model';
const analysisSha256 = 'a'.repeat(64);
const strategySha256 = 'b'.repeat(64);

test('规划器覆盖产品结构盈利模式客户价值链增长模型且固定双上游', () => {
  assert.ok(plannerModule, 'business model planner module must exist');
  const plan = plannerModule.buildBusinessModelPlan({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '设计并验证最小商业闭环',
    artifactBindings: [
      binding('enterprise-analysis', 1, analysisSha256),
      binding('strategy-planning', 1, strategySha256),
    ],
    createdAt: '2026-07-30T00:00:00.000Z',
  });
  assert.deepEqual(plan.businessModelCoverage, [
    'product-structure',
    'profit-model',
    'customer-value-chain',
    'growth-model',
  ]);
  assert.deepEqual(
    plan.artifactBindings.map((item) => item.artifactId),
    ['enterprise-analysis', 'strategy-planning'],
  );
  assert.ok(plan.stages.length >= 9);
  assert.ok(plan.reviewCheckpoints.length >= 4);
  assert.ok(plan.stopConditions.includes('same-root-cause-failed-three-times'));
  assert.equal('mode' in plan, false);
  assert.doesNotMatch(JSON.stringify(plan), /single|long-term|单次|长期/u);
});

test('调试器拦截产品循环、财务变量失联、价值链断裂和无验证增长', () => {
  assert.ok(debuggerModule, 'business model debugger module must exist');
  const candidate = completeBusinessModelCandidate();
  candidate.productStructure[0].dependsOn = ['offer-scale'];
  candidate.productStructure[1].dependsOn = ['offer-pilot'];
  candidate.profitModel.unitEconomicsVariableRefs = ['missing-variable'];
  candidate.customerValueChain = candidate.customerValueChain.filter(
    (item) => item.stage !== 'value-realization',
  );
  candidate.growthModel.levers[0].experimentRef = 'missing-experiment';
  candidate.growthModel.levers[0].capacityConstraint = '';

  const result = debuggerModule.debugBusinessModelCandidate({
    candidate,
    task: businessTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: businessKnowledge(),
    pinnedUpstreams: pinnedUpstreams(),
  });

  assert.equal(result.ok, false);
  for (const code of [
    'product_structure_cycle',
    'financial_variable_reference_missing',
    'customer_value_chain_incomplete',
    'growth_lever_unvalidated',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
});

test('调试器拒绝与运行时固定双上游任一版本或哈希不一致', () => {
  assert.ok(debuggerModule, 'business model debugger module must exist');
  const candidate = completeBusinessModelCandidate();
  candidate.upstreamStrategy.version = 2;
  const result = debuggerModule.debugBusinessModelCandidate({
    candidate,
    task: businessTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: businessKnowledge(),
    pinnedUpstreams: pinnedUpstreams(),
  });
  assert.ok(result.failures.some((item) => item.code === 'pinned_upstream_mismatch'));
});

test('商业模式任务暂停三个月后必须复核时效且双上游不静默升级', async (t) => {
  assert.ok(runtimeModule, 'business model runtime module must exist');
  const fixture = await makeFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const upstreamV1 = await publishUpstreamSet(store, fixture, 1);
  await publishUpstreamSet(store, fixture, 2);
  let currentTime = new Date('2026-07-30T00:00:00.000Z');
  const runtime = await runtimeModule.createBusinessModelRuntime({
    projectRoot: fixture.root,
    now: () => currentTime,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '设计并验证最小商业闭环',
    artifactBindings: upstreamV1,
  });
  const paused = await runtime.pauseTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    reason: '等待真实价格成本与复购证据',
    checkpoint: {
      completedStageIds: ['bind-context', 'map-customer-and-products'],
      nextStageId: 'model-profit-engine',
      unresolvedItems: ['真实价格', '交付成本', '复购率'],
    },
  });
  currentTime = new Date('2026-10-30T00:00:00.000Z');
  await assert.rejects(runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
    resumeKey: 'resume-after-three-months',
  }), /freshness|时效/u);
  const resumed = await runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
    resumeKey: 'resume-after-three-months',
    freshnessReview: {
      reviewedAt: '2026-10-30T00:00:00.000Z',
      evidenceRefs: ['inputs/business-evidence-refresh-20261030.json'],
      outcome: 'price-cost-conversion-delivery-repurchase-refreshed',
    },
  });
  const replayed = await runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
    resumeKey: 'resume-after-three-months',
    freshnessReview: {
      reviewedAt: '2026-10-30T00:00:00.000Z',
      evidenceRefs: ['inputs/business-evidence-refresh-20261030.json'],
      outcome: 'price-cost-conversion-delivery-repurchase-refreshed',
    },
  });
  assert.equal(resumed.status, 'analyzing');
  assert.deepEqual(replayed, resumed);
  assert.deepEqual(resumed.artifactBindings.map((item) => item.version), [1, 1]);
  assert.deepEqual(
    resumed.newVersionNotices.map((item) => item.availableVersion),
    [2, 2],
  );
});

test('运行时自行复核候选并拒绝外部伪造的商业模式通过结果', async (t) => {
  assert.ok(runtimeModule, 'business model runtime module must exist');
  const fixture = await makeFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const upstreamV1 = await publishUpstreamSet(store, fixture, 1);
  const runtime = await runtimeModule.createBusinessModelRuntime({ projectRoot: fixture.root });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '设计并验证最小商业闭环',
    artifactBindings: upstreamV1,
  });
  const candidatePath = path.join(
    initialized.taskRoot,
    'candidates',
    'business-model-v1.json',
  );
  const invalid = completeBusinessModelCandidateForBindings(upstreamV1);
  invalid.customerValueChain = [];
  await writeJson(candidatePath, invalid);
  await assert.rejects(runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    candidatePath,
    rootCauseId: 'forged-pass',
    validationContext: {
      task: businessTask(),
      enterpriseProfile: enterpriseProfile(enterpriseId),
      knowledgeContext: businessKnowledge(),
    },
    debugResult: {
      ok: true,
      attempt: 1,
      maxAttempts: 3,
      decision: 'pass',
      failures: [],
    },
  }), /independent validation|自行复核|candidate.*invalid/u);
});

test('通过调试后只生成发布请求并能在原任务显式改绑双上游形成v2', async (t) => {
  assert.ok(runtimeModule, 'business model runtime module must exist');
  const fixture = await makeFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const upstreamV1 = await publishUpstreamSet(store, fixture, 1);
  const upstreamV2 = await publishUpstreamSet(store, fixture, 2);
  const runtime = await runtimeModule.createBusinessModelRuntime({
    projectRoot: fixture.root,
    now: () => new Date('2026-07-30T03:00:00.000Z'),
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '设计并验证最小商业闭环',
    artifactBindings: upstreamV1,
  });
  const candidatePath = path.join(
    initialized.taskRoot,
    'candidates',
    'business-model-v1.json',
  );
  await writeJson(candidatePath, completeBusinessModelCandidateForBindings(upstreamV1));
  const reviewed = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    candidatePath,
    rootCauseId: 'business-model-quality-review',
    validationContext: {
      task: businessTask(),
      enterpriseProfile: enterpriseProfile(enterpriseId),
      knowledgeContext: businessKnowledge(),
    },
    debugResult: {
      ok: true,
      attempt: 1,
      maxAttempts: 3,
      decision: 'pass',
      failures: [],
    },
  });
  const request = await runtime.preparePublicationRequest({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: reviewed.state.revision,
    candidatePath,
    candidateVersion: 1,
    approval: {
      decision: 'approve',
      decidedBy: 'enterprise-owner',
      decidedAt: '2026-07-30T03:00:00.000Z',
    },
  });
  assert.equal(request.artifactId, 'business-model');
  assert.equal(request.status, 'awaiting_control_center_publication');
  await assert.rejects(store.readVersion({
    enterpriseId,
    businessProjectId,
    artifactId: 'business-model',
    version: 1,
  }), /ENOENT|manifest/u);
  const published = await store.publish({
    enterpriseId,
    businessProjectId,
    artifactId: 'business-model',
    artifactType: 'business-model-candidate',
    sourceOrganizationId: 'ai-helmsman',
    sourceTaskId: taskId,
    version: 1,
    sourcePath: candidatePath,
    status: 'published_for_project_use',
    dependencies: request.dependencies,
  });
  const marked = await runtime.markPublished({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: request.state.revision,
    publishedArtifact: {
      artifactId: 'business-model',
      version: 1,
      sha256: published.sha256,
    },
  });
  const replanned = await runtime.replanTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: marked.revision,
    reason: '帝王明确采用双上游v2和新的商业证据',
    artifactBindings: upstreamV2,
  });
  assert.equal(marked.status, 'published');
  assert.equal(replanned.state.planVersion, 2);
  assert.equal(replanned.state.candidateVersion, 2);
  assert.deepEqual(replanned.state.artifactBindings.map((item) => item.version), [2, 2]);
  assert.match(replanned.planPath, /plans[\\/]execution-plan-v2\.json$/u);
});

test('客户价值链六阶段全部存在但全部断链时拒绝通过', () => {
  const candidate = completeBusinessModelCandidate();
  candidate.customerValueChain = candidate.customerValueChain.map((item) => ({
    ...item,
    nextStageId: '',
  }));
  const result = debuggerModule.debugBusinessModelCandidate({
    candidate,
    task: businessTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: businessKnowledge(),
    pinnedUpstreams: pinnedUpstreams(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(
    (item) => item.code === 'customer_value_chain_disconnected',
  ));
});

test('客户价值链交叉倒序连接时拒绝通过', () => {
  const candidate = completeBusinessModelCandidate();
  const byStage = new Map(
    candidate.customerValueChain.map((item) => [item.stage, item]),
  );
  byStage.get('acquisition').nextStageId = byStage.get('repurchase').id;
  byStage.get('conversion').nextStageId = byStage.get('acquisition').id;
  const result = debuggerModule.debugBusinessModelCandidate({
    candidate,
    task: businessTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: businessKnowledge(),
    pinnedUpstreams: pinnedUpstreams(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(
    (item) => item.code === 'customer_value_chain_order_invalid',
  ));
});

function completeBusinessModelCandidate() {
  return validBusinessModelCandidate({
    enterpriseId,
    taskId,
    upstreamAnalysis: upstreamReference('enterprise-analysis', analysisSha256),
    upstreamStrategy: {
      ...upstreamReference('strategy-planning', strategySha256),
      status: 'formal',
    },
    productStructure: [
      {
        id: 'offer-pilot',
        level: 1,
        name: '最小商业验证项目',
        customerSegment: '需要验证AI经营价值的企业负责人',
        dependsOn: [],
        upgradeTo: ['offer-scale'],
        deliverables: ['企业分析', '战略规划', '商业模式验证报告'],
        entryCriteria: ['存在明确经营问题并完成资料授权'],
        scopeBoundary: '不替企业执行定价签约和投资',
        evidenceRefs: ['E-001', 'E-002'],
      },
      {
        id: 'offer-scale',
        level: 2,
        name: '持续经营复盘服务',
        customerSegment: '已完成最小商业验证的企业',
        dependsOn: ['offer-pilot'],
        upgradeTo: [],
        deliverables: ['周期复盘', '版本修订', '组织协作简报'],
        entryCriteria: ['最小商业验证通过'],
        scopeBoundary: '不承诺增长和盈利结果',
        evidenceRefs: ['E-001', 'E-002'],
      },
    ],
    profitModel: {
      revenueStreamRefs: ['pilot-service'],
      costCategoryRefs: ['delivery-cost'],
      unitEconomicsVariableRefs: ['validated-price', 'delivery-cost'],
      profitFormula: '单客户贡献 = 实际回款 - 获客成本 - 交付成本 - 维护成本',
      cashCollectionConstraint: '回款时间覆盖交付现金支出',
      evidenceRefs: ['E-002'],
    },
    revenueModel: [{
      id: 'pilot-service',
      stream: '商业验证项目服务费候选',
      pricingVariable: 'validated-price',
      formula: '完成并验收的项目数 × 经验证价格',
      value: null,
      status: 'hypothesis',
      evidenceRefs: ['E-002'],
    }],
    costModel: [{
      id: 'delivery-cost',
      category: '单客户交付成本',
      costVariable: 'delivery-cost',
      formula: '交付工时成本 + 工具成本 + 维护成本',
      value: null,
      status: 'unknown',
      evidenceRefs: ['E-002'],
    }],
    unitEconomics: {
      formula: '单客户贡献 = validated-price - delivery-cost',
      variables: [
        {
          id: 'validated-price',
          name: '经验证客单价',
          value: null,
          status: 'unknown',
          evidenceRefs: ['E-002'],
        },
        {
          id: 'delivery-cost',
          name: '单客户交付成本',
          value: null,
          status: 'unknown',
          evidenceRefs: ['E-002'],
        },
      ],
      breakEvenCondition: '经验证客单价大于单客户全部获客交付与维护成本',
    },
    customerValueChain: valueChain(),
    experiments: [{
      id: 'experiment-willingness-to-pay',
      assumptionRefs: ['assumption-willingness-to-pay'],
      hypothesis: '目标企业愿意为可追溯商业验证闭环付费',
      method: '完成3次授权需求访谈和1次小范围价值验证',
      metric: '明确付费意愿与交付验收结果',
      maximumDays: 45,
      maximumCost: '不新增付费工具',
      stopConditions: ['3次访谈均无明确付费问题'],
      adjustConditions: ['认可问题但不认可交付范围'],
      scaleConditions: ['至少1个真实客户完成付费或等价价值验证'],
    }],
    businessAssumptions: [{
      id: 'assumption-willingness-to-pay',
      statement: '目标企业愿意为商业验证闭环付费',
      evidenceRefs: ['E-002'],
      trigger: '取得真实付费或等价价值证据',
    }],
    growthModel: {
      formula: '有效增长 = 合格线索 × 成交率 × 交付成功率 × 留存率 × 复购率',
      levers: [{
        id: 'lever-validated-referral',
        name: '验收后的客户转介绍',
        metric: 'qualified_referral_count',
        preconditions: ['首个项目完成验收', '客户明确同意转介绍'],
        capacityConstraint: '每月新增项目不超过已验证交付容量',
        experimentRef: 'experiment-willingness-to-pay',
      }],
      constraints: ['不得用未验证投放放大未成立的单位经济'],
      stopConditions: ['交付质量下降或单位经济为负'],
    },
  });
}

function valueChain() {
  const stages = [
    'acquisition',
    'conversion',
    'delivery',
    'value-realization',
    'retention',
    'repurchase',
  ];
  return stages.map((stage, index) => ({
    id: `stage-${stage}`,
    stage,
    owner: 'ai-helmsman',
    metric: `${stage}-evidence-complete`,
    evidenceRequired: [`${stage}阶段记录`],
    exitCriteria: [`${stage}阶段由授权人验收`],
    nextStageId: stages[index + 1] ? `stage-${stages[index + 1]}` : '',
  }));
}

function businessTask() {
  return organizationTask({
    enterpriseId,
    taskId,
    requestId: taskId,
    idempotencyKey: `${enterpriseId}|${taskId}`,
    capabilityId: 'business-model',
    knowledgeStatus: 'no_hit',
  });
}

function businessKnowledge() {
  return {
    ...knowledgeContext(),
    requestId: taskId,
    capabilityId: 'ai-helmsman.business-model',
  };
}

function pinnedUpstreams() {
  return [
    { artifactId: 'enterprise-analysis', version: 1, sha256: analysisSha256 },
    { artifactId: 'strategy-planning', version: 1, sha256: strategySha256 },
  ];
}

function upstreamReference(capabilityId, sha256) {
  return {
    capabilityId,
    enterpriseId,
    taskId: capabilityId === 'enterprise-analysis'
      ? '20260730-001-enterprise-analysis'
      : '20260730-002-strategy-planning',
    version: 1,
    sha256,
  };
}

function binding(artifactId, version, sha256) {
  return {
    artifactId,
    version,
    sha256,
    sourceOrganizationId: 'ai-helmsman',
  };
}

function completeBusinessModelCandidateForBindings(bindings) {
  const candidate = completeBusinessModelCandidate();
  const byId = new Map(bindings.map((item) => [item.artifactId, item]));
  candidate.upstreamAnalysis.version = byId.get('enterprise-analysis').version;
  candidate.upstreamAnalysis.sha256 = byId.get('enterprise-analysis').sha256;
  candidate.upstreamStrategy.version = byId.get('strategy-planning').version;
  candidate.upstreamStrategy.sha256 = byId.get('strategy-planning').sha256;
  return candidate;
}

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'business-model-project-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = path.join(root, 'business-projects', enterpriseId, businessProjectId);
  await mkdir(path.join(projectDirectory, 'organizations', 'ai-helmsman'), { recursive: true });
  await mkdir(path.join(projectDirectory, 'shared-artifacts'), { recursive: true });
  await writeJson(path.join(projectDirectory, 'project.json'), {
    schemaVersion: 1,
    enterpriseId,
    businessProjectId,
    primaryOrganizationId: 'ai-helmsman',
    status: 'in_progress',
    contextVersion: 1,
  });
  return { root, projectDirectory };
}

async function publishUpstreamSet(store, fixture, version) {
  const results = [];
  for (const artifactId of ['enterprise-analysis', 'strategy-planning']) {
    const sourcePath = path.join(fixture.root, `${artifactId}-v${version}.json`);
    await writeFile(sourcePath, `${JSON.stringify({ artifactId, version })}\n`, 'utf8');
    const published = await store.publish({
      enterpriseId,
      businessProjectId,
      artifactId,
      artifactType: `${artifactId}-candidate`,
      sourceOrganizationId: 'ai-helmsman',
      sourceTaskId: artifactId === 'enterprise-analysis'
        ? '20260730-001-enterprise-analysis'
        : '20260730-002-strategy-planning',
      version,
      sourcePath,
      status: 'published_for_project_use',
      dependencies: [],
    });
    results.push(binding(artifactId, version, published.sha256));
  }
  return results.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}
