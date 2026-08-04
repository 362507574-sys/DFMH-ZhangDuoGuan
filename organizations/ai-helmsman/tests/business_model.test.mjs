import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { enterpriseProfile, knowledgeContext, organizationRoot, organizationTask } from './helpers.mjs';

const loaded = await import('../scripts/business_model_contract.mjs')
  .then((module) => ({ module, error: null }))
  .catch((error) => ({ module: null, error }));

test('商业模式契约暴露候选校验入口', () => {
  assert.equal(
    typeof loaded.module?.validateBusinessModelCandidate,
    'function',
    loaded.error?.message ?? 'validateBusinessModelCandidate missing',
  );
});

test('完整商业模式候选通过并保留企业分析与战略规划双上游', () => {
  if (!loaded.module) return;
  const result = validate(validBusinessModelCandidate());
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(Object.isFrozen(result), true);
});

test('拒绝跨企业、缺客户角色、无证据财务数字和保证性结论', () => {
  if (!loaded.module) return;
  const candidate = validBusinessModelCandidate({
    enterpriseId: 'other-enterprise',
    customerArchitecture: {
      segments: [],
      payer: '',
      user: '',
      decisionMaker: '',
      beneficiary: '',
    },
    productStructure: [{
      id: 'offer-pilot',
      level: 1,
      name: 'minimum business validation service',
      customerSegment: 'authorized enterprise owner',
      dependsOn: [],
      upgradeTo: [],
      deliverables: ['analysis', 'strategy', 'business model validation'],
      entryCriteria: ['authorized business question'],
      scopeBoundary: 'no automatic pricing, investment or external commitment',
      evidenceRefs: ['E-001', 'E-002'],
    }],
    profitModel: {
      revenueStreamRefs: ['pilot-service'],
      costCategoryRefs: ['delivery-cost'],
      unitEconomicsVariableRefs: ['validated-price', 'delivery-cost'],
      profitFormula: 'contribution = collected cash - acquisition cost - delivery cost',
      cashCollectionConstraint: 'collection timing must cover delivery cash outflow',
      evidenceRefs: ['E-002'],
    },
    revenueModel: [{
      id: 'pilot-service',
      stream: '订阅收入',
      pricingVariable: 'annual-price',
      formula: '付费客户数 × 年费',
      value: 2000000,
      status: 'confirmed',
      evidenceRefs: [],
    }],
    valuePropositions: [{
      segment: '中小企业经营者',
      problem: '战略决策分散',
      promise: '保证90天收入翻倍',
      evidenceRefs: ['E-001'],
    }],
  });
  const result = validate(candidate);
  assert.equal(result.ok, false);
  for (const code of [
    'enterprise_mismatch',
    'customer_architecture_incomplete',
    'financial_number_missing_evidence',
    'prohibited_guarantee',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
});

test('拒绝缺单位经济公式、交付复购链路、实验停止条件和自动定价', () => {
  if (!loaded.module) return;
  const candidate = validBusinessModelCandidate({
    unitEconomics: { formula: '', variables: [], breakEvenCondition: '' },
    customerJourney: {
      acquisition: [],
      conversion: [],
      delivery: [],
      retention: [],
      repurchase: [],
    },
    experiments: [{
      hypothesis: '企业愿意为掌舵官能力付费',
      method: '访谈',
      metric: '付费意愿',
      maximumDays: 30,
      maximumCost: '不新增付费工具',
      stopConditions: [],
      adjustConditions: [],
      scaleConditions: [],
    }],
    decisionsRequired: [{
      decision: '立即采用年费定价',
      owner: 'ai-helmsman',
      executed: true,
    }],
  });
  const result = validate(candidate);
  assert.equal(result.ok, false);
  for (const code of [
    'unit_economics_incomplete',
    'customer_journey_incomplete',
    'experiment_incomplete',
    'automatic_business_action',
  ]) assert.ok(result.failures.some((item) => item.code === code), code);
});

test('商业模式 Skill 和 Workflow 具备完整项目执行契约', async () => {
  const [skill, agent, workflow] = await Promise.all([
    readFile(path.join(organizationRoot, 'skills', 'business-model', 'SKILL.md'), 'utf8'),
    readFile(path.join(organizationRoot, 'skills', 'business-model', 'agents', 'openai.yaml'), 'utf8'),
    readFile(path.join(organizationRoot, 'workflows', 'BUSINESS_MODEL_PILOT.md'), 'utf8'),
  ]);
  assert.match(skill, /^---\r?\nname: business-model\r?\ndescription: Use when /u);
  for (const section of [
    '## 适用场景',
    '## 输入',
    '## 固定步骤',
    '## 输出',
    '## 质量检查',
    '## 调试能力',
    '## 暂停、恢复与版本',
    '## 异常处理',
    '## 重试条件',
    '## 停止条件',
    '## 发布边界',
    '## 示例',
    '## 版本记录',
  ]) assert.ok(skill.includes(section), `missing section: ${section}`);
  for (const phrase of [
    '企业分析',
    '战略规划',
    '产品结构',
    '盈利模式',
    '客户价值链',
    '增长模型',
    '版本',
    'SHA-256',
    '付费者',
    '单位经济',
    '实验',
    'resumeKey',
    '同一根因最多三轮',
    '控制中心',
  ]) assert.ok(skill.includes(phrase), `missing business model requirement: ${phrase}`);
  assert.match(agent, /display_name:/u);
  assert.match(workflow, /无财务证据时[\s\S]*变量[\s\S]*公式/u);
});

function validate(candidate) {
  return loaded.module.validateBusinessModelCandidate({
    candidate,
    task: organizationTask({
      taskId: '20260728-003-business-model',
      requestId: '20260728-003-business-model',
      idempotencyKey: 'acme-demo|20260728-003-business-model',
      capabilityId: 'business-model',
      knowledgeStatus: 'no_hit',
    }),
    enterpriseProfile: enterpriseProfile(),
    knowledgeContext: {
      ...knowledgeContext(),
      requestId: '20260728-003-business-model',
      capabilityId: 'ai-helmsman.business-model',
    },
  });
}

export function validBusinessModelCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    capabilityId: 'business-model',
    taskId: '20260728-003-business-model',
    enterpriseId: 'acme-demo',
    version: 1,
    status: 'candidate',
    upstreamAnalysis: {
      capabilityId: 'enterprise-analysis',
      enterpriseId: 'acme-demo',
      taskId: '20260728-001-enterprise-analysis',
      version: 1,
      sha256: 'a'.repeat(64),
    },
    upstreamStrategy: {
      capabilityId: 'strategy-planning',
      enterpriseId: 'acme-demo',
      taskId: '20260728-002-strategy-planning',
      version: 1,
      sha256: 'b'.repeat(64),
      status: 'candidate',
    },
    evidenceLedger: [
      {
        id: 'E-001',
        factClass: 'fact',
        statement: '当前已建立控制中心和五组织能力架构',
        sourceRef: 'enterprise-analysis-v1.json',
      },
      {
        id: 'E-002',
        factClass: 'unknown',
        statement: '真实付费客户、收入、成本和利润未知',
        sourceRef: 'enterprise-analysis-v1.json',
      },
    ],
    customerArchitecture: {
      segments: ['需要系统化AI经营协作的中小企业经营者'],
      payer: '企业负责人或授权预算负责人',
      user: '企业负责人及其核心团队',
      decisionMaker: '企业负责人',
      beneficiary: '企业经营团队',
    },
    valuePropositions: [{
      segment: '中小企业经营者',
      problem: '经营判断、执行组织和证据分散',
      promise: '提供可追溯的战略决策与数字员工协作闭环',
      evidenceRefs: ['E-001', 'E-002'],
    }],
    offerArchitecture: [{
      offer: 'AI掌舵官经营诊断与90天战略设计',
      deliverables: ['企业分析', '战略规划', '商业模式验证计划'],
      deliveryMode: '项目制诊断与周期复盘',
      scopeBoundary: '不替企业执行重大经营决策',
    }],
    revenueModel: [{
      stream: '项目服务费或订阅费候选',
      pricingVariable: 'validated-value-and-delivery-scope',
      formula: '付费客户数 × 经验证客单价',
      value: null,
      status: 'hypothesis',
      evidenceRefs: ['E-002'],
    }],
    costModel: [{
      id: 'delivery-cost',
      category: '交付与维护成本',
      costVariable: 'delivery-hours-and-tool-cost',
      formula: '交付工时成本 + 工具成本 + 维护成本',
      value: null,
      status: 'unknown',
      evidenceRefs: ['E-002'],
    }],
    unitEconomics: {
      formula: '单客户贡献 = 客单价 - 获客成本 - 交付成本 - 持续维护成本',
      variables: [
        { name: '客单价', value: null, status: 'unknown', evidenceRefs: ['E-002'] },
        { name: '单客户交付成本', value: null, status: 'unknown', evidenceRefs: ['E-002'] },
      ],
      breakEvenCondition: '单客户贡献为正且回款周期覆盖交付现金支出',
    },
    customerJourney: {
      acquisition: ['通过真实经营问题内容或合作渠道获得自愿咨询'],
      conversion: ['完成需求诊断和范围确认后提交候选方案'],
      delivery: ['依次完成企业分析、战略规划和商业模式验证计划'],
      retention: ['按月复盘指标、假设和行动结果'],
      repurchase: ['仅在上一阶段交付验收且出现新经营问题时提出'],
    },
    keyResources: ['企业资料授权', 'AI掌舵官三技能', '控制中心任务与证据系统'],
    partners: ['经企业授权的财务、法律或行业专业人员'],
    experiments: [{
      hypothesis: '目标企业愿意为可追溯战略决策闭环付费',
      method: '完成3次授权需求访谈和1次小范围价值验证',
      metric: '明确付费意愿与交付验收结果',
      maximumDays: 45,
      maximumCost: '不新增付费工具',
      stopConditions: ['3次访谈均不存在明确付费问题'],
      adjustConditions: ['客户认可问题但不认可交付范围'],
      scaleConditions: ['至少1个真实客户完成付费或等价价值验证'],
    }],
    risks: ['真实客户与财务数据不足'],
    unknowns: ['可接受价格、交付成本和续费率未知'],
    decisionsRequired: [{
      decision: '是否批准进行小范围客户与价值验证',
      owner: 'emperor',
      executed: false,
    }],
    unitEconomics: {
      formula: 'unit contribution = validated price - delivery cost',
      variables: [
        {
          id: 'validated-price',
          name: 'validated price',
          value: null,
          status: 'unknown',
          evidenceRefs: ['E-002'],
        },
        {
          id: 'delivery-cost',
          name: 'delivery cost',
          value: null,
          status: 'unknown',
          evidenceRefs: ['E-002'],
        },
      ],
      breakEvenCondition: 'validated price exceeds acquisition, delivery and maintenance cost',
    },
    customerValueChain: [
      'acquisition',
      'conversion',
      'delivery',
      'value-realization',
      'retention',
      'repurchase',
    ].map((stage, index, stages) => ({
      id: `stage-${stage}`,
      stage,
      owner: 'ai-helmsman',
      metric: `${stage}-evidence-complete`,
      evidenceRequired: [`${stage}-record`],
      exitCriteria: [`${stage}-accepted`],
      nextStageId: stages[index + 1] ? `stage-${stages[index + 1]}` : '',
    })),
    businessAssumptions: [{
      id: 'assumption-willingness-to-pay',
      statement: 'target customers will pay for an auditable validation loop',
      evidenceRefs: ['E-002'],
      trigger: 'real payment or equivalent value evidence is obtained',
    }],
    experiments: [{
      id: 'experiment-willingness-to-pay',
      assumptionRefs: ['assumption-willingness-to-pay'],
      hypothesis: 'target customers will pay for traceable business validation',
      method: 'three authorized interviews and one limited-scope value test',
      metric: 'payment intent and delivery acceptance evidence',
      maximumDays: 45,
      maximumCost: 'no new paid tool',
      stopConditions: ['three interviews find no paid problem'],
      adjustConditions: ['problem accepted but delivery scope rejected'],
      scaleConditions: ['one real payment or equivalent value result'],
    }],
    growthModel: {
      formula: 'qualified leads x conversion x delivery success x retention x repurchase',
      levers: [{
        id: 'lever-validated-referral',
        name: 'accepted customer referral',
        metric: 'qualified_referral_count',
        preconditions: ['first delivery accepted'],
        capacityConstraint: 'new work cannot exceed validated delivery capacity',
        experimentRef: 'experiment-willingness-to-pay',
      }],
      constraints: ['do not scale unvalidated unit economics'],
      stopConditions: ['delivery quality declines or unit economics becomes negative'],
    },
    productStructure: [{
      id: 'offer-pilot',
      level: 1,
      name: 'minimum business validation service',
      customerSegment: 'authorized enterprise owner',
      dependsOn: [],
      upgradeTo: [],
      deliverables: ['analysis', 'strategy', 'business model validation'],
      entryCriteria: ['authorized business question'],
      scopeBoundary: 'no automatic pricing, investment or external commitment',
      evidenceRefs: ['E-001', 'E-002'],
    }],
    profitModel: {
      revenueStreamRefs: ['pilot-service'],
      costCategoryRefs: ['delivery-cost'],
      unitEconomicsVariableRefs: ['validated-price', 'delivery-cost'],
      profitFormula: 'contribution = collected cash - acquisition cost - delivery cost',
      cashCollectionConstraint: 'collection timing must cover delivery cash outflow',
      evidenceRefs: ['E-002'],
    },
    revenueModel: [{
      id: 'pilot-service',
      stream: 'business validation service fee hypothesis',
      pricingVariable: 'validated-price',
      formula: 'accepted project count x validated price',
      value: null,
      status: 'hypothesis',
      evidenceRefs: ['E-002'],
    }],
    costModel: [{
      id: 'delivery-cost',
      category: 'single customer delivery cost',
      costVariable: 'delivery-cost',
      formula: 'delivery labor + tool cost + maintenance cost',
      value: null,
      status: 'unknown',
      evidenceRefs: ['E-002'],
    }],
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}
