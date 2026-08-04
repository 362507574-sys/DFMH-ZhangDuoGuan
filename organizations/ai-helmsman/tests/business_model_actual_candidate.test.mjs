import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateBusinessModelCandidate } from '../scripts/business_model_contract.mjs';
import { debugBusinessModelCandidate } from '../scripts/business_model_debugger.mjs';

const organizationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const taskRoot = path.join(
  organizationRoot,
  'tasks',
  'ai-digital-employee-control-center',
  '20260728-003-helmsman-business-model',
);
const candidatePath = path.join(
  taskRoot,
  'candidates',
  'business-model-v1.json',
);

test('实际商业模式候选通过独立契约与四域调试', async () => {
  const [candidate, task, enterpriseProfile, knowledgeContext] = await Promise.all([
    readJson(candidatePath),
    readJson(path.join(taskRoot, 'task.json')),
    readJson(path.join(
      organizationRoot,
      'enterprises',
      'ai-digital-employee-control-center',
      'profile.json',
    )),
    readJson(path.join(taskRoot, 'evidence', 'knowledge_context.json')),
  ]);
  const contract = validateBusinessModelCandidate({
    candidate,
    task,
    enterpriseProfile,
    knowledgeContext,
  });
  assert.equal(contract.ok, true, JSON.stringify(contract.failures));
  const debug = debugBusinessModelCandidate({
    candidate,
    task,
    enterpriseProfile,
    knowledgeContext,
    pinnedUpstreams: [
      {
        artifactId: 'enterprise-analysis',
        version: candidate.upstreamAnalysis.version,
        sha256: candidate.upstreamAnalysis.sha256,
      },
      {
        artifactId: 'strategy-planning',
        version: candidate.upstreamStrategy.version,
        sha256: candidate.upstreamStrategy.sha256,
      },
    ],
  });
  assert.equal(debug.ok, true, JSON.stringify(debug.failures));
});

test('掌舵官流水线固定引用实际商业模式候选哈希', async () => {
  const [candidateBytes, pipeline] = await Promise.all([
    readFile(candidatePath),
    readJson(path.join(
      organizationRoot,
      'tasks',
      'ai-digital-employee-control-center',
      '20260728-004-helmsman-pipeline',
      'candidates',
      'helmsman-pipeline-v1.json',
    )),
  ]);
  const actualSha256 = createHash('sha256').update(candidateBytes).digest('hex');
  const stage = pipeline.stages.find((item) => item.capabilityId === 'business-model');
  assert.equal(stage.sha256, actualSha256);
});

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}
