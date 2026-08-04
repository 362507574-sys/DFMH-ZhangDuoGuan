import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { organizationTask, enterpriseProfile, knowledgeContext, organizationRoot } from './helpers.mjs';

const loaded = await import('../scripts/strategy_planning_contract.mjs')
  .then((module) => ({ module, error: null }))
  .catch((error) => ({ module: null, error }));

test('战略规划契约暴露候选校验入口', () => {
  assert.equal(
    typeof loaded.module?.validateStrategyPlanningCandidate,
    'function',
    loaded.error?.message ?? 'validateStrategyPlanningCandidate missing',
  );
});

test('完整战略规划候选通过并保留上游版本哈希', () => {
  if (!loaded.module) return;
  const result = validate(validStrategyCandidate());
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(Object.isFrozen(result), true);
});

test('拒绝跨企业、缺少双方案、重复优先级和保证性结论', () => {
  if (!loaded.module) return;
  const candidate = validStrategyCandidate({
    enterpriseId: 'other-enterprise',
    strategicOptions: [validStrategyCandidate().strategicOptions[0]],
    priorityOrder: ['option-focus', 'option-focus'],
    recommendation: {
      optionId: 'option-focus',
      rationale: '保证增长并在90天内翻倍',
      evidenceRefs: ['E-001'],
    },
  });
  const result = validate(candidate);
  assert.equal(result.ok, false);
  for (const code of [
    'enterprise_mismatch',
    'strategic_options_insufficient',
    'priority_order_invalid',
    'prohibited_guarantee',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
});

test('拒绝缺失取舍、不做清单、资源边界、90天行动和自动重大决策', () => {
  if (!loaded.module) return;
  const candidate = validStrategyCandidate({
    choices: { focus: [], tradeOffs: [], notDoing: [] },
    resourcePrinciples: [],
    ninetyDayPlan: [],
    decisionsRequired: [{
      decision: '立即投入全部预算',
      owner: 'ai-helmsman',
      executed: true,
    }],
  });
  const result = validate(candidate);
  assert.equal(result.ok, false);
  for (const code of [
    'choices_incomplete',
    'resource_principles_missing',
    'ninety_day_plan_missing',
    'automatic_strategic_action',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
});

test('战略规划Skill和Workflow具备完整生产契约', async () => {
  const [skill, agent, workflow] = await Promise.all([
    readFile(path.join(organizationRoot, 'skills', 'strategy-planning', 'SKILL.md'), 'utf8'),
    readFile(path.join(organizationRoot, 'skills', 'strategy-planning', 'agents', 'openai.yaml'), 'utf8'),
    readFile(path.join(organizationRoot, 'workflows', 'STRATEGY_PLANNING_PILOT.md'), 'utf8'),
  ]);
  assert.match(skill, /^---\r?\nname: strategy-planning\r?\ndescription: Use when /u);
  for (const section of [
    '## 适用场景', '## 输入', '## 固定步骤', '## 输出', '## 依赖',
    '## 质量检查', '## 异常处理', '## 重试条件', '## 停止条件',
    '## 示例', '## 版本记录',
  ]) assert.ok(skill.includes(section), `missing section: ${section}`);
  for (const phrase of [
    '企业分析', '上游', '版本', '哈希', '取舍', '不做清单',
    '资源', '90天', '指标', '里程碑', '假设', '使用者最终决定',
  ]) assert.ok(skill.includes(phrase), `missing strategy requirement: ${phrase}`);
  assert.match(agent, /display_name:\s*"AI掌舵官·战略规划"/u);
  assert.match(workflow, /至少两个|战略方案/u);
  assert.match(workflow, /不得.*已批准|候选/u);
});

function validate(candidate) {
  return loaded.module.validateStrategyPlanningCandidate({
    candidate,
    task: organizationTask({
      taskId: '20260728-002-strategy-planning',
      requestId: '20260728-002-strategy-planning',
      idempotencyKey: 'acme-demo|20260728-002-strategy-planning',
      capabilityId: 'strategy-planning',
      knowledgeStatus: 'no_hit',
    }),
    enterpriseProfile: enterpriseProfile(),
    knowledgeContext: {
      ...knowledgeContext(),
      requestId: '20260728-002-strategy-planning',
      capabilityId: 'ai-helmsman.strategy-planning',
    },
  });
}

export function validStrategyCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    capabilityId: 'strategy-planning',
    taskId: '20260728-002-strategy-planning',
    enterpriseId: 'acme-demo',
    version: 1,
    status: 'candidate',
    upstreamAnalysis: {
      capabilityId: 'enterprise-analysis',
      enterpriseId: 'acme-demo',
      taskId: '20260728-001-enterprise-analysis',
      version: 1,
      sha256: 'a'.repeat(64),
      status: 'candidate',
      coreProblemRefs: ['problem-001'],
    },
    evidenceLedger: [
      {
        id: 'E-001',
        factClass: 'fact',
        statement: '企业负责人要求先验证单一经营主线',
        sourceRef: 'enterprise-analysis-v1.json',
      },
      {
        id: 'E-002',
        factClass: 'unknown',
        statement: '真实客户、收入与交付成本未知',
        sourceRef: 'enterprise-analysis-v1.json',
      },
    ],
    strategicQuestion: '未来90天优先验证哪条经营主线',
    strategicOptions: [
      {
        id: 'option-focus',
        title: '聚焦掌舵官三技能闭环',
        thesis: '先完成可复用战略决策闭环，再扩大组织范围',
        evidenceRefs: ['E-001', 'E-002'],
        tradeOffs: ['暂不推动全部组织正式化'],
        resourceRequirements: ['掌舵官能力建设与真实任务验证'],
        risks: ['短期覆盖范围有限'],
      },
      {
        id: 'option-expand',
        title: '同步扩大五组织覆盖',
        thesis: '并行增加能力覆盖，但验证与维护压力更高',
        evidenceRefs: ['E-001', 'E-002'],
        tradeOffs: ['分散验证资源'],
        resourceRequirements: ['多个组织同时试运行'],
        risks: ['虚假成熟度和维护负担'],
      },
    ],
    priorityOrder: ['option-focus', 'option-expand'],
    recommendation: {
      optionId: 'option-focus',
      rationale: '当前证据支持先完成一个完整闭环再扩大范围',
      opportunityCosts: ['短期放弃五组织同步扩张速度'],
      evidenceRefs: ['E-001', 'E-002'],
    },
    enterpriseDirection: {
      statement: '未来90天聚焦一个可验证经营闭环',
      targetCustomer: '已经出现明确需求信号的核心客户',
      valueFocus: '可验证的客户经营结果',
      boundary: '不同时扩张全部组织和业务线',
      evidenceRefs: ['E-001', 'E-002'],
    },
    developmentPath: [
      {
        id: 'phase-validate',
        sequence: 1,
        objective: '验证经营闭环',
        dependsOn: [],
        exitCriteria: ['完成三次真实项目验证'],
        milestoneRefs: ['milestone-pilot'],
      },
    ],
    resourceAllocation: [
      {
        resourceId: 'management-attention',
        resourceType: 'attention',
        percentage: 100,
        phaseRef: 'phase-validate',
        priority: 1,
        rationale: '先保障经营闭环验证',
      },
    ],
    choices: {
      focus: ['完成企业分析、战略规划、商业模式联动'],
      tradeOffs: ['用短期覆盖范围换取可验证性'],
      notDoing: ['不同时宣布全部组织正式上线'],
    },
    phaseGoals: [
      {
        id: 'goal-pilot',
        phase: '90-days',
        objective: '完成三技能真实项目试运行',
        boundary: '不对外发布，不自动实施重大经营动作',
      },
    ],
    resourcePrinciples: ['先保障证据、测试和真实试运行'],
    assumptions: [{
      assumption: '完整闭环比同时扩张更能降低返工',
      evidenceRefs: ['E-001'],
      trigger: '若真实任务无法复用则重新评估',
    }],
    risks: [{
      risk: '缺少真实财务与客户数据',
      mitigation: '只形成变量和验证计划',
      trigger: '取得授权数据后重算',
    }],
    metrics: [{
      id: 'metric-pilot',
      metric: 'helmsman_skills_pilot_ready',
      baseline: 1,
      target: 3,
      evidenceRefs: ['E-001'],
    }],
    milestones: [{
      id: 'milestone-pilot',
      name: '三技能候选通过质量门禁',
      due: '2026-10-26',
      successCriteria: ['三个候选全部通过', '联合门禁通过'],
    }],
    ninetyDayPlan: [
      {
        days: '1-30',
        actions: ['补齐三技能契约和Workflow'],
        owner: 'ai-helmsman',
        metricRefs: ['metric-pilot'],
        phaseGoalRefs: ['goal-pilot'],
        evidenceRequired: ['自动化测试结果'],
        stopConditions: ['同一根因三轮失败'],
      },
      {
        days: '31-60',
        actions: ['完成真实项目试运行'],
        owner: 'ai-helmsman',
        metricRefs: ['metric-pilot'],
        phaseGoalRefs: ['goal-pilot'],
        evidenceRequired: ['试运行记录'],
        stopConditions: ['缺少不可替代企业事实'],
      },
      {
        days: '61-90',
        actions: ['完成复盘与验收'],
        owner: 'ai-helmsman',
        metricRefs: ['metric-pilot'],
        phaseGoalRefs: ['goal-pilot'],
        evidenceRequired: ['验收记录'],
        stopConditions: ['回归测试失败'],
      },
    ],
    downstreamBrief: {
      businessModel: {
        inputs: ['优先目标、资源边界、不做清单'],
        decisionsNeeded: ['确定首个价值验证场景'],
      },
      executionOrganizations: [{
        organizationId: 'control-center',
        scope: '保持当前回退路由并记录真实任务证据',
      }],
    },
    decisionsRequired: [{
      decision: '是否采用该战略候选作为下一阶段方向',
      owner: 'emperor',
      executed: false,
    }],
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}
