import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectArtifactStore } from '../../../scripts/control-center/project_artifact_store.mjs';
import { sha256File } from '../../../scripts/feishu-commander/atomic_store.mjs';
import {
  enterpriseProfile,
  knowledgeContext,
  organizationTask,
  validCandidate,
  writeJson,
} from './helpers.mjs';

const plannerModule = await import('../scripts/enterprise_analysis_planner.mjs').catch(() => null);
const debuggerModule = await import('../scripts/enterprise_analysis_debugger.mjs').catch(() => null);
const runtimeModule = await import('../scripts/enterprise_analysis_runtime.mjs').catch(() => null);

const enterpriseId = 'enterprise-1122334455667788';
const businessProjectId = '20260729-001-enterprise-diagnosis';
const taskId = '20260729-001-enterprise-analysis';
const artifactSha256 = '1'.repeat(64);

test('规划器覆盖截图中的五个分析面和可执行控制项且不创建单次长期模式', () => {
  assert.ok(plannerModule, 'enterprise analysis planner module must exist');
  const plan = plannerModule.buildEnterpriseAnalysisPlan({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    planVersion: 1,
    artifactBindings: [{
      artifactId: 'customer-insight',
      version: 1,
      sha256: artifactSha256,
      sourceOrganizationId: 'ai-deal-officer',
    }],
    createdAt: '2026-07-29T00:00:00.000Z',
  });

  assert.equal(plan.enterpriseId, enterpriseId);
  assert.equal(plan.businessProjectId, businessProjectId);
  assert.equal(plan.taskId, taskId);
  const coverage = new Set(plan.analysisCoverage);
  for (const dimension of [
    'enterprise-status',
    'industry-environment',
    'competitive-situation',
    'strengths-and-constraints',
    'core-problems',
  ]) assert.ok(coverage.has(dimension), dimension);
  assert.ok(plan.stages.length >= 7);
  assert.ok(plan.stages.every((stage) => stage.outputs.length > 0));
  assert.ok(plan.reviewCheckpoints.length >= 3);
  assert.ok(plan.stopConditions.includes('same-root-cause-failed-three-times'));
  assert.deepEqual(plan.artifactBindings[0], {
    artifactId: 'customer-insight',
    version: 1,
    sha256: artifactSha256,
    sourceOrganizationId: 'ai-deal-officer',
  });
  assert.equal('mode' in plan, false);
  assert.doesNotMatch(JSON.stringify(plan), /single|long-term|单次|长期/u);
});

test('调试器定位无效证据、未解决冲突、因果自循环和重复核心问题', () => {
  assert.ok(debuggerModule, 'enterprise analysis debugger module must exist');
  const candidate = validCandidate({
    enterpriseId,
    taskId,
  });
  candidate.evidenceLedger[0].conflictsWith = ['E-002'];
  candidate.evidenceLedger[0].conflictResolution = '';
  candidate.strengths[0].evidenceRefs = ['E-404'];
  candidate.issueTree[0].causes = [candidate.issueTree[0].issue];
  candidate.coreProblems.push({
    ...candidate.coreProblems[0],
    priority: 2,
    problem: ` ${candidate.coreProblems[0].problem} `,
  });

  const result = debuggerModule.debugEnterpriseAnalysisCandidate({
    candidate,
    task: organizationTask({
      enterpriseId,
      taskId,
      requestId: taskId,
      knowledgeStatus: 'no_hit',
    }),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: {
      ...knowledgeContext(),
      requestId: taskId,
    },
    attempt: 1,
    maxAttempts: 3,
  });

  assert.equal(result.ok, false);
  for (const code of [
    'unknown_evidence_ref',
    'unresolved_source_conflict',
    'circular_issue_cause',
    'duplicate_core_problem',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
  assert.equal(result.decision, 'waiting_input');
});

test('冲突处理必须记录口径时效可信度采用方式和影响', () => {
  assert.ok(debuggerModule, 'enterprise analysis debugger module must exist');
  const candidate = validCandidate({ enterpriseId, taskId });
  candidate.evidenceLedger[0].conflictsWith = ['E-002'];
  candidate.evidenceLedger[0].conflictResolution = '采用第一份材料';
  const incomplete = debuggerModule.debugEnterpriseAnalysisCandidate({
    candidate,
    task: organizationTask({
      enterpriseId,
      taskId,
      requestId: taskId,
      knowledgeStatus: 'no_hit',
    }),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: { ...knowledgeContext(), requestId: taskId },
  });
  assert.ok(incomplete.failures.some((item) => item.code === 'conflict_resolution_incomplete'));

  candidate.evidenceLedger[0].conflictResolution = {
    sourceScope: '材料A为回款口径，材料B为订单口径',
    timeScope: '均核对2026年第二季度',
    confidenceAssessment: '材料A来自财务原表，可信度高',
    adoptionMethod: '回款结论采用A，订单情景保留B',
    impact: '核心问题排序不变，收入数字保持双情景',
  };
  const complete = debuggerModule.debugEnterpriseAnalysisCandidate({
    candidate,
    task: organizationTask({
      enterpriseId,
      taskId,
      requestId: taskId,
      knowledgeStatus: 'no_hit',
    }),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: { ...knowledgeContext(), requestId: taskId },
  });
  assert.equal(
    complete.failures.some((item) => item.code.startsWith('conflict_resolution')),
    false,
  );
});

test('同一根因第三轮仍失败时调试器停止而不是无限重试', () => {
  assert.ok(debuggerModule, 'enterprise analysis debugger module must exist');
  const candidate = validCandidate({ enterpriseId, taskId });
  candidate.strengths[0].evidenceRefs = ['E-404'];
  const result = debuggerModule.debugEnterpriseAnalysisCandidate({
    candidate,
    task: organizationTask({
      enterpriseId,
      taskId,
      requestId: taskId,
      knowledgeStatus: 'no_hit',
    }),
    enterpriseProfile: enterpriseProfile(enterpriseId),
    knowledgeContext: {
      ...knowledgeContext(),
      requestId: taskId,
    },
    attempt: 3,
    maxAttempts: 3,
  });
  assert.equal(result.ok, false);
  assert.equal(result.decision, 'stop');
});

test('项目任务可暂停并在原项目原任务恢复且保持固定上游版本', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const sourceV1 = path.join(fixture.root, 'customer-insight-v1.md');
  const sourceV2 = path.join(fixture.root, 'customer-insight-v2.md');
  await writeFile(sourceV1, '# 客户洞察 v1\n', 'utf8');
  await writeFile(sourceV2, '# 客户洞察 v2\n', 'utf8');
  const publishedV1 = await store.publish(publication(fixture, sourceV1, 1));
  await store.publish(publication(fixture, sourceV2, 2));
  await store.setCurrentVersion({
    enterpriseId,
    businessProjectId,
    artifactId: 'customer-insight',
    expectedCurrentVersion: 1,
    nextVersion: 2,
  });
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
    now: () => new Date('2026-07-29T01:00:00.000Z'),
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [{
      artifactId: 'customer-insight',
      version: 1,
      sha256: publishedV1.sha256,
      sourceOrganizationId: 'ai-deal-officer',
    }],
  });
  const paused = await runtime.pauseTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    reason: '帝王暂时停止本次分析',
    checkpoint: {
      completedStageIds: ['bind-context', 'build-evidence-ledger'],
      nextStageId: 'analyze-enterprise-status',
      unresolvedItems: ['客户流失口径仍待确认'],
    },
  });
  const resumed = await runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
  });

  assert.equal(resumed.state.status, 'analyzing');
  assert.equal(resumed.state.enterpriseId, enterpriseId);
  assert.equal(resumed.state.businessProjectId, businessProjectId);
  assert.equal(resumed.state.taskId, taskId);
  assert.equal(resumed.state.artifactBindings[0].version, 1);
  assert.deepEqual(paused.checkpoint.unresolvedItems, ['客户流失口径仍待确认']);
  assert.deepEqual(paused.checkpoint.failureCounts, {});
  assert.equal(resumed.newVersionNotices[0].availableVersion, 2);
  assert.equal(resumed.newVersionNotices[0].boundVersion, 1);
});

test('暂停超过三十天后必须绑定证据时效复核才能恢复', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  let currentTime = new Date('2026-07-29T00:00:00.000Z');
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
    now: () => currentTime,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
  });
  const paused = await runtime.pauseTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    reason: '暂停三个月',
    checkpoint: {
      completedStageIds: ['bind-context'],
      nextStageId: 'build-evidence-ledger',
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
      evidenceRefs: ['evidence/market-refresh-20261029.json'],
      outcome: 'time-sensitive-evidence-refreshed',
    },
  });
  assert.equal(resumed.state.status, 'analyzing');
  assert.equal(resumed.state.lastFreshnessReview.outcome, 'time-sensitive-evidence-refreshed');
});

test('相同任务和相同固定依赖重复初始化保持幂等且不受输入顺序影响', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
  });
  const bindings = [
    {
      artifactId: 'customer-insight',
      version: 1,
      sha256: '1'.repeat(64),
      sourceOrganizationId: 'ai-deal-officer',
    },
    {
      artifactId: 'brand-positioning',
      version: 2,
      sha256: '2'.repeat(64),
      sourceOrganizationId: 'ai-brand-officer',
    },
  ];
  const first = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: bindings,
  });
  const second = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: bindings,
  });
  assert.deepEqual(second.state, first.state);
  assert.deepEqual(
    second.state.artifactBindings.map((item) => item.artifactId),
    ['brand-positioning', 'customer-insight'],
  );
});

test('取消或归档项目不能自动恢复', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  for (const status of ['cancelled', 'archived']) {
    const fixture = await makeBusinessProjectFixture(t, { status });
    const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
      projectRoot: fixture.root,
    });
    await assert.rejects(runtime.resumeTask({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision: 1,
    }), new RegExp(status, 'u'));
  }
});

test('每轮纠偏都在原任务目录留下不可变调试报告', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
    now: () => new Date('2026-07-29T01:30:00.000Z'),
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
  });
  const report = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    rootCauseId: 'evidence-conflict',
    debugResult: {
      ok: false,
      attempt: 1,
      maxAttempts: 3,
      decision: 'waiting_input',
      failures: [{
        code: 'unresolved_source_conflict',
        message: '相互冲突的来源尚未记录处理方式',
        path: 'evidenceLedger[0].conflictResolution',
      }],
    },
  });
  assert.match(
    report.reportPath,
    /debug-reports[\\/]candidate-v1[\\/][a-f0-9]{64}[\\/]attempt-1\.json$/u,
  );
  assert.equal(report.state.status, 'waiting_input');
  assert.equal(Object.values(report.state.failureCounts)[0], 1);
  await assert.rejects(runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: report.state.revision,
    candidateVersion: 1,
    rootCauseId: 'evidence-conflict',
    debugResult: {
      ok: false,
      attempt: 1,
      maxAttempts: 3,
      decision: 'waiting_input',
      failures: [{
        code: 'unresolved_source_conflict',
        message: '相互冲突的来源尚未记录处理方式',
        path: 'evidenceLedger[0].conflictResolution',
      }],
    },
  }), /attempt|immutable|already exists/u);
});

test('不同候选和不同根因的调试报告互不覆盖且同根因计数不因候选升级清零', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
  });
  const first = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    rootCauseId: 'evidence-conflict',
    debugResult: {
      ok: false,
      attempt: 1,
      maxAttempts: 3,
      decision: 'waiting_input',
      failures: [{ code: 'unresolved_source_conflict', message: '冲突未解决', path: 'evidence' }],
    },
  });
  const second = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: first.state.revision,
    candidateVersion: 2,
    rootCauseId: 'evidence-conflict',
    debugResult: {
      ok: false,
      attempt: 2,
      maxAttempts: 3,
      decision: 'waiting_input',
      failures: [{ code: 'unresolved_source_conflict', message: '冲突仍未解决', path: 'evidence' }],
    },
  });
  const other = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: second.state.revision,
    candidateVersion: 2,
    rootCauseId: 'circular-cause',
    debugResult: {
      ok: false,
      attempt: 1,
      maxAttempts: 3,
      decision: 'revise',
      failures: [{ code: 'circular_issue_cause', message: '因果自循环', path: 'issueTree' }],
    },
  });
  assert.match(second.reportPath, /candidate-v2/u);
  assert.match(second.reportPath, /attempt-2\.json$/u);
  assert.notEqual(path.dirname(second.reportPath), path.dirname(other.reportPath));
  assert.deepEqual(
    Object.values(other.state.failureCounts).sort((left, right) => left - right),
    [1, 2],
  );
});

test('第三轮调试通过时不会被强制停止也不会把成功计入失败次数', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
  });
  let state = initialized.state;
  for (const attempt of [1, 2]) {
    const recorded = await runtime.recordDebugReport({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision: state.revision,
      candidateVersion: attempt,
      rootCauseId: 'evidence-conflict',
      debugResult: {
        ok: false,
        attempt,
        maxAttempts: 3,
        decision: 'revise',
        failures: [{ code: 'unresolved_source_conflict', message: '冲突未解决', path: 'evidence' }],
      },
    });
    state = recorded.state;
  }
  const candidatePath = path.join(
    initialized.taskRoot,
    'candidates',
    'enterprise-analysis-v3.json',
  );
  await writeJson(candidatePath, validCandidate({ enterpriseId, taskId, version: 3 }));
  const passed = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: state.revision,
    candidateVersion: 3,
    candidatePath,
    rootCauseId: 'evidence-conflict',
    debugResult: {
      ok: true,
      attempt: 3,
      maxAttempts: 3,
      decision: 'pass',
      failures: [],
    },
  });
  assert.equal(passed.state.status, 'waiting_review');
  assert.equal(Object.values(passed.state.failureCounts)[0], 2);
  assert.equal(passed.report.decision, 'pass');
});

test('调试结果的ok决定和失败列表必须相互一致', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
  });
  await assert.rejects(runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    rootCauseId: 'invalid-pass',
    debugResult: {
      ok: true,
      attempt: 1,
      maxAttempts: 3,
      decision: 'pass',
      failures: [{ code: 'still-broken', message: '仍有失败', path: 'candidate' }],
    },
  }), /consistent|一致|failures/u);
});

test('发布请求必须绑定当前候选真实通过的最后一份调试报告', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
  });
  const candidatePath = path.join(initialized.taskRoot, 'candidates', 'enterprise-analysis-v1.json');
  await writeJson(candidatePath, validCandidate({ enterpriseId, taskId }));
  await assert.rejects(runtime.preparePublicationRequest({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidatePath,
    candidateVersion: 1,
    approval: {
      decision: 'approve',
      decidedBy: 'enterprise-owner',
      decidedAt: '2026-07-29T02:00:00.000Z',
    },
    debugResult: { ok: true, failures: [], decision: 'pass' },
  }), /debug report|waiting_review|调试报告/u);
});

test('正式发布后的同一任务可显式改绑上游新版本并进入候选v2', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const artifactStore = await createProjectArtifactStore({ projectRoot: fixture.root });
  const customerV1 = path.join(fixture.root, 'customer-v1.md');
  const customerV2 = path.join(fixture.root, 'customer-v2.md');
  await writeFile(customerV1, '# customer v1\n', 'utf8');
  await writeFile(customerV2, '# customer v2\n', 'utf8');
  const customerPublishedV1 = await artifactStore.publish(publication(fixture, customerV1, 1));
  const customerPublishedV2 = await artifactStore.publish(publication(fixture, customerV2, 2));
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
    now: () => new Date('2026-07-29T03:00:00.000Z'),
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [{
      artifactId: 'customer-insight',
      version: 1,
      sha256: customerPublishedV1.sha256,
      sourceOrganizationId: 'ai-deal-officer',
    }],
  });
  const candidatePath = path.join(initialized.taskRoot, 'candidates', 'enterprise-analysis-v1.json');
  await writeJson(candidatePath, validCandidate({ enterpriseId, taskId }));
  const reviewed = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    candidatePath,
    rootCauseId: 'candidate-quality-review',
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
    debugResult: { ok: true, failures: [], decision: 'pass' },
  });
  const publishedAnalysis = await artifactStore.publish({
    enterpriseId,
    businessProjectId,
    artifactId: 'enterprise-analysis',
    artifactType: 'enterprise-analysis-candidate',
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
      artifactId: 'enterprise-analysis',
      version: 1,
      sha256: publishedAnalysis.sha256,
    },
  });
  const replanned = await runtime.replanTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: marked.revision,
    reason: '帝王明确采用客户洞察v2并修正企业分析',
    artifactBindings: [{
      artifactId: 'customer-insight',
      version: 2,
      sha256: customerPublishedV2.sha256,
      sourceOrganizationId: 'ai-deal-officer',
    }],
  });
  assert.equal(replanned.state.status, 'analyzing');
  assert.equal(replanned.state.planVersion, 2);
  assert.equal(replanned.state.candidateVersion, 2);
  assert.equal(replanned.state.artifactBindings[0].version, 2);
  assert.match(replanned.planPath, /plans[\\/]execution-plan-v2\.json$/u);
  assert.equal(marked.status, 'published');
});

test('同任务新增客户流失证据必须以修订号和SHA绑定后才能形成新计划', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
    evidenceBindings: [],
  });
  const evidencePath = path.join(fixture.projectDirectory, 'inputs', 'customer-churn-202607.csv');
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, 'customer_id,churned\\nC-001,true\\n', 'utf8');
  const evidenceSha256 = await sha256File(evidencePath);
  const replanned = await runtime.replanTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    reason: '新增客户流失数据并修正结论',
    artifactBindings: [],
    evidenceBindings: [{
      evidenceId: 'customer-churn',
      revision: 1,
      sha256: evidenceSha256,
      sourceRef: 'inputs/customer-churn-202607.csv',
    }],
  });
  assert.deepEqual(replanned.state.evidenceBindings, [{
      evidenceId: 'customer-churn',
      revision: 1,
      sha256: evidenceSha256,
      sourceRef: 'inputs/customer-churn-202607.csv',
  }]);
  assert.deepEqual(replanned.plan.evidenceBindings, replanned.state.evidenceBindings);
  assert.equal(replanned.state.candidateVersion, 1);
});

test('证据绑定哈希与项目舱真实文件不一致时拒绝重建计划', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const evidencePath = path.join(fixture.projectDirectory, 'inputs', 'customer-churn.csv');
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, 'customer_id,churned\\nC-001,false\\n', 'utf8');
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
    evidenceBindings: [],
  });
  await assert.rejects(runtime.replanTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    reason: '尝试绑定错误哈希',
    artifactBindings: [],
    evidenceBindings: [{
      evidenceId: 'customer-churn',
      revision: 1,
      sha256: '4'.repeat(64),
      sourceRef: 'inputs/customer-churn.csv',
    }],
  }), /evidence.*hash|证据.*哈希/u);
});

test('发布准备只在组织项目工作区生成请求且不直接写共享成果区', async (t) => {
  assert.ok(runtimeModule, 'enterprise analysis runtime module must exist');
  const fixture = await makeBusinessProjectFixture(t);
  const runtime = await runtimeModule.createEnterpriseAnalysisRuntime({
    projectRoot: fixture.root,
    now: () => new Date('2026-07-29T02:00:00.000Z'),
  });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '识别企业现状与核心问题',
    artifactBindings: [],
  });
  const candidatePath = path.join(initialized.taskRoot, 'candidates', 'enterprise-analysis-v1.json');
  await writeJson(candidatePath, validCandidate({ enterpriseId, taskId }));
  const reviewed = await runtime.recordDebugReport({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: initialized.state.revision,
    candidateVersion: 1,
    candidatePath,
    rootCauseId: 'candidate-quality-review',
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
      decidedAt: '2026-07-29T02:00:00.000Z',
    },
    debugResult: { ok: true, failures: [], decision: 'pass' },
  });

  assert.equal(request.status, 'awaiting_control_center_publication');
  assert.match(request.candidateSha256, /^[a-f0-9]{64}$/u);
  assert.match(request.requestPath, /organizations[\\/]ai-helmsman[\\/]tasks/u);
  const sharedEntries = await readdir(path.join(
    fixture.projectDirectory,
    'shared-artifacts',
  ));
  assert.deepEqual(sharedEntries, []);
  const stored = JSON.parse(await readFile(request.requestPath, 'utf8'));
  assert.equal(stored.artifactId, 'enterprise-analysis');
  assert.equal(stored.version, 1);
});

async function makeBusinessProjectFixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'enterprise-analysis-runtime-'));
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
  return { root, projectDirectory, enterpriseId, businessProjectId };
}

function publication(fixture, sourcePath, version) {
  return {
    enterpriseId: fixture.enterpriseId,
    businessProjectId: fixture.businessProjectId,
    artifactId: 'customer-insight',
    artifactType: 'customer-insight',
    sourceOrganizationId: 'ai-deal-officer',
    sourceTaskId: '20260729-001-customer-insight',
    version,
    sourcePath,
    status: 'published_for_project_use',
    dependencies: [],
  };
}
