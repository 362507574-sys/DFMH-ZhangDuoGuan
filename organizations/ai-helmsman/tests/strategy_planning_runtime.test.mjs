import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectArtifactStore } from '../../../scripts/control-center/project_artifact_store.mjs';
import { sha256File } from '../../../scripts/feishu-commander/atomic_store.mjs';
import {
  enterpriseProfile,
  knowledgeContext,
  organizationTask,
  writeJson,
} from './helpers.mjs';
import { validStrategyCandidate } from './strategy_planning.test.mjs';

const plannerModule = await import('../scripts/strategy_planning_planner.mjs').catch(() => null);
const debuggerModule = await import('../scripts/strategy_planning_debugger.mjs').catch(() => null);
const runtimeModule = await import('../scripts/strategy_planning_runtime.mjs').catch(() => null);

const enterpriseId = 'enterprise-8877665544332211';
const businessProjectId = '20260729-002-strategy-project';
const taskId = '20260729-002-strategy-planning';
const analysisSha256 = 'a'.repeat(64);

test('规划器覆盖企业方向发展路径资源配置和90天行动且不区分单次长期', () => {
  assert.ok(plannerModule, 'strategy planning planner module must exist');
  const plan = plannerModule.buildStrategyPlanningPlan({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '确定企业方向、发展路径、资源配置和90天行动',
    artifactBindings: [{
      artifactId: 'enterprise-analysis',
      version: 1,
      sha256: analysisSha256,
      sourceOrganizationId: 'ai-helmsman',
    }],
    createdAt: '2026-07-29T00:00:00.000Z',
  });
  assert.deepEqual(plan.strategyCoverage, [
    'enterprise-direction',
    'development-path',
    'resource-allocation',
    'ninety-day-action-plan',
  ]);
  assert.ok(plan.stages.length >= 9);
  assert.ok(plan.stages.every((stage) => stage.outputs.length > 0));
  assert.ok(plan.reviewCheckpoints.length >= 4);
  assert.ok(plan.stopConditions.includes('same-root-cause-failed-three-times'));
  assert.equal('mode' in plan, false);
  assert.doesNotMatch(JSON.stringify(plan), /single|long-term|单次|长期/u);
});

test('调试器识别伪双方案、资源超配、路径断裂和不可执行90天行动', () => {
  assert.ok(debuggerModule, 'strategy planning debugger module must exist');
  const candidate = completeStrategyCandidate();
  candidate.strategicOptions[1] = {
    ...candidate.strategicOptions[0],
    id: 'option-renamed',
    title: '换名后的同一方案',
  };
  candidate.resourceAllocation[1].percentage = 60;
  candidate.resourceAllocation[1].phaseRef = candidate.resourceAllocation[0].phaseRef;
  candidate.developmentPath[1].dependsOn = ['missing-phase'];
  candidate.ninetyDayPlan[0] = {
    days: '1-30',
    actions: ['推进重点工作'],
    owner: '',
    metricRefs: [],
    phaseGoalRefs: ['missing-goal'],
    evidenceRequired: [],
    stopConditions: [],
  };

  const result = debuggerModule.debugStrategyPlanningCandidate({
    candidate,
    task: strategyTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: strategyKnowledge(),
    pinnedUpstream: {
      artifactId: 'enterprise-analysis',
      version: 1,
      sha256: analysisSha256,
    },
  });

  assert.equal(result.ok, false);
  for (const code of [
    'strategic_options_not_distinct',
    'resource_allocation_over_capacity',
    'development_path_dependency_missing',
    'ninety_day_action_not_executable',
    'ninety_day_action_alignment_missing',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
});

test('调试器拒绝与运行时固定上游版本或哈希不一致的战略候选', () => {
  assert.ok(debuggerModule, 'strategy planning debugger module must exist');
  const candidate = completeStrategyCandidate();
  candidate.upstreamAnalysis.version = 2;
  const result = debuggerModule.debugStrategyPlanningCandidate({
    candidate,
    task: strategyTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: strategyKnowledge(),
    pinnedUpstream: {
      artifactId: 'enterprise-analysis',
      version: 1,
      sha256: analysisSha256,
    },
  });
  assert.ok(result.failures.some((item) => item.code === 'pinned_upstream_mismatch'));
});

test('资源按阶段分别核算容量且同阶段超配会被拦截', () => {
  const sequential = completeStrategyCandidate();
  sequential.resourceAllocation[0].percentage = 100;
  sequential.resourceAllocation[1].percentage = 100;
  const sequentialResult = debuggerModule.debugStrategyPlanningCandidate({
    candidate: sequential,
    task: strategyTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: strategyKnowledge(),
    pinnedUpstream: {
      artifactId: 'enterprise-analysis',
      version: 1,
      sha256: analysisSha256,
    },
  });
  assert.equal(
    sequentialResult.failures.some((item) => item.code === 'resource_allocation_over_capacity'),
    false,
  );

  const conflicting = completeStrategyCandidate();
  conflicting.resourceAllocation[0].percentage = 60;
  conflicting.resourceAllocation[1].percentage = 60;
  conflicting.resourceAllocation[1].phaseRef = conflicting.resourceAllocation[0].phaseRef;
  const conflictResult = debuggerModule.debugStrategyPlanningCandidate({
    candidate: conflicting,
    task: strategyTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: strategyKnowledge(),
    pinnedUpstream: {
      artifactId: 'enterprise-analysis',
      version: 1,
      sha256: analysisSha256,
    },
  });
  assert.ok(
    conflictResult.failures.some((item) => item.code === 'resource_allocation_over_capacity'),
  );
});

test('只有1至30天行动不得冒充完整90天计划', () => {
  const candidate = completeStrategyCandidate();
  candidate.ninetyDayPlan = [candidate.ninetyDayPlan[0]];
  const result = debuggerModule.debugStrategyPlanningCandidate({
    candidate,
    task: strategyTask(),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: strategyKnowledge(),
    pinnedUpstream: {
      artifactId: 'enterprise-analysis',
      version: 1,
      sha256: analysisSha256,
    },
  });
  assert.ok(result.failures.some((item) => item.code === 'ninety_day_coverage_incomplete'));
});

test('战略任务在原项目原任务暂停恢复并保持企业分析固定版本', async (t) => {
  assert.ok(runtimeModule, 'strategy planning runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const analysisV1 = await publishAnalysis(store, fixture, 1);
  const runtime = await runtimeModule.createStrategyPlanningRuntime({
    projectRoot: fixture.root,
    now: () => new Date('2026-07-29T01:00:00.000Z'),
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '确定企业方向和90天行动',
    artifactBindings: [analysisBinding(analysisV1)],
  });
  const paused = await runtime.pauseTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    reason: '等待资源边界补充',
    checkpoint: {
      completedStageIds: ['bind-context', 'define-strategic-question'],
      nextStageId: 'build-strategic-options',
      unresolvedItems: ['渠道预算上限待确认'],
    },
  });
  const resumed = await runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
  });
  assert.equal(resumed.state.status, 'analyzing');
  assert.equal(resumed.state.artifactBindings[0].artifactId, 'enterprise-analysis');
  assert.equal(resumed.state.artifactBindings[0].version, 1);
  assert.deepEqual(resumed.state.checkpoint.unresolvedItems, ['渠道预算上限待确认']);
  assert.match(initialized.taskRoot, /business-projects[\\/].+[\\/]organizations[\\/]ai-helmsman[\\/]tasks/u);
});

test('取消或归档项目不能自动初始化战略任务', async (t) => {
  assert.ok(runtimeModule, 'strategy planning runtime module must exist');
  for (const status of ['cancelled', 'archived']) {
    const fixture = await makeBusinessProjectFixture(t, { status });
    const runtime = await runtimeModule.createStrategyPlanningRuntime({ projectRoot: fixture.root });
    await assert.rejects(runtime.initializeTask({
      enterpriseId,
      businessProjectId,
      taskId,
      objective: '确定企业方向和90天行动',
      artifactBindings: [],
    }), new RegExp(status, 'u'));
  }
});

test('暂停超过三十天必须完成战略证据时效复核才能恢复', async (t) => {
  assert.ok(runtimeModule, 'strategy planning runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const analysisV1 = await publishAnalysis(store, fixture, 1);
  let currentTime = new Date('2026-07-29T00:00:00.000Z');
  const runtime = await runtimeModule.createStrategyPlanningRuntime({
    projectRoot: fixture.root,
    now: () => currentTime,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '确定企业方向和90天行动',
    artifactBindings: [analysisBinding(analysisV1)],
  });
  const paused = await runtime.pauseTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    reason: '暂停三个月',
    checkpoint: {
      completedStageIds: ['bind-context'],
      nextStageId: 'define-strategic-question',
      unresolvedItems: [],
    },
  });
  currentTime = new Date('2026-10-29T00:00:00.000Z');
  await assert.rejects(runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
  }), /freshness|时效/u);
  const resumed = await runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
    freshnessReview: {
      reviewedAt: '2026-10-29T00:00:00.000Z',
      evidenceRefs: ['inputs/resource-capacity-20261029.json'],
      outcome: 'resource-and-market-evidence-refreshed',
    },
  });
  assert.equal(resumed.state.status, 'analyzing');
  assert.equal(
    resumed.state.lastFreshnessReview.outcome,
    'resource-and-market-evidence-refreshed',
  );
});

test('通过调试后只生成发布请求并可在原任务显式采用企业分析v2重建战略v2', async (t) => {
  assert.ok(runtimeModule, 'strategy planning runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const analysisV1 = await publishAnalysis(store, fixture, 1);
  const analysisV2 = await publishAnalysis(store, fixture, 2);
  const runtime = await runtimeModule.createStrategyPlanningRuntime({
    projectRoot: fixture.root,
    now: () => new Date('2026-07-29T03:00:00.000Z'),
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '确定企业方向和90天行动',
    artifactBindings: [analysisBinding(analysisV1)],
  });
  const candidatePath = path.join(
    initialized.taskRoot,
    'candidates',
    'strategy-planning-v1.json',
  );
  await writeJson(candidatePath, completeStrategyCandidateForUpstream(analysisV1));
  const reviewed = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    candidatePath,
    rootCauseId: 'strategy-quality-review',
    validationContext: {
      task: strategyTask(),
      enterpriseProfile: enterpriseProfile(enterpriseId),
      knowledgeContext: strategyKnowledge(),
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
      decidedAt: '2026-07-29T03:00:00.000Z',
    },
  });
  assert.equal(request.artifactId, 'strategy-planning');
  assert.equal(request.status, 'awaiting_control_center_publication');
  await assert.rejects(
    store.readVersion({
      enterpriseId,
      businessProjectId,
      artifactId: 'strategy-planning',
      version: 1,
    }),
    /ENOENT|manifest/u,
  );
  const publishedStrategy = await store.publish({
    enterpriseId,
    businessProjectId,
    artifactId: 'strategy-planning',
    artifactType: 'strategy-planning-candidate',
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
      artifactId: 'strategy-planning',
      version: 1,
      sha256: publishedStrategy.sha256,
    },
  });
  const replanned = await runtime.replanTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: marked.revision,
    reason: '帝王明确采用企业分析v2修订战略',
    artifactBindings: [analysisBinding(analysisV2)],
  });
  assert.equal(marked.status, 'published');
  assert.equal(replanned.state.planVersion, 2);
  assert.equal(replanned.state.candidateVersion, 2);
  assert.equal(replanned.state.artifactBindings[0].version, 2);
  assert.match(replanned.planPath, /plans[\\/]execution-plan-v2\.json$/u);
});

test('运行时自行复核候选并拒绝外部伪造的调试通过结果', async (t) => {
  const fixture = await makeBusinessProjectFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const analysisV1 = await publishAnalysis(store, fixture, 1);
  const runtime = await runtimeModule.createStrategyPlanningRuntime({ projectRoot: fixture.root });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '确定企业方向和90天行动',
    artifactBindings: [analysisBinding(analysisV1)],
  });
  const candidatePath = path.join(
    initialized.taskRoot,
    'candidates',
    'strategy-planning-v1.json',
  );
  const invalidCandidate = completeStrategyCandidateForUpstream(analysisV1);
  invalidCandidate.enterpriseDirection.statement = '';
  await writeJson(candidatePath, invalidCandidate);
  await assert.rejects(runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    candidatePath,
    rootCauseId: 'forged-pass',
    validationContext: {
      task: strategyTask(),
      enterpriseProfile: enterpriseProfile(enterpriseId),
      knowledgeContext: strategyKnowledge(),
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

test('项目证据必须以修订号和真实SHA绑定，错误哈希拒绝进入战略计划', async (t) => {
  assert.ok(runtimeModule, 'strategy planning runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const analysisV1 = await publishAnalysis(store, fixture, 1);
  const evidencePath = path.join(fixture.projectDirectory, 'inputs', 'resource-capacity.json');
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, '{"managementAttention":100}\n', 'utf8');
  const actualSha256 = await sha256File(evidencePath);
  const runtime = await runtimeModule.createStrategyPlanningRuntime({ projectRoot: fixture.root });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '确定企业方向和90天行动',
    artifactBindings: [analysisBinding(analysisV1)],
    evidenceBindings: [{
      evidenceId: 'resource-capacity',
      revision: 1,
      sha256: actualSha256,
      sourceRef: 'inputs/resource-capacity.json',
    }],
  });
  assert.equal(initialized.state.evidenceBindings[0].sha256, actualSha256);
  await assert.rejects(runtime.replanTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    reason: '尝试绑定错误哈希',
    artifactBindings: [analysisBinding(analysisV1)],
    evidenceBindings: [{
      evidenceId: 'resource-capacity',
      revision: 2,
      sha256: 'f'.repeat(64),
      sourceRef: 'inputs/resource-capacity.json',
    }],
  }), /evidence.*hash|证据.*哈希/u);
});

function completeStrategyCandidate() {
  return validStrategyCandidate({
    enterpriseId,
    taskId,
    upstreamAnalysis: {
      capabilityId: 'enterprise-analysis',
      enterpriseId,
      taskId: '20260729-001-enterprise-analysis',
      version: 1,
      sha256: analysisSha256,
      status: 'formal',
      coreProblemRefs: ['problem-001'],
    },
    enterpriseDirection: {
      statement: '未来90天聚焦验证一个可复制经营闭环',
      targetCustomer: '已出现明确复购信号的核心客户',
      valueFocus: '可验证的客户结果',
      boundary: '不同时扩大五条业务线',
      evidenceRefs: ['E-001'],
    },
    developmentPath: [
      {
        id: 'phase-validate',
        sequence: 1,
        objective: '验证核心经营闭环',
        dependsOn: [],
        exitCriteria: ['完成三次真实客户验证'],
        milestoneRefs: ['milestone-pilot'],
      },
      {
        id: 'phase-scale',
        sequence: 2,
        objective: '复制已验证闭环',
        dependsOn: ['phase-validate'],
        exitCriteria: ['单位交付成本稳定'],
        milestoneRefs: ['milestone-scale'],
      },
    ],
    resourceAllocation: [
      {
        resourceId: 'management-attention',
        resourceType: 'attention',
        percentage: 50,
        phaseRef: 'phase-validate',
        priority: 1,
        rationale: '先解决核心经营闭环',
      },
      {
        resourceId: 'management-attention',
        resourceType: 'attention',
        percentage: 50,
        phaseRef: 'phase-scale',
        priority: 2,
        rationale: '仅在验证通过后扩展',
      },
    ],
    phaseGoals: [
      {
        id: 'goal-validate',
        phase: '1-30',
        objective: '完成首轮经营闭环验证',
        boundary: '不对外承诺结果',
      },
    ],
    metrics: [
      {
        id: 'metric-pilot',
        metric: 'validated_pilot_count',
        baseline: 0,
        target: 3,
        evidenceRefs: ['E-001'],
      },
    ],
    milestones: [
      {
        id: 'milestone-pilot',
        name: '首轮验证完成',
        due: '2026-08-28',
        successCriteria: ['完成三次真实客户验证'],
      },
      {
        id: 'milestone-scale',
        name: '复制条件满足',
        due: '2026-10-26',
        successCriteria: ['单位交付成本稳定'],
      },
    ],
    ninetyDayPlan: [
      {
        days: '1-30',
        actions: ['完成三次真实客户验证'],
        owner: 'ai-helmsman',
        metricRefs: ['metric-pilot'],
        phaseGoalRefs: ['goal-validate'],
        evidenceRequired: ['客户验证记录'],
        stopConditions: ['单位交付成本连续两次超出上限'],
      },
      {
        days: '31-60',
        actions: ['复核验证结果并修正路径'],
        owner: 'ai-helmsman',
        metricRefs: ['metric-pilot'],
        phaseGoalRefs: ['goal-validate'],
        evidenceRequired: ['阶段复盘记录'],
        stopConditions: ['核心假设未获支持'],
      },
      {
        days: '61-90',
        actions: ['验证复制条件'],
        owner: 'ai-helmsman',
        metricRefs: ['metric-pilot'],
        phaseGoalRefs: ['goal-validate'],
        evidenceRequired: ['复制条件验收记录'],
        stopConditions: ['单位交付成本不稳定'],
      },
    ],
  });
}

function completeStrategyCandidateForUpstream(upstream) {
  const candidate = completeStrategyCandidate();
  candidate.upstreamAnalysis.version = upstream.version;
  candidate.upstreamAnalysis.sha256 = upstream.sha256;
  return candidate;
}

function strategyTask() {
  return organizationTask({
    enterpriseId,
    taskId,
    requestId: taskId,
    idempotencyKey: `${enterpriseId}|${taskId}`,
    capabilityId: 'strategy-planning',
    knowledgeStatus: 'no_hit',
  });
}

function strategyKnowledge() {
  return {
    ...knowledgeContext(),
    requestId: taskId,
    capabilityId: 'ai-helmsman.strategy-planning',
  };
}

async function makeBusinessProjectFixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strategy-planning-runtime-'));
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
    ...overrides,
  });
  return { root, projectDirectory };
}

async function publishAnalysis(store, fixture, version) {
  const source = path.join(fixture.root, `enterprise-analysis-v${version}.json`);
  await writeFile(source, `${JSON.stringify({ version })}\n`, 'utf8');
  return store.publish({
    enterpriseId,
    businessProjectId,
    artifactId: 'enterprise-analysis',
    artifactType: 'enterprise-analysis-candidate',
    sourceOrganizationId: 'ai-helmsman',
    sourceTaskId: '20260729-001-enterprise-analysis',
    version,
    sourcePath: source,
    status: 'published_for_project_use',
    dependencies: [],
  });
}

function analysisBinding(published) {
  return {
    artifactId: 'enterprise-analysis',
    version: published.version,
    sha256: published.sha256,
    sourceOrganizationId: 'ai-helmsman',
  };
}
