import { validateBusinessModelCandidate } from './business_model_contract.mjs';
import { deepFreeze } from './strict_json.mjs';

const VALUE_CHAIN_STAGES = Object.freeze([
  'acquisition',
  'conversion',
  'delivery',
  'value-realization',
  'retention',
  'repurchase',
]);

export function debugBusinessModelCandidate({
  candidate,
  task,
  enterpriseProfile,
  knowledgeContext,
  pinnedUpstreams,
  attempt = 1,
  maxAttempts = 3,
} = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error('maxAttempts must be between 1 and 3');
  }
  const failures = [
    ...validateBusinessModelCandidate({
      candidate,
      task,
      enterpriseProfile,
      knowledgeContext,
    }).failures,
  ];
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    checkPinnedUpstreams(candidate, pinnedUpstreams, failures);
    checkProductStructure(candidate, failures);
    checkProfitModel(candidate, failures);
    checkCustomerValueChain(candidate, failures);
    checkGrowthModel(candidate, failures);
    checkExperimentCoverage(candidate, failures);
  }
  const unique = deduplicateAndSort(failures);
  return deepFreeze({
    ok: unique.length === 0,
    attempt,
    maxAttempts,
    decision: unique.length === 0 ? 'pass' : attempt >= maxAttempts ? 'stop' : 'revise',
    failures: unique,
  });
}

function checkPinnedUpstreams(candidate, pinned, failures) {
  if (!Array.isArray(pinned)) return;
  const expected = new Map(pinned.map((item) => [item.artifactId, item]));
  for (const [field, artifactId] of [
    ['upstreamAnalysis', 'enterprise-analysis'],
    ['upstreamStrategy', 'strategy-planning'],
  ]) {
    const upstream = candidate[field];
    const binding = expected.get(artifactId);
    if (!binding
      || upstream?.version !== binding.version
      || upstream?.sha256 !== binding.sha256) {
      failures.push(failure(
        'pinned_upstream_mismatch',
        '商业模式候选与运行时固定双上游版本或哈希不一致',
        field,
      ));
    }
  }
}

function checkProductStructure(candidate, failures) {
  const products = candidate.productStructure;
  if (!Array.isArray(products) || products.length === 0) return;
  const ids = new Set(products.map((item) => item?.id).filter(Boolean));
  const graph = new Map();
  for (const [index, item] of products.entries()) {
    const itemPath = `productStructure[${index}]`;
    if (!item?.id?.trim()
      || !Number.isInteger(item.level)
      || item.level < 1
      || !item.name?.trim()
      || !item.customerSegment?.trim()
      || !Array.isArray(item.deliverables)
      || item.deliverables.length === 0
      || !Array.isArray(item.entryCriteria)
      || item.entryCriteria.length === 0
      || !item.scopeBoundary?.trim()) {
      failures.push(failure(
        'product_structure_incomplete',
        '产品结构必须包含层级、客户、交付物、进入条件和边界',
        itemPath,
      ));
    }
    const dependencies = Array.isArray(item?.dependsOn) ? item.dependsOn : [];
    const upgrades = Array.isArray(item?.upgradeTo) ? item.upgradeTo : [];
    if ([...dependencies, ...upgrades].some((id) => !ids.has(id) || id === item.id)) {
      failures.push(failure(
        'product_structure_reference_missing',
        '产品结构引用了不存在或自身的依赖/升级产品',
        itemPath,
      ));
    }
    graph.set(item?.id, dependencies);
  }
  if (hasCycle(graph)) {
    failures.push(failure(
      'product_structure_cycle',
      '产品结构存在循环依赖',
      'productStructure',
    ));
  }
}

function checkProfitModel(candidate, failures) {
  const profit = candidate.profitModel;
  if (!profit || typeof profit !== 'object' || Array.isArray(profit)) return;
  const revenueIds = new Set((candidate.revenueModel ?? []).map((item) => item?.id).filter(Boolean));
  const costIds = new Set((candidate.costModel ?? []).map((item) => item?.id).filter(Boolean));
  const variableIds = new Set(
    (candidate.unitEconomics?.variables ?? []).map((item) => item?.id).filter(Boolean),
  );
  for (const [field, ids] of [
    ['revenueStreamRefs', revenueIds],
    ['costCategoryRefs', costIds],
    ['unitEconomicsVariableRefs', variableIds],
  ]) {
    const refs = profit[field];
    if (!Array.isArray(refs) || refs.length === 0 || refs.some((id) => !ids.has(id))) {
      failures.push(failure(
        'financial_variable_reference_missing',
        '盈利模式引用了不存在的收入、成本或单位经济变量',
        `profitModel.${field}`,
      ));
    }
  }
  if (!profit.profitFormula?.trim() || !profit.cashCollectionConstraint?.trim()) {
    failures.push(failure(
      'profit_model_incomplete',
      '盈利模式必须包含利润公式和回款约束',
      'profitModel',
    ));
  }
}

function checkCustomerValueChain(candidate, failures) {
  const chain = candidate.customerValueChain;
  if (!Array.isArray(chain)) return;
  const stages = new Map(chain.map((item) => [item?.stage, item]));
  if (!VALUE_CHAIN_STAGES.every((stage) => stages.has(stage))) {
    failures.push(failure(
      'customer_value_chain_incomplete',
      '客户价值链必须完整覆盖获客、成交、交付、价值实现、留存和复购',
      'customerValueChain',
    ));
  }
  const ids = new Set(chain.map((item) => item?.id).filter(Boolean));
  const uniqueStages = new Set(chain.map((item) => item?.stage).filter(Boolean));
  if (ids.size !== chain.length || uniqueStages.size !== chain.length) {
    failures.push(failure(
      'customer_value_chain_order_invalid',
      '客户价值链的阶段ID和阶段名称必须唯一',
      'customerValueChain',
    ));
  }
  for (const [index, stage] of VALUE_CHAIN_STAGES.entries()) {
    const current = stages.get(stage);
    const nextStage = VALUE_CHAIN_STAGES[index + 1];
    const expectedNextId = nextStage ? stages.get(nextStage)?.id : '';
    if (!current || expectedNextId === undefined) continue;
    if (current.nextStageId !== expectedNextId) {
      failures.push(failure(
        current.nextStageId
          ? 'customer_value_chain_order_invalid'
          : 'customer_value_chain_disconnected',
        current.nextStageId
          ? '客户价值链必须按获客、成交、交付、价值实现、留存、复购的标准顺序连续连接'
          : '客户价值链前五个阶段必须连接到下一标准阶段，复购阶段必须是唯一终点',
        `customerValueChain.${stage}.nextStageId`,
      ));
    }
  }
  for (const [index, item] of chain.entries()) {
    if (!item?.id?.trim()
      || !VALUE_CHAIN_STAGES.includes(item.stage)
      || !item.owner?.trim()
      || !item.metric?.trim()
      || !Array.isArray(item.evidenceRequired)
      || item.evidenceRequired.length === 0
      || !Array.isArray(item.exitCriteria)
      || item.exitCriteria.length === 0
      || (item.nextStageId && !ids.has(item.nextStageId))) {
      failures.push(failure(
        'customer_value_chain_stage_incomplete',
        '客户价值链阶段必须包含负责人、指标、证据、退出条件和有效下一阶段',
        `customerValueChain[${index}]`,
      ));
    }
  }
}

function checkGrowthModel(candidate, failures) {
  const growth = candidate.growthModel;
  if (!growth || typeof growth !== 'object' || Array.isArray(growth)) return;
  const experimentIds = new Set((candidate.experiments ?? []).map((item) => item?.id).filter(Boolean));
  if (!growth.formula?.trim()
    || !Array.isArray(growth.levers)
    || growth.levers.length === 0
    || !Array.isArray(growth.constraints)
    || growth.constraints.length === 0
    || !Array.isArray(growth.stopConditions)
    || growth.stopConditions.length === 0) {
    failures.push(failure(
      'growth_model_incomplete',
      '增长模型必须包含公式、杠杆、约束和停止条件',
      'growthModel',
    ));
  }
  for (const [index, lever] of (growth.levers ?? []).entries()) {
    if (!lever?.id?.trim()
      || !lever.name?.trim()
      || !lever.metric?.trim()
      || !Array.isArray(lever.preconditions)
      || lever.preconditions.length === 0
      || !lever.capacityConstraint?.trim()
      || !lever.experimentRef?.trim()
      || !experimentIds.has(lever.experimentRef)) {
      failures.push(failure(
        'growth_lever_unvalidated',
        '增长杠杆必须绑定指标、前置条件、容量约束和现有实验',
        `growthModel.levers[${index}]`,
      ));
    }
  }
}

function checkExperimentCoverage(candidate, failures) {
  const experiments = candidate.experiments ?? [];
  const covered = new Set(experiments.flatMap((item) => item?.assumptionRefs ?? []));
  for (const [index, assumption] of (candidate.businessAssumptions ?? []).entries()) {
    if (!assumption?.id?.trim()
      || !assumption.statement?.trim()
      || !assumption.trigger?.trim()) {
      failures.push(failure(
        'business_assumption_incomplete',
        '关键商业假设必须包含ID、陈述和触发条件',
        `businessAssumptions[${index}]`,
      ));
    } else if (!covered.has(assumption.id)) {
      failures.push(failure(
        'business_assumption_without_experiment',
        '关键商业假设没有对应验证实验',
        `businessAssumptions[${index}]`,
      ));
    }
  }
}

function hasCycle(graph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (!id) return false;
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function failure(code, message, path) {
  return { code, message, path };
}

function deduplicateAndSort(failures) {
  const seen = new Set();
  return failures.filter((item) => {
    const key = `${item.code}|${item.path}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (
    left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
  ));
}
