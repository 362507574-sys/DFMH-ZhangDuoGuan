import { deepFreeze } from './strict_json.mjs';

const KNOWLEDGE_STATUSES = new Set(['matched', 'no_hit', 'degraded']);
const PROHIBITED = /(?:保证增长|保证成交|保证收益|100%成交|必然翻倍|稳赚|无风险赚钱)/iu;
const VAGUE = /^(?:聚焦增长|扩大规模|提升能力|优化经营|全面发展|降本增效)$/u;

export function validateStrategyPlanningCandidate({
  candidate,
  task,
  enterpriseProfile,
  knowledgeContext,
} = {}) {
  const failures = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return result([failure('candidate_missing', '战略规划候选必须是对象', 'candidate')]);
  }
  if (candidate.schemaVersion !== 1
    || candidate.capabilityId !== 'strategy-planning'
    || candidate.status !== 'candidate'
    || !Number.isInteger(candidate.version)
    || candidate.version < 1) {
    failures.push(failure('candidate_identity_invalid', '战略规划候选身份或版本无效', 'candidate'));
  }
  if (!task || task.capabilityId !== 'strategy-planning' || candidate.taskId !== task.taskId) {
    failures.push(failure('task_mismatch', '战略规划候选与任务不匹配', 'taskId'));
  }
  if (!enterpriseProfile
    || candidate.enterpriseId !== task?.enterpriseId
    || candidate.enterpriseId !== enterpriseProfile?.enterpriseId) {
    failures.push(failure('enterprise_mismatch', '候选、任务与企业不匹配', 'enterpriseId'));
  }
  if (!knowledgeContext
    || knowledgeContext.requestId !== task?.requestId
    || knowledgeContext.capabilityId !== 'ai-helmsman.strategy-planning'
    || !KNOWLEDGE_STATUSES.has(knowledgeContext.status)
    || knowledgeContext.status !== task?.knowledgeStatus) {
    failures.push(failure('knowledge_preflight_missing', '战略规划缺少匹配的知识前置凭证', 'knowledgeContext'));
  }
  if (knowledgeContext?.status === 'degraded' && !knowledgeContext.degradedReason?.trim()) {
    failures.push(failure('knowledge_degraded_reason_missing', '知识降级必须保留原因', 'knowledgeContext.degradedReason'));
  }

  const upstream = candidate.upstreamAnalysis;
  if (!upstream
    || upstream.capabilityId !== 'enterprise-analysis'
    || upstream.enterpriseId !== candidate.enterpriseId
    || !Number.isInteger(upstream.version)
    || upstream.version < 1
    || !/^[a-f0-9]{64}$/u.test(upstream.sha256 ?? '')
    || !['candidate', 'formal'].includes(upstream.status)
    || !Array.isArray(upstream.coreProblemRefs)
    || upstream.coreProblemRefs.length === 0) {
    failures.push(failure('upstream_analysis_invalid', '战略规划必须绑定同企业的企业分析版本、哈希和核心问题', 'upstreamAnalysis'));
  }

  const evidenceIds = validateEvidence(candidate.evidenceLedger, failures);
  if (!candidate.strategicQuestion?.trim() || VAGUE.test(candidate.strategicQuestion.trim())) {
    failures.push(failure('strategic_question_missing', '必须明确本次战略选择题', 'strategicQuestion'));
  }

  if (!Array.isArray(candidate.strategicOptions) || candidate.strategicOptions.length < 2) {
    failures.push(failure('strategic_options_insufficient', '至少需要两个可比较战略方案', 'strategicOptions'));
  }
  const optionIds = new Set();
  for (const [index, option] of (candidate.strategicOptions ?? []).entries()) {
    const itemPath = `strategicOptions[${index}]`;
    if (!option?.id?.trim() || optionIds.has(option.id)) {
      failures.push(failure('strategic_option_id_invalid', '战略方案ID缺失或重复', `${itemPath}.id`));
    } else optionIds.add(option.id);
    for (const field of ['title', 'thesis']) {
      if (!option?.[field]?.trim() || VAGUE.test(option[field].trim())) {
        failures.push(failure('strategic_option_incomplete', `战略方案缺少具体${field}`, `${itemPath}.${field}`));
      }
    }
    requireTextArray(option?.tradeOffs, 'strategic_option_incomplete', `${itemPath}.tradeOffs`, failures);
    requireTextArray(option?.resourceRequirements, 'strategic_option_incomplete', `${itemPath}.resourceRequirements`, failures);
    requireTextArray(option?.risks, 'strategic_option_incomplete', `${itemPath}.risks`, failures);
    validateEvidenceRefs(option?.evidenceRefs, evidenceIds, `${itemPath}.evidenceRefs`, failures);
  }

  const priorityOrder = candidate.priorityOrder;
  if (!Array.isArray(priorityOrder)
    || priorityOrder.length !== optionIds.size
    || new Set(priorityOrder).size !== priorityOrder.length
    || priorityOrder.some((id) => !optionIds.has(id))) {
    failures.push(failure('priority_order_invalid', '战略方案优先级必须完整且不重复', 'priorityOrder'));
  }

  if (!candidate.recommendation?.optionId
    || !optionIds.has(candidate.recommendation.optionId)
    || !candidate.recommendation.rationale?.trim()
    || !Array.isArray(candidate.recommendation.opportunityCosts)
    || candidate.recommendation.opportunityCosts.length === 0) {
    failures.push(failure('recommendation_invalid', '推荐方向必须引用现有方案并说明理由与机会成本', 'recommendation'));
  }
  validateEvidenceRefs(candidate.recommendation?.evidenceRefs, evidenceIds, 'recommendation.evidenceRefs', failures);

  const direction = candidate.enterpriseDirection;
  if (!direction
    || ['statement', 'targetCustomer', 'valueFocus', 'boundary'].some(
      (field) => typeof direction[field] !== 'string' || !direction[field].trim(),
    )) {
    failures.push(failure(
      'enterprise_direction_incomplete',
      '企业方向必须包含方向陈述、目标客户、价值焦点和边界',
      'enterpriseDirection',
    ));
  }
  validateEvidenceRefs(direction?.evidenceRefs, evidenceIds, 'enterpriseDirection.evidenceRefs', failures);
  requireObjectArray(candidate.developmentPath, 'development_path_missing', 'developmentPath', failures);
  requireObjectArray(candidate.resourceAllocation, 'resource_allocation_missing', 'resourceAllocation', failures);

  if (!candidate.choices
    || ['focus', 'tradeOffs', 'notDoing'].some(
      (field) => !Array.isArray(candidate.choices[field]) || candidate.choices[field].length === 0,
    )) {
    failures.push(failure('choices_incomplete', '战略必须包含聚焦、取舍和不做清单', 'choices'));
  }
  requireObjectArray(candidate.phaseGoals, 'phase_goals_missing', 'phaseGoals', failures);
  requireTextArray(candidate.resourcePrinciples, 'resource_principles_missing', 'resourcePrinciples', failures);
  requireObjectArray(candidate.assumptions, 'assumptions_missing', 'assumptions', failures);
  requireObjectArray(candidate.risks, 'risks_missing', 'risks', failures);
  requireObjectArray(candidate.metrics, 'metrics_missing', 'metrics', failures);
  requireObjectArray(candidate.milestones, 'milestones_missing', 'milestones', failures);
  requireObjectArray(candidate.ninetyDayPlan, 'ninety_day_plan_missing', 'ninetyDayPlan', failures);
  for (const [index, action] of (candidate.ninetyDayPlan ?? []).entries()) {
    if (!Array.isArray(action?.actions)
      || action.actions.length === 0
      || !action?.owner?.trim()
      || !Array.isArray(action?.metricRefs)
      || action.metricRefs.length === 0
      || !Array.isArray(action?.phaseGoalRefs)
      || action.phaseGoalRefs.length === 0
      || !Array.isArray(action?.evidenceRequired)
      || action.evidenceRequired.length === 0
      || !Array.isArray(action?.stopConditions)
      || action.stopConditions.length === 0) {
      failures.push(failure('ninety_day_plan_incomplete', '90天行动必须包含动作、负责人、指标、阶段目标、证据和停止条件', `ninetyDayPlan[${index}]`));
    }
  }
  if (!candidate.downstreamBrief?.businessModel
    || !Array.isArray(candidate.downstreamBrief.businessModel.inputs)
    || candidate.downstreamBrief.businessModel.inputs.length === 0
    || !Array.isArray(candidate.downstreamBrief.executionOrganizations)
    || candidate.downstreamBrief.executionOrganizations.length === 0) {
    failures.push(failure('downstream_brief_missing', '缺少商业模式和执行组织下游简报', 'downstreamBrief'));
  }
  requireObjectArray(candidate.decisionsRequired, 'decisions_required_missing', 'decisionsRequired', failures);
  for (const [index, item] of (candidate.decisionsRequired ?? []).entries()) {
    if (!item?.decision?.trim() || !item?.owner?.trim() || item.executed !== false) {
      failures.push(failure('automatic_strategic_action', '重大经营决策必须由授权人决定且不得标记为已执行', `decisionsRequired[${index}]`));
    }
  }
  scanProhibited(candidate, failures);
  return result(failures);
}

function validateEvidence(value, failures) {
  const ids = new Set();
  if (!Array.isArray(value) || value.length < 2) {
    failures.push(failure('evidence_ledger_missing', '战略规划至少需要两条证据或未知项', 'evidenceLedger'));
    return ids;
  }
  value.forEach((item, index) => {
    if (!item?.id?.trim() || ids.has(item.id) || !['fact', 'inference', 'assumption', 'unknown'].includes(item?.factClass)
      || !item?.statement?.trim() || !item?.sourceRef?.trim()) {
      failures.push(failure('evidence_invalid', '战略证据必须包含唯一ID、分类、陈述和来源', `evidenceLedger[${index}]`));
    } else ids.add(item.id);
  });
  return ids;
}

function validateEvidenceRefs(value, ids, pathValue, failures) {
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => !ids.has(id))) {
    failures.push(failure('evidence_reference_invalid', '战略判断必须引用已登记证据', pathValue));
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
      failures.push(failure('prohibited_guarantee', '战略规划不得包含保证性经营结论', pathValue));
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
