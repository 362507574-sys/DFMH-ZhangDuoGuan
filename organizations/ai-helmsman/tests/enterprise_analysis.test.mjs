import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { sha256File } from '../../../scripts/feishu-commander/atomic_store.mjs';
import { validateEnterpriseAnalysisCandidate } from '../scripts/enterprise_analysis_contract.mjs';
import {
  checkBeforeAnalysis,
  checkCandidate,
  promoteApprovedCandidate,
} from '../scripts/enterprise_analysis_gate.mjs';
import {
  accessEnvelope,
  enterpriseProfile,
  knowledgeContext,
  makeProjectFixture,
  organizationTask,
  validCandidate,
  writeJson,
} from './helpers.mjs';

function validate(candidate) {
  return validateEnterpriseAnalysisCandidate({
    candidate,
    task: organizationTask({ knowledgeStatus: 'no_hit' }),
    enterpriseProfile: enterpriseProfile(),
    knowledgeContext: knowledgeContext(),
  });
}

test('完整企业分析候选包含证据、未知项、问题树和两个下游简报', () => {
  const result = validate(validCandidate());
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.deepEqual(result.failures, []);
});

test('拒绝无证据数字、空泛SWOT、企业不匹配和已执行重大决策', () => {
  const candidate = validCandidate({
    enterpriseId: 'beta-demo',
    metricBaseline: [{
      metric: 'revenue',
      value: 2000000,
      unit: 'CNY',
      status: 'confirmed',
      evidenceRefs: [],
    }],
    strengths: [{ statement: '优势明显', evidenceRefs: [] }],
    decisionsRequired: [{
      decision: '立即投资新业务',
      owner: 'ai-helmsman',
      executed: true,
    }],
  });
  const result = validate(candidate);
  assert.equal(result.ok, false);
  for (const code of [
    'enterprise_mismatch',
    'metric_missing_evidence',
    'analysis_statement_too_vague',
    'automatic_strategic_action',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
});

test('分析前门禁要求企业、权限与完成的知识状态', () => {
  assert.equal(checkBeforeAnalysis({
    task: organizationTask({ knowledgeStatus: 'no_hit' }),
    enterpriseProfile: enterpriseProfile(),
    knowledgeContext: knowledgeContext(),
  }).ok, true);
  assert.equal(checkBeforeAnalysis({
    task: organizationTask(),
    enterpriseProfile: enterpriseProfile(),
    knowledgeContext: null,
  }).ok, false);
});

test('只有匹配的帝王批准、版本和候选哈希才能晋级正式企业资产', async () => {
  const projectRoot = await makeProjectFixture();
  const task = organizationTask({
    status: 'approved',
    knowledgeStatus: 'no_hit',
    candidateVersion: 1,
  });
  const candidatePath = path.join(
    projectRoot,
    'organizations',
    'ai-helmsman',
    'tasks',
    'acme-demo',
    task.taskId,
    'candidates',
    'enterprise-analysis-v1.json',
  );
  await writeJson(candidatePath, validCandidate());
  const digest = await sha256File(candidatePath);
  const decision = {
    schemaVersion: 1,
    taskId: task.taskId,
    enterpriseId: 'acme-demo',
    candidateVersion: 1,
    candidateSha256: digest,
    decision: 'approve',
    decidedBy: 'enterprise-owner',
    decisionText: '确认采用该企业分析作为下一阶段输入',
    decidedAt: '2026-07-28T00:00:00.000Z',
    scope: '企业分析基线，不包含自动实施战略和商业动作',
  };
  const result = await promoteApprovedCandidate({
    projectRoot,
    task,
    enterpriseProfile: enterpriseProfile(),
    knowledgeContext: knowledgeContext(),
    candidatePath,
    decision,
    accessEnvelope: accessEnvelope('acme-demo', ['strategy.read', 'strategy.formal.write']),
  });
  assert.match(result.formalAssetRef, /assets\/enterprise-analysis\/versions\/1\.json/u);
  await writeFile(candidatePath, JSON.stringify({ ...validCandidate(), version: 2 }), 'utf8');
  await assert.rejects(
    promoteApprovedCandidate({
      projectRoot,
      task,
      enterpriseProfile: enterpriseProfile(),
      knowledgeContext: knowledgeContext(),
      candidatePath,
      decision,
      accessEnvelope: accessEnvelope('acme-demo', ['strategy.formal.write']),
    }),
    /hash.*mismatch/u,
  );
  await assert.rejects(readFile(path.join(projectRoot, 'outputs', 'result.json')), /ENOENT/u);
});

test('候选门禁复用企业分析契约', () => {
  const result = checkCandidate({
    candidate: validCandidate(),
    task: organizationTask({ knowledgeStatus: 'no_hit' }),
    enterpriseProfile: enterpriseProfile(),
    knowledgeContext: knowledgeContext(),
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});
