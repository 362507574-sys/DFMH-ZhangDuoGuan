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
import { createBusinessModelRuntime } from '../scripts/business_model_runtime.mjs';
import { projectRoot } from './helpers.mjs';

const enterpriseId = 'acme-runtime';
const businessProjectId = '20260729-901-business-model-runtime';
const taskId = '20260729-901-business-model';

test('三个核心技能运行时复用同一轻量安全适配', async () => {
  for (const relative of [
    'scripts/enterprise_analysis_runtime.mjs',
    'scripts/strategy_planning_runtime.mjs',
    'scripts/business_model_runtime.mjs',
  ]) {
    const source = await readFile(
      path.join(projectRoot, 'organizations', 'ai-helmsman', relative),
      'utf8',
    );
    assert.match(source, /shared_runtime_adapter\.mjs/u, `${relative}未复用共享运行适配`);
  }
});

test('商业模式任务持久化并以恢复键保持幂等恢复', async (t) => {
  const fixture = await makeFixture(t);
  const bindings = await publishUpstreams(fixture);
  const runtime = await createBusinessModelRuntime({
    projectRoot: fixture.root,
    now: () => new Date('2026-07-29T10:00:00.000Z'),
  });
  const input = {
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '验证客户价值到复购的最小商业闭环',
    artifactBindings: bindings,
  };

  const first = await runtime.initializeTask(input);
  const repeated = await runtime.initializeTask(input);
  assert.equal(first.state.revision, 1);
  assert.deepEqual(repeated.state, first.state);
  assert.equal(
    JSON.parse(await readFile(path.join(first.taskRoot, 'runtime-state.json'), 'utf8')).status,
    'planned',
  );

  const paused = await runtime.pauseTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: first.state.revision,
    reason: '等待真实价格与交付成本',
    checkpoint: {
      completedStageIds: ['bind-upstreams'],
      nextStageId: 'map-customer-value',
      unresolvedItems: ['真实价格', '交付成本'],
    },
  });
  const resumed = await runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
    resumeKey: 'resume-business-model-v1',
  });
  const replayed = await runtime.resumeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    expectedRevision: paused.revision,
    resumeKey: 'resume-business-model-v1',
  });

  assert.equal(resumed.status, 'analyzing');
  assert.deepEqual(replayed, resumed);
  assert.equal(replayed.revision, resumed.revision);
  assert.deepEqual(replayed.checkpoint.unresolvedItems, ['真实价格', '交付成本']);
});

test('商业模式同一根因第三次失败后停止且不能通过重建任务清零', async (t) => {
  const fixture = await makeFixture(t);
  const bindings = await publishUpstreams(fixture);
  const runtime = await createBusinessModelRuntime({ projectRoot: fixture.root });
  const initialized = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '验证客户价值到复购的最小商业闭环',
    artifactBindings: bindings,
  });
  let state = initialized.state;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state = await runtime.recordFailure({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision: state.revision,
      rootCauseId: 'missing-real-unit-economics',
      errorCode: 'UNIT_ECONOMICS_EVIDENCE_MISSING',
    });
    assert.equal(state.failureCounts['missing-real-unit-economics'], attempt);
  }
  assert.equal(state.status, 'failed');
  const repeated = await runtime.initializeTask({
    enterpriseId,
    businessProjectId,
    taskId,
    objective: '验证客户价值到复购的最小商业闭环',
    artifactBindings: bindings,
  });
  assert.equal(repeated.state.status, 'failed');
  assert.equal(repeated.state.failureCounts['missing-real-unit-economics'], 3);
});

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'business-model-runtime-'));
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

async function publishUpstreams(fixture) {
  const store = await createProjectArtifactStore({ projectRoot: fixture.root });
  const results = [];
  for (const [artifactId, version] of [
    ['enterprise-analysis', 1],
    ['strategy-planning', 1],
  ]) {
    const sourcePath = path.join(fixture.root, `${artifactId}.json`);
    await writeJson(sourcePath, { artifactId, version });
    const published = await store.publish({
      enterpriseId,
      businessProjectId,
      artifactId,
      artifactType: `${artifactId}-candidate`,
      sourceOrganizationId: 'ai-helmsman',
      sourceTaskId: `20260729-900-${artifactId}`,
      version,
      sourcePath,
      status: 'published_for_project_use',
      dependencies: [],
    });
    results.push({
      artifactId,
      version,
      sha256: published.sha256,
      sourceOrganizationId: 'ai-helmsman',
    });
  }
  return results;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
