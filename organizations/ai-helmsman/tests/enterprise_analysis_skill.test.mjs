import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadOrganizationConfig } from '../scripts/organization_config.mjs';
import { organizationRoot, projectRoot } from './helpers.mjs';

const skillPath = path.join(organizationRoot, 'skills', 'enterprise-analysis', 'SKILL.md');
const agentPath = path.join(organizationRoot, 'skills', 'enterprise-analysis', 'agents', 'openai.yaml');

test('企业分析Skill具备完整可执行契约并与试运行状态一致', async () => {
  const [skill, agent, config] = await Promise.all([
    readFile(skillPath, 'utf8'),
    readFile(agentPath, 'utf8'),
    loadOrganizationConfig({ projectRoot }),
  ]);

  assert.match(skill, /^---\r?\nname: enterprise-analysis\r?\ndescription: Use when /u);
  for (const section of [
    '## 适用场景',
    '## 输入',
    '## 固定步骤',
    '## 输出',
    '## 依赖',
    '## 质量检查',
    '## 异常处理',
    '## 重试条件',
    '## 停止条件',
    '## 示例',
    '## 版本记录',
  ]) assert.ok(skill.includes(section), `missing section: ${section}`);

  for (const required of [
    'workflows/ENTERPRISE_ANALYSIS_PILOT.md',
    'business-projects/<enterpriseId>/<businessProjectId>/',
    '原项目',
    '原任务',
    '执行计划',
    '调试报告',
    '暂停',
    '恢复',
    '精确版本',
    'SHA-256',
    '发布请求',
    '控制中心',
    '不得直接写入 `shared-artifacts/`',
    '不区分“单次模式”和“长期模式”',
    '飞书知识前置',
    '事实',
    '推断',
    '假设',
    '未知项',
    '证据账本',
    '问题树',
    '战略规划',
    '商业模式',
    '使用者最终决定',
    '不覆盖',
    '同一根因',
    '三轮',
  ]) assert.ok(skill.includes(required), `missing required contract: ${required}`);

  assert.match(agent, /display_name:\s*"AI掌舵官·企业分析"/u);
  const statuses = new Map(config.coreSkills.map((item) => [item.id, item.status]));
  assert.equal(statuses.get('enterprise-analysis'), 'pilot');
});
