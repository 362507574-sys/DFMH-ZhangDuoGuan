import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { projectRoot } from './helpers.mjs';

const organizationPrefix = 'organizations/ai-helmsman/';
const organizationRoot = path.join(projectRoot, 'organizations', 'ai-helmsman');
const qualityPath = path.join(organizationRoot, 'quality', 'organization-quality.json');

const EXPECTED_TOP_LEVEL_KEYS = [
  'acceptsFormalTasks',
  'accurate',
  'declaredRootStatus',
  'fast',
  'knownGaps',
  'nextOrganizationGate',
  'organizationId',
  'schemaVersion',
  'skills',
  'stable',
].sort();

const EXPECTED_SKILL_KEYS = [
  'evidenceLevel',
  'id',
  'knownGaps',
  'nextGate',
  'runtimePaths',
  'skillPath',
  'testPaths',
  'workflowPath',
].sort();

const REQUIRED_SKILL_SECTIONS = [
  '适用场景',
  '输入',
  '固定步骤',
  '输出',
  '依赖',
  '质量检查',
  '异常处理',
  '重试条件',
  '停止条件',
  '示例',
  '版本记录',
];

const REQUIRED_WORKFLOW_SECTIONS = [
  '适用场景',
  '输入门禁',
  '依赖',
  '步骤',
  '输出',
  '质量门禁',
  '异常处理',
  '重试条件',
  '停止条件',
  '试运行与晋级',
];

test('AI掌舵官质量档案严格锁定统一结构与根级边界', async () => {
  const profile = JSON.parse(await readFile(qualityPath, 'utf8'));

  assert.deepEqual(Object.keys(profile).sort(), EXPECTED_TOP_LEVEL_KEYS);
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.organizationId, 'ai-helmsman');
  assert.equal(profile.declaredRootStatus, 'designing');
  assert.equal(profile.acceptsFormalTasks, false);
  assert.deepEqual(
    profile.skills.map((item) => item.id),
    ['enterprise-analysis', 'strategy-planning', 'business-model'],
  );

  for (const skill of profile.skills) {
    assert.deepEqual(Object.keys(skill).sort(), EXPECTED_SKILL_KEYS);
    assert.ok(['design', 'simulation', 'internal_real', 'real_accepted'].includes(skill.evidenceLevel));
    assert.ok(skill.knownGaps.length > 0, `${skill.id}必须保留未完成门槛`);
    assert.ok(skill.nextGate.trim().length > 0);
    for (const relative of [
      skill.skillPath,
      skill.workflowPath,
      ...skill.runtimePaths,
      ...skill.testPaths,
    ]) {
      await assertSafeExistingRelativePath(relative);
    }
  }

  assert.equal(profile.skills[0].evidenceLevel, 'internal_real');
  assert.equal(profile.skills[1].evidenceLevel, 'internal_real');
  assert.equal(
    profile.skills[2].evidenceLevel,
    'simulation',
    '商业模式没有项目运行时与真实使用者验收，不得外推为内部真实运行深度',
  );

  await assertCapability(profile.fast, ['boundedDispatch', 'reusesSharedRuntime']);
  await assertCapability(profile.accurate, ['separatesEvidence', 'locksExactDependencies', 'hasQualityGate']);
  await assertCapability(profile.stable, ['persistsState', 'idempotentResume', 'boundedRetry']);
  for (const value of [
    profile.fast.boundedDispatch,
    profile.fast.reusesSharedRuntime,
    profile.accurate.separatesEvidence,
    profile.accurate.locksExactDependencies,
    profile.accurate.hasQualityGate,
    profile.stable.persistsState,
    profile.stable.idempotentResume,
    profile.stable.boundedRetry,
  ]) assert.equal(value, true, '统一快准稳门禁要求所有能力均有测试证据');
  assert.ok(profile.knownGaps.length > 0);
  assert.ok(profile.nextOrganizationGate.trim().length > 0);
});

test('三个Skill和Workflow均具备统一必需章节', async () => {
  const profile = JSON.parse(await readFile(qualityPath, 'utf8'));
  for (const skill of profile.skills) {
    const skillText = await readFile(path.join(projectRoot, skill.skillPath), 'utf8');
    const workflowText = await readFile(path.join(projectRoot, skill.workflowPath), 'utf8');
    assertSections(skillText, REQUIRED_SKILL_SECTIONS, skill.skillPath);
    assertSections(workflowText, REQUIRED_WORKFLOW_SECTIONS, skill.workflowPath);
  }
});

test('组织说明准确反映商业模式已补齐项目运行但证据仍为 simulation', async () => {
  const charter = await readFile(path.join(organizationRoot, 'ORGANIZATION.md'), 'utf8');
  const overview = await readFile(
    path.join(organizationRoot, 'ORGANIZATION_OVERVIEW.md'),
    'utf8',
  );
  const skillsReadme = await readFile(
    path.join(organizationRoot, 'skills', 'README.md'),
    'utf8',
  );
  for (const content of [charter, overview, skillsReadme]) {
    assert.match(content, /商业模式[\s\S]*(?:专属规划|项目运行)/u);
    assert.match(content, /商业模式[\s\S]*simulation/u);
  }
  assert.doesNotMatch(charter, /商业模式[\s\S]*尚未建立同等级专属规划器/u);
  assert.match(charter, /acceptsFormalTasks=false/u);
});

async function assertCapability(value, booleanKeys) {
  assert.deepEqual(Object.keys(value).sort(), [...booleanKeys, 'evidencePaths'].sort());
  for (const key of booleanKeys) assert.equal(typeof value[key], 'boolean');
  assert.ok(Array.isArray(value.evidencePaths) && value.evidencePaths.length > 0);
  for (const relative of value.evidencePaths) await assertSafeExistingRelativePath(relative);
}

async function assertSafeExistingRelativePath(relative) {
  assert.equal(typeof relative, 'string');
  assert.ok(relative.length > 0);
  assert.equal(
    relative.startsWith(organizationPrefix),
    true,
    `${relative}必须是以${organizationPrefix}开头的项目根相对路径`,
  );
  assert.equal(relative.includes('\\'), false, `${relative}必须使用正斜杠`);
  assert.equal(path.isAbsolute(relative), false, `${relative}不得是绝对路径`);
  assert.equal(relative.split('/').includes('..'), false, `${relative}不得路径逃逸`);
  const absolute = path.resolve(projectRoot, relative);
  assert.equal(absolute.startsWith(`${organizationRoot}${path.sep}`), true);
  await readFile(absolute).catch(() => assert.fail(`证据路径不存在：${relative}`));
}

function assertSections(text, expected, label) {
  for (const heading of expected) {
    assert.match(text, new RegExp(`^## ${heading}$`, 'mu'), `${label}缺少章节：${heading}`);
  }
}
