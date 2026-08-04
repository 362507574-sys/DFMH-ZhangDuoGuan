import assert from 'node:assert/strict';
import test from 'node:test';

import { createOrganizationPaths } from '../scripts/organization_paths.mjs';
import { createOrganizationTaskStore } from '../scripts/organization_task_store.mjs';
import {
  accessEnvelope,
  makeProjectFixture,
  organizationTask,
} from './helpers.mjs';

const loaded = await import('../scripts/helmsman_pipeline_contract.mjs')
  .then((module) => ({ module, error: null }))
  .catch((error) => ({ module: null, error }));

test('联合契约暴露三技能串联校验入口', () => {
  assert.equal(
    typeof loaded.module?.validateHelmsmanPipelineCandidate,
    'function',
    loaded.error?.message ?? 'validateHelmsmanPipelineCandidate missing',
  );
});

test('完整联合候选要求企业分析到战略规划再到商业模式', () => {
  if (!loaded.module) return;
  const result = loaded.module.validateHelmsmanPipelineCandidate(validPipelineCandidate());
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(Object.isFrozen(result), true);
});

test('拒绝跨企业、顺序漂移、缺哈希和自动重大动作', () => {
  if (!loaded.module) return;
  const candidate = validPipelineCandidate({
    stages: [
      {
        capabilityId: 'strategy-planning',
        enterpriseId: 'other-enterprise',
        taskId: '20260728-002-strategy-planning',
        version: 1,
        sha256: '',
        status: 'candidate',
      },
      ...validPipelineCandidate().stages.slice(1),
    ],
    decisionsRequired: [{
      decision: '立即执行全部战略动作',
      owner: 'ai-helmsman',
      executed: true,
    }],
  });
  const result = loaded.module.validateHelmsmanPipelineCandidate(candidate);
  assert.equal(result.ok, false);
  for (const code of [
    'pipeline_sequence_invalid',
    'pipeline_enterprise_mismatch',
    'pipeline_hash_invalid',
    'automatic_pipeline_action',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
});

test('组织任务底座接受三个固定能力并生成能力专属候选路径', async () => {
  const projectRoot = await makeProjectFixture();
  const store = await createOrganizationTaskStore({
    projectRoot,
    now: () => new Date('2026-07-28T00:00:00.000Z'),
  });
  for (const [index, capabilityId] of [
    'enterprise-analysis',
    'strategy-planning',
    'business-model',
  ].entries()) {
    const taskId = `20260728-00${index + 1}-${capabilityId}`;
    const created = await store.createTask(organizationTask({
      taskId,
      requestId: taskId,
      parentTaskId: '20260728-001-helmsman-pipeline',
      idempotencyKey: `acme-demo|${taskId}`,
      capabilityId,
    }));
    assert.equal(created.capabilityId, capabilityId);
  }
  const paths = await createOrganizationPaths({ projectRoot });
  assert.match(
    paths.capabilityCandidateFile(
      'acme-demo',
      '20260728-002-strategy-planning',
      'strategy-planning',
      1,
    ),
    /candidates[\\/]strategy-planning-v1\.json$/u,
  );
  assert.match(
    paths.capabilityCandidateFile(
      'acme-demo',
      '20260728-003-business-model',
      'business-model',
      2,
    ),
    /candidates[\\/]business-model-v2\.json$/u,
  );
});

export function validPipelineCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    capabilityId: 'helmsman-pipeline',
    taskId: '20260728-004-helmsman-pipeline',
    enterpriseId: 'acme-demo',
    version: 1,
    status: 'candidate',
    stages: [
      {
        capabilityId: 'enterprise-analysis',
        enterpriseId: 'acme-demo',
        taskId: '20260728-001-enterprise-analysis',
        version: 1,
        sha256: 'a'.repeat(64),
        status: 'candidate',
      },
      {
        capabilityId: 'strategy-planning',
        enterpriseId: 'acme-demo',
        taskId: '20260728-002-strategy-planning',
        version: 1,
        sha256: 'b'.repeat(64),
        status: 'candidate',
      },
      {
        capabilityId: 'business-model',
        enterpriseId: 'acme-demo',
        taskId: '20260728-003-business-model',
        version: 1,
        sha256: 'c'.repeat(64),
        status: 'candidate',
      },
    ],
    readiness: {
      enterpriseAnalysis: 'passed',
      strategyPlanning: 'passed',
      businessModel: 'passed',
    },
    unresolvedRisks: ['真实客户与财务验证仍待帝王授权'],
    decisionsRequired: [{
      decision: '是否验收三技能试运行结果',
      owner: 'emperor',
      executed: false,
    }],
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

