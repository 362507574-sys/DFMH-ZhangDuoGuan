import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnterpriseStore } from '../scripts/enterprise_store.mjs';
import { createOrganizationTaskStore } from '../scripts/organization_task_store.mjs';
import {
  accessEnvelope,
  enterpriseProfile,
  makeProjectFixture,
  organizationTask,
} from './helpers.mjs';

const now = () => new Date('2026-07-28T01:00:00.000Z');

test('企业战略档案隔离敏感财务字段并拒绝跨企业和版本覆盖', async () => {
  const projectRoot = await makeProjectFixture();
  const store = await createEnterpriseStore({ projectRoot, now });
  await store.createProfile(enterpriseProfile());
  const hidden = await store.readProfile({
    enterpriseId: 'acme-demo',
    accessEnvelope: accessEnvelope(),
  });
  assert.deepEqual(hidden.sensitive, {});
  const visible = await store.readProfile({
    enterpriseId: 'acme-demo',
    accessEnvelope: accessEnvelope('acme-demo', ['strategy.read', 'enterprise.financials.read']),
  });
  assert.equal(visible.sensitive.financials.revenue, 1000000);
  await assert.rejects(
    store.readProfile({
      enterpriseId: 'acme-demo',
      accessEnvelope: accessEnvelope('beta-demo'),
    }),
    /cross-enterprise|enterprise must match/u,
  );
  await assert.rejects(
    store.updateProfile({
      enterpriseId: 'acme-demo',
      expectedVersion: 2,
      patch: { unknowns: [] },
      accessEnvelope: accessEnvelope('acme-demo', ['strategy.draft.write']),
    }),
    /version conflict/u,
  );
});

test('企业分析任务按状态推进、恢复并保持幂等', async () => {
  const projectRoot = await makeProjectFixture();
  const store = await createOrganizationTaskStore({ projectRoot, now });
  const created = await store.createTask(organizationTask());
  assert.deepEqual(await store.createTask(organizationTask()), created);
  const identifying = await store.transition({
    enterpriseId: 'acme-demo',
    taskId: created.taskId,
    from: 'received',
    to: 'identifying_context',
    expectedRevision: 1,
    accessEnvelope: accessEnvelope('acme-demo', ['strategy.draft.write']),
  });
  const preflight = await store.transition({
    enterpriseId: 'acme-demo',
    taskId: created.taskId,
    from: 'identifying_context',
    to: 'knowledge_preflight',
    expectedRevision: identifying.revision,
    accessEnvelope: accessEnvelope('acme-demo', ['strategy.draft.write']),
  });
  const analyzing = await store.transition({
    enterpriseId: 'acme-demo',
    taskId: created.taskId,
    from: 'knowledge_preflight',
    to: 'analyzing',
    expectedRevision: preflight.revision,
    knowledgeStatus: 'no_hit',
    evidenceRefs: ['evidence/knowledge_context.json'],
    accessEnvelope: accessEnvelope('acme-demo', ['strategy.draft.write']),
  });
  assert.equal(analyzing.status, 'analyzing');
  const restored = await (await createOrganizationTaskStore({ projectRoot, now })).readTask({
    enterpriseId: 'acme-demo',
    taskId: created.taskId,
    accessEnvelope: accessEnvelope(),
  });
  assert.equal(restored.revision, analyzing.revision);
  await assert.rejects(
    store.transition({
      enterpriseId: 'acme-demo',
      taskId: created.taskId,
      from: 'analyzing',
      to: 'archived_formal',
      expectedRevision: analyzing.revision,
      accessEnvelope: accessEnvelope('acme-demo', ['strategy.draft.write']),
    }),
    /not allowed/u,
  );
});

test('同一根因第三次失败后进入failed终态', async () => {
  const projectRoot = await makeProjectFixture();
  const store = await createOrganizationTaskStore({ projectRoot, now });
  const created = await store.createTask(organizationTask());
  const params = {
    enterpriseId: 'acme-demo',
    taskId: created.taskId,
    rootCauseId: 'acme-demo|enterprise-analysis|knowledge|timeout',
    errorCode: 'knowledge_timeout',
    evidenceRefs: ['evidence/failure.json'],
    accessEnvelope: accessEnvelope('acme-demo', ['strategy.draft.write']),
  };
  await store.recordFailure(params);
  await store.recordFailure(params);
  const failed = await store.recordFailure(params);
  assert.equal(failed.status, 'failed');
  await assert.rejects(
    store.transition({
      enterpriseId: 'acme-demo',
      taskId: created.taskId,
      from: 'failed',
      to: 'analyzing',
      expectedRevision: failed.revision,
      accessEnvelope: params.accessEnvelope,
    }),
    /terminal/u,
  );
});
