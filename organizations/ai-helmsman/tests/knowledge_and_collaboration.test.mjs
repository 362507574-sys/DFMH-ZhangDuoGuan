import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createCollaborationRequest,
  validateCollaborationResult,
} from '../scripts/collaboration_contract.mjs';
import { runOrganizationKnowledgePreflight } from '../scripts/knowledge_preflight_adapter.mjs';
import { makeProjectFixture } from './helpers.mjs';

function preflightTask() {
  return {
    requestId: '20260728-001-enterprise-analysis',
    taskId: '20260728-001-enterprise-analysis',
    enterpriseId: 'acme-demo',
    text: '分析企业经营现状和核心问题',
    summary: '企业分析试运行',
    capabilityId: 'ai-helmsman.enterprise-analysis',
  };
}

test('知识适配接受matched、no_hit和带原因degraded并锁定证据路径', async () => {
  for (const status of ['matched', 'no_hit', 'degraded']) {
    const projectRoot = await makeProjectFixture();
    const result = await runOrganizationKnowledgePreflight({
      projectRoot,
      task: preflightTask(),
      executeCli: async ({ input, evidenceAbsolutePath }) => {
        await mkdir(path.dirname(evidenceAbsolutePath), { recursive: true });
        await writeFile(evidenceAbsolutePath, JSON.stringify({
          requestId: input.requestId,
          capabilityId: input.capabilityId,
          status,
          sources: [],
          ...(status === 'degraded' ? { degradedReason: 'temporary timeout' } : {}),
        }), 'utf8');
      },
    });
    assert.equal(result.status, status);
  }
  const projectRoot = await makeProjectFixture();
  await assert.rejects(
    runOrganizationKnowledgePreflight({
      projectRoot,
      task: { ...preflightTask(), evidencePath: '../../outputs/result.json' },
      executeCli: async () => {},
    }),
    /evidencePath.*fixed|unsafe/u,
  );
});

test('协作请求保持AI掌舵官唯一主责和单层有界范围', () => {
  const request = {
    schemaVersion: 1,
    contractVersion: 1,
    parentTaskId: '20260728-001-enterprise-analysis',
    requestId: 'growth-evidence-1',
    enterpriseId: 'acme-demo',
    primaryOrganization: 'ai-helmsman',
    requestingOrganization: 'ai-helmsman',
    targetOrganization: 'ai-growth-strategist',
    requestedCapability: 'growth-positioning',
    scope: '只提供已存在的增长机会与获客证据，不制定企业总体战略',
    evidenceRequirements: ['来源', '日期', '事实与推断分类'],
    accessEnvelope: { enterpriseId: 'acme-demo', allowedScopes: ['strategy.draft.write'], deniedScopes: [] },
    recursionDepth: 1,
    constraints: { maxDelegationDepth: 1 },
    status: 'requested',
  };
  assert.equal(createCollaborationRequest(request).primaryOrganization, 'ai-helmsman');
  assert.throws(
    () => createCollaborationRequest({ ...request, primaryOrganization: 'ai-growth-strategist' }),
    /primary organization/u,
  );
  assert.throws(
    () => createCollaborationRequest({ ...request, recursionDepth: 2 }),
    /depth/u,
  );
});

test('协作结果必须匹配请求并带有效产物哈希或证据', async () => {
  const request = {
    schemaVersion: 1,
    contractVersion: 1,
    parentTaskId: '20260728-001-enterprise-analysis',
    requestId: 'brand-evidence-1',
    enterpriseId: 'acme-demo',
    primaryOrganization: 'ai-helmsman',
    requestingOrganization: 'ai-helmsman',
    targetOrganization: 'ai-brand-officer',
    requestedCapability: 'brand-positioning',
    scope: '只返回已确认品牌定位和品牌承诺，不修改父任务战略结论',
    evidenceRequirements: ['来源', '版本', '批准状态'],
    accessEnvelope: { enterpriseId: 'acme-demo', allowedScopes: ['strategy.draft.write'], deniedScopes: [] },
    recursionDepth: 1,
    constraints: { maxDelegationDepth: 1 },
    status: 'requested',
  };
  await assert.rejects(
    validateCollaborationResult({
      request,
      result: {
        contractVersion: 1,
        parentTaskId: request.parentTaskId,
        requestId: request.requestId,
        enterpriseId: request.enterpriseId,
        primaryOrganization: request.primaryOrganization,
        respondingOrganization: request.targetOrganization,
        requestedCapability: request.requestedCapability,
        status: 'completed',
        artifacts: [],
        evidence: [],
      },
    }),
    /requires evidence/u,
  );
});
