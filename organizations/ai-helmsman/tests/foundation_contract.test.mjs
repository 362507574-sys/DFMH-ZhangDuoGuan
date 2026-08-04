import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { projectRoot } from './helpers.mjs';

test('控制中心登记AI掌舵官为设计中且保持五组织十五技能', async () => {
  const registry = JSON.parse(await readFile(
    path.join(projectRoot, 'control-center', 'registries', 'organizations.json'),
    'utf8',
  ));
  const helmsman = registry.organizations.find((item) => item.id === 'ai-helmsman');
  assert.equal(registry.organizations.length, 5);
  assert.equal(registry.organizations.flatMap((item) => item.coreSkills).length, 15);
  assert.equal(helmsman.status, 'designing');
  assert.equal(helmsman.acceptsFormalTasks, false);
  assert.deepEqual(
    helmsman.coreSkills.map((item) => `${item.id}:${item.status}`),
    [
      'enterprise-analysis:designing',
      'strategy-planning:designing',
      'business-model:designing',
    ],
  );
});

test('AI掌舵官设计和计划完整锁定第一阶段边界', async () => {
  const design = await readFile(
    path.join(projectRoot, 'docs', 'superpowers', 'specs', '2026-07-28-ai-helmsman-design.md'),
    'utf8',
  );
  const plan = await readFile(
    path.join(projectRoot, 'docs', 'superpowers', 'plans', '2026-07-28-ai-helmsman-foundation-enterprise-analysis-pilot.md'),
    'utf8',
  );
  for (const phrase of [
    '企业分析技能',
    '战略规划技能',
    '商业模式技能',
    '证据账本',
    '跨组织协作架构',
    '企业分析为`pilot`',
    '不创建空的正式Skill',
  ]) assert.match(design, new RegExp(phrase, 'u'));
  for (const phrase of ['RED', 'GREEN', '企业分析试运行', '战略规划和商业模式保持`designing`']) {
    assert.match(plan, new RegExp(phrase, 'u'));
  }
});

test('AI掌舵官三技能完成设计锁定试运行与最终验收边界', async () => {
  const [design, plan, organization, workflows] = await Promise.all([
    readFile(
      path.join(projectRoot, 'docs', 'superpowers', 'specs', '2026-07-28-ai-helmsman-three-skill-completion-design.md'),
      'utf8',
    ),
    readFile(
      path.join(projectRoot, 'docs', 'superpowers', 'plans', '2026-07-28-ai-helmsman-three-skill-completion.md'),
      'utf8',
    ),
    readFile(path.join(projectRoot, 'organizations', 'ai-helmsman', 'ORGANIZATION.md'), 'utf8'),
    readFile(path.join(projectRoot, 'organizations', 'ai-helmsman', 'WORKFLOWS.md'), 'utf8'),
  ]);
  for (const phrase of [
    '企业分析、战略规划、商业模式',
    '顺序联动门禁',
    '三个技能可标记为`pilot`',
    'acceptsFormalTasks=false',
  ]) assert.ok(design.includes(phrase), `design missing: ${phrase}`);
  for (const phrase of ['Task 1', 'Task 2', 'Task 3', '真实项目三技能串联试运行']) {
    assert.ok(plan.includes(phrase), `plan missing: ${phrase}`);
  }
  for (const phrase of ['企业分析', '战略规划', '商业模式', '`pilot`', '帝王最终验收']) {
    assert.ok(organization.includes(phrase), `organization missing: ${phrase}`);
  }
  for (const phrase of [
    'ENTERPRISE_ANALYSIS_PILOT.md',
    'STRATEGY_PLANNING_PILOT.md',
    'BUSINESS_MODEL_PILOT.md',
  ]) assert.ok(workflows.includes(phrase), `workflows missing: ${phrase}`);
});
