import { deepFreeze } from './strict_json.mjs';

const KNOWLEDGE_STATUSES = new Set(['matched', 'no_hit', 'degraded']);
const PROHIBITED = /(?:保证.{0,12}(?:增长|成交|收益|盈利|收入|翻倍)|100%成交|必然翻倍|稳赚|无风险赚钱)/iu;

export function validateBusinessModelCandidate({
  candidate,
  task,
  enterpriseProfile,
  knowledgeContext,
} = {}) {
  const failures = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return result([failure('candidate_missing', '商业模式候选必须是对象', 'candidate')]);
  }
  if (candidate.schemaVersion !== 1
    || candidate.capabilityId !== 'business-model'
    || candidate.status !== 'candidate'
    || !Number.isInteger(candidate.version)
    || candidate.version < 1) {
    failures.push(failure('candidate_identity_invalid', '商业模式候选身份或版本无效', 'candidate'));
  }
  if (!task || task.capabilityId !== 'business-model' || candidate.taskId !== task.taskId) {
    failures.push(failure('task_mismatch', '商业模式候选与任务不匹配', 'taskId'));
  }
  if (!enterpriseProfile
    || candidate.enterpriseId !== task?.enterpriseId
    || candidate.enterpriseId !== enterpriseProfile?.enterpriseId) {
    failures.push(failure('enterprise_mismatch', '候选、任务与企业不匹配', 'enterpriseId'));
  }
  if (!knowledgeContext
    || knowledgeContext.requestId !== task?.requestId
    || knowledgeContext.capabilityId !== 'ai-helmsman.business-model'
    || !KNOWLEDGE_STATUSES.has(knowledgeContext.status)
    || knowledgeContext.status !== task?.knowledgeStatus) {
    failures.push(failure('knowledge_preflight_missing', '商业模式缺少匹配的知识前置凭证', 'knowledgeContext'));
  }
  if (knowledgeContext?.status === 'degraded' && !knowledgeContext.degradedReason?.trim()) {
    failures.push(failure('knowledge_degraded_reason_missing', '知识降级必须保留原因', 'knowledgeContext.degradedReason'));
  }

  validateUpstream(candidate.upstreamAnalysis, 'enterprise-analysis', candidate.enterpriseId, 'upstreamAnalysis', failures);
  validateUpstream(candidate.upstreamStrategy, 'strategy-planning', candidate.enterpriseId, 'upstreamStrategy', failures);
  const evidenceIds = validateEvidence(candidate.evidenceLedger, failures);

  const customer = candidate.customerArchitecture;
  if (!customer
    || !Array.isArray(customer.segments)
    || customer.segments.length === 0
    || ['payer', 'user', 'decisionMaker', 'beneficiary'].some((field) => !customer[field]?.trim())) {
    failures.push(failure('customer_architecture_incomplete', '必须明确客户分层、付费者、使用者、决策者和受益者', 'customerArchitecture'));
  }

  requireObjectArray(candidate.valuePropositions, 'value_propositions_missing', 'valuePropositions', failures);
  for (const [index, item] of (candidate.valuePropositions ?? []).entries()) {
    if (!item?.segment?.trim() || !item?.problem?.trim() || !item?.promise?.trim()) {
      failures.push(failure('value_proposition_incomplete', '价值主张必须包含客户、问题和承诺', `valuePropositions[${index}]`));
    }
    validateEvidenceRefs(item?.evidenceRefs, evidenceIds, `valuePropositions[${index}].evidenceRefs`, failures);
  }

  requireObjectArray(candidate.offerArchitecture, 'offer_architecture_missing', 'offerArchitecture', failures);
  for (const [index, item] of (candidate.offerArchitecture ?? []).entries()) {
    if (!item?.offer?.trim()
      || !Array.isArray(item.deliverables)
      || item.deliverables.length === 0
      || !item?.deliveryMode?.trim()
      || !item?.scopeBoundary?.trim()) {
      failures.push(failure('offer_architecture_incomplete', '产品服务必须包含交付物、方式和边界', `offerArchitecture[${index}]`));
    }
  }

  requireObjectArray(candidate.productStructure, 'product_structure_missing', 'productStructure', failures);
  const profit = candidate.profitModel;
  if (!profit
    || !Array.isArray(profit.revenueStreamRefs)
    || profit.revenueStreamRefs.length === 0
    || !Array.isArray(profit.costCategoryRefs)
    || profit.costCategoryRefs.length === 0
    || !Array.isArray(profit.unitEconomicsVariableRefs)
    || profit.unitEconomicsVariableRefs.length === 0
    || !profit.profitFormula?.trim()
    || !profit.cashCollectionConstraint?.trim()) {
    failures.push(failure(
      'profit_model_incomplete',
      'profitModel must connect revenue, cost, unit economics, profit formula and collection constraints',
      'profitModel',
    ));
  }

  validateFinancialModel(candidate.revenueModel, 'revenueModel', failures);
  validateFinancialModel(candidate.costModel, 'costModel', failures);
  const unit = candidate.unitEconomics;
  if (!unit?.formula?.trim()
    || !Array.isArray(unit.variables)
    || unit.variables.length === 0
    || !unit?.breakEvenCondition?.trim()) {
    failures.push(failure('unit_economics_incomplete', '单位经济必须包含公式、变量和盈亏平衡条件', 'unitEconomics'));
  }
  for (const [index, variable] of (unit?.variables ?? []).entries()) {
    if (!variable?.id?.trim()
      || !variable?.name?.trim()
      || !['confirmed', 'hypothesis', 'unknown'].includes(variable?.status)) {
      failures.push(failure('unit_economic_variable_invalid', '单位经济变量缺少名称或状态', `unitEconomics.variables[${index}]`));
    }
    validateNumericEvidence(variable, `unitEconomics.variables[${index}]`, failures);
  }

  const journey = candidate.customerJourney;
  if (!journey || ['acquisition', 'conversion', 'delivery', 'retention', 'repurchase'].some(
    (field) => !Array.isArray(journey[field]) || journey[field].length === 0,
  )) {
    failures.push(failure('customer_journey_incomplete', '必须建立获客、成交、交付、留存和复购链路', 'customerJourney'));
  }
  requireObjectArray(
    candidate.customerValueChain,
    'customer_value_chain_missing',
    'customerValueChain',
    failures,
  );
  requireTextArray(candidate.keyResources, 'key_resources_missing', 'keyResources', failures);
  requireTextArray(candidate.partners, 'partners_missing', 'partners', failures);
  requireObjectArray(
    candidate.businessAssumptions,
    'business_assumptions_missing',
    'businessAssumptions',
    failures,
  );
  requireObjectArray(candidate.experiments, 'experiments_missing', 'experiments', failures);
  for (const [index, experiment] of (candidate.experiments ?? []).entries()) {
    if (!experiment?.id?.trim()
      || !Array.isArray(experiment?.assumptionRefs)
      || experiment.assumptionRefs.length === 0
      || !experiment?.hypothesis?.trim()
      || !experiment?.method?.trim()
      || !experiment?.metric?.trim()
      || !Number.isInteger(experiment?.maximumDays)
      || experiment.maximumDays < 1
      || !experiment?.maximumCost?.trim()
      || !Array.isArray(experiment?.stopConditions)
      || experiment.stopConditions.length === 0
      || !Array.isArray(experiment?.adjustConditions)
      || experiment.adjustConditions.length === 0
      || !Array.isArray(experiment?.scaleConditions)
      || experiment.scaleConditions.length === 0) {
      failures.push(failure('experiment_incomplete', '实验必须包含假设、方法、指标、时限、成本和停止/调整/扩大条件', `experiments[${index}]`));
    }
  }
  const growth = candidate.growthModel;
  if (!growth?.formula?.trim()
    || !Array.isArray(growth.levers)
    || growth.levers.length === 0
    || !Array.isArray(growth.constraints)
    || growth.constraints.length === 0
    || !Array.isArray(growth.stopConditions)
    || growth.stopConditions.length === 0) {
    failures.push(failure(
      'growth_model_incomplete',
      'growthModel must contain a formula, validated levers, capacity constraints and stop conditions',
      'growthModel',
    ));
  }
  requireTextArray(candidate.risks, 'risks_missing', 'risks', failures);
  requireTextArray(candidate.unknowns, 'unknowns_missing', 'unknowns', failures);
  requireObjectArray(candidate.decisionsRequired, 'decisions_required_missing', 'decisionsRequired', failures);
  for (const [index, item] of (candidate.decisionsRequired ?? []).entries()) {
    if (!item?.decision?.trim() || !item?.owner?.trim() || item.executed !== false) {
      failures.push(failure('automatic_business_action', '定价、投资和其他重大商业动作必须由授权人决定且不得标记为已执行', `decisionsRequired[${index}]`));
    }
  }
  scanProhibited(candidate, failures);
  return result(failures);
}

function validateUpstream(value, capabilityId, enterpriseId, pathValue, failures) {
  if (!value
    || value.capabilityId !== capabilityId
    || value.enterpriseId !== enterpriseId
    || !Number.isInteger(value.version)
    || value.version < 1
    || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '')) {
    failures.push(failure('upstream_invalid', `缺少匹配的${capabilityId}上游版本和哈希`, pathValue));
  }
}

function validateEvidence(value, failures) {
  const ids = new Set();
  if (!Array.isArray(value) || value.length < 2) {
    failures.push(failure('evidence_ledger_missing', '商业模式至少需要两条证据或未知项', 'evidenceLedger'));
    return ids;
  }
  value.forEach((item, index) => {
    if (!item?.id?.trim() || ids.has(item.id)
      || !['fact', 'inference', 'assumption', 'unknown'].includes(item?.factClass)
      || !item?.statement?.trim()
      || !item?.sourceRef?.trim()) {
      failures.push(failure('evidence_invalid', '商业模式证据必须包含唯一ID、分类、陈述和来源', `evidenceLedger[${index}]`));
    } else ids.add(item.id);
  });
  return ids;
}

function validateEvidenceRefs(value, ids, pathValue, failures) {
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => !ids.has(id))) {
    failures.push(failure('evidence_reference_invalid', '商业判断必须引用已登记证据', pathValue));
  }
}

function validateFinancialModel(value, pathValue, failures) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(failure('financial_model_missing', `${pathValue}不能为空`, pathValue));
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${pathValue}[${index}]`;
    const label = pathValue === 'revenueModel' ? item?.stream : item?.category;
    const variable = pathValue === 'revenueModel' ? item?.pricingVariable : item?.costVariable;
    if (!item?.id?.trim()
      || !label?.trim()
      || !variable?.trim()
      || !item?.formula?.trim()
      || !['confirmed', 'hypothesis', 'unknown'].includes(item?.status)) {
      failures.push(failure('financial_model_incomplete', '收入成本项必须包含变量、公式和状态', itemPath));
    }
    validateNumericEvidence(item, itemPath, failures);
  });
}

function validateNumericEvidence(item, pathValue, failures) {
  if (typeof item?.value === 'number'
    && (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0)) {
    failures.push(failure('financial_number_missing_evidence', '确认或假设的财务数字必须引用证据', `${pathValue}.evidenceRefs`));
  }
}

function requireTextArray(value, code, pathValue, failures) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    failures.push(failure(code, `${pathValue}必须包含具体内容`, pathValue));
  }
}

function requireObjectArray(value, code, pathValue, failures) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    failures.push(failure(code, `${pathValue}必须包含结构化内容`, pathValue));
  }
}

function scanProhibited(value, failures) {
  const visit = (current, pathValue) => {
    if (typeof current === 'string' && PROHIBITED.test(current)) {
      failures.push(failure('prohibited_guarantee', '商业模式不得包含保证性经营结论', pathValue));
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) visit(child, `${pathValue}.${key}`);
  };
  visit(value, 'candidate');
}

function failure(code, message, pathValue) {
  return { code, message, path: pathValue };
}

function result(failures) {
  const unique = [...new Map(failures.map((item) => [`${item.code}|${item.path}`, item])).values()];
  unique.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return deepFreeze({ ok: unique.length === 0, failures: unique });
}
