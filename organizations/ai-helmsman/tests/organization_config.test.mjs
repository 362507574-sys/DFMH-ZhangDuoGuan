import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadOrganizationConfig } from '../scripts/organization_config.mjs';
import { createOrganizationPaths } from '../scripts/organization_paths.mjs';
import { parseStrictJson } from '../scripts/strict_json.mjs';
import { projectRoot } from './helpers.mjs';

test('严格读取AI掌舵官身份、三技能成熟度和公共能力边界', async () => {
  const config = await loadOrganizationConfig({ projectRoot });
  assert.equal(config.id, 'ai-helmsman');
  assert.equal(config.status, 'pilot');
  assert.equal(config.acceptsFormalTasks, false);
  assert.deepEqual(
    config.coreSkills.map((item) => `${item.id}:${item.status}`),
    [
      'enterprise-analysis:pilot',
      'strategy-planning:pilot',
      'business-model:pilot',
    ],
  );
  assert.deepEqual(
    config.publicSkillDependencies.map((item) => item.id),
    ['public.promotional-poster', 'public.taobao-ecommerce-image-set'],
  );
});

test('严格JSON拒绝BOM、重复键和未知字段', () => {
  assert.throws(() => parseStrictJson('\uFEFF{"a":1}'), /BOM/u);
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate/u);
  assert.throws(
    () => parseStrictJson('{"a":1,"b":2}', { allowedKeys: new Set(['a']) }),
    /unexpected field/u,
  );
});

test('组织路径固定在AI掌舵官企业与任务目录', async () => {
  const paths = await createOrganizationPaths({ projectRoot });
  assert.equal(
    paths.enterpriseProfile('acme-demo'),
    path.join(projectRoot, 'organizations', 'ai-helmsman', 'enterprises', 'acme-demo', 'profile.json'),
  );
  assert.match(paths.candidateFile('acme-demo', '20260728-001-enterprise-analysis', 1), /enterprise-analysis-v1\.json/u);
  for (const invalid of ['..', '../other', '中文企业', 'bad id', 'C:\\outside']) {
    assert.throws(() => paths.enterpriseProfile(invalid), /invalid|unsafe/u);
  }
});
