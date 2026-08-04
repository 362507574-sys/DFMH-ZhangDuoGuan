import { deepFreeze } from './strict_json.mjs';

const KNOWLEDGE_STATUSES = new Set(['matched', 'no_hit', 'degraded']);
const VAGUE = /^(?:优势明显|能力较强|发展良好|问题很多|机会很大|风险较高|待提升)$/u;

export function validateEnterpriseAnalysisCandidate({
  candidate,
  task,
  enterpriseProfile,
  knowledgeContext,
} = {}) {
  const failures = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return result([failure('candidate_missing', '企业分析候选必须是对象', 'candidate')]);
  }
  if (candidate.schemaVersion !== 1 || !Number.isInteger(candidate.version) || candidate.version < 1) {
    failures.push(failure('candidate_version_invalid', '候选版本无效', 'version'));
  }
  if (!task || candidate.taskId !== task.taskId) {
    failures.push(failure('task_mismatch', '候选与任务不匹配', 'taskId'));
  }
  if (!enterpriseProfile
    || candidate.enterpriseId !== task?.enterpriseId
    || candidate.enterpriseId !== enterpriseProfile?.enterpriseId) {
    failures.push(failure('enterprise_mismatch', '候选、任务与企业不匹配', 'enterpriseId'));
  }
  if (!knowledgeContext
    || knowledgeContext.requestId !== task?.requestId
    || knowledgeContext.capabilityId !== 'ai-helmsman.enterprise-analysis'
    || !KNOWLEDGE_STATUSES.has(knowledgeContext.status)
    || task?.knowledgeStatus !== knowledgeContext.status) {
    failures.push(failure('knowledge_preflight_missing', '企业分析缺少匹配的知识前置凭证', 'knowledgeContext'));
  }
  if (knowledgeContext?.status === 'degraded' && !knowledgeContext.degradedReason?.trim()) {
    failures.push(failure(
      'knowledge_degraded_reason_missing',
      '知识降级必须保留原因',
      'knowledgeContext.degradedReason',
    ));
  }

  requireObject(candidate.enterpriseSnapshot, 'enterprise_snapshot_missing', 'enterpriseSnapshot', failures);
  for (const field of ['objective', 'revenueLogic', 'stage']) {
    if (!candidate.enterpriseSnapshot?.[field]?.trim()) {
      failures.push(failure(
        'enterprise_snapshot_incomplete',
        `企业快照缺少${field}`,
        `enterpriseSnapshot.${field}`,
      ));
    }
  }
  for (const field of ['offerings', 'customers']) {
    requireNonEmptyArray(candidate.enterpriseSnapshot?.[field], 'enterprise_snapshot_incomplete', `enterpriseSnapshot.${field}`, failures);
  }

  requireNonEmptyArray(candidate.evidenceLedger, 'evidence_ledger_missing', 'evidenceLedger', failures, 3);
  const evidenceIds = new Set();
  for (const [index, item] of (candidate.evidenceLedger ?? []).entries()) {
    const itemPath = `evidenceLedger[${index}]`;
    if (!item?.id?.trim() || evidenceIds.has(item.id)) {
      failures.push(failure('evidence_id_invalid', '证据ID缺失或重复', `${itemPath}.id`));
    } else evidenceIds.add(item.id);
    if (!['fact', 'inference', 'assumption', 'unknown'].includes(item?.factClass)) {
      failures.push(failure('fact_class_invalid', '事实分类无效', `${itemPath}.factClass`));
    }
    if (!item?.statement?.trim() || !item?.sourceRef?.trim() || Number.isNaN(Date.parse(item?.observedAt))) {
      failures.push(failure('evidence_incomplete', '证据必须包含陈述、来源和日期', itemPath));
    }
  }

  requireNonEmptyArray(candidate.unknowns, 'unknowns_missing', 'unknowns', failures);
  for (const [index, item] of (candidate.unknowns ?? []).entries()) {
    if (!item?.question?.trim() || !item?.impact?.trim() || !item?.owner?.trim()) {
      failures.push(failure('unknown_incomplete', '未知项必须包含问题、影响和责任人', `unknowns[${index}]`));
    }
  }

  requireNonEmptyArray(candidate.externalContext, 'external_context_missing', 'externalContext', failures);
  requireNonEmptyArray(candidate.internalCapabilities, 'internal_capabilities_missing', 'internalCapabilities', failures);
  requireNonEmptyArray(candidate.metricBaseline, 'metric_baseline_missing', 'metricBaseline', failures);
  for (const [index, item] of (candidate.metricBaseline ?? []).entries()) {
    if (item?.value !== null
      && item?.value !== undefined
      && (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0)) {
      failures.push(failure(
        'metric_missing_evidence',
        '确认的经营指标数字必须有证据',
        `metricBaseline[${index}].evidenceRefs`,
      ));
    }
  }

  requireNonEmptyArray(candidate.issueTree, 'issue_tree_missing', 'issueTree', failures);
  for (const [index, item] of (candidate.issueTree ?? []).entries()) {
    if (!item?.issue?.trim()
      || !Array.isArray(item.causes)
      || item.causes.length === 0
      || !Array.isArray(item.impacts)
      || item.impacts.length === 0
      || !Array.isArray(item.evidenceRefs)
      || item.evidenceRefs.length === 0) {
      failures.push(failure('issue_tree_incomplete', '问题树必须包含原因、影响和证据', `issueTree[${index}]`));
    }
  }

  for (const field of ['strengths', 'constraints', 'opportunities', 'risks']) {
    requireNonEmptyArray(candidate[field], `${field}_missing`, field, failures);
    for (const [index, item] of (candidate[field] ?? []).entries()) {
      if (!item?.statement?.trim() || VAGUE.test(item.statement.trim())) {
        failures.push(failure(
          'analysis_statement_too_vague',
          '分析陈述不能使用空泛标签',
          `${field}[${index}].statement`,
        ));
      }
      if (!Array.isArray(item?.evidenceRefs) || item.evidenceRefs.length === 0) {
        failures.push(failure('analysis_evidence_missing', '分析陈述必须引用证据', `${field}[${index}].evidenceRefs`));
      }
    }
  }

  requireNonEmptyArray(candidate.coreProblems, 'core_problems_missing', 'coreProblems', failures);
  const priorities = new Set();
  for (const [index, item] of (candidate.coreProblems ?? []).entries()) {
    if (!item?.problem?.trim()
      || !Number.isInteger(item.priority)
      || item.priority < 1
      || priorities.has(item.priority)
      || !Array.isArray(item.evidenceRefs)
      || item.evidenceRefs.length === 0) {
      failures.push(failure('core_problem_invalid', '核心问题必须有唯一优先级和证据', `coreProblems[${index}]`));
    }
    priorities.add(item?.priority);
  }

  for (const [field, required] of [
    ['strategyPlanning', ['inputs', 'decisionsNeeded']],
    ['businessModel', ['inputs', 'experimentsNeeded']],
  ]) {
    const brief = candidate.downstreamBrief?.[field];
    if (!brief || required.some((key) => !Array.isArray(brief[key]) || brief[key].length === 0)) {
      failures.push(failure(
        'downstream_brief_missing',
        `缺少${field}下游简报`,
        `downstreamBrief.${field}`,
      ));
    }
  }

  requireNonEmptyArray(candidate.decisionsRequired, 'decisions_required_missing', 'decisionsRequired', failures);
  for (const [index, item] of (candidate.decisionsRequired ?? []).entries()) {
    if (item?.executed !== false || !item?.owner?.trim() || !item?.decision?.trim()) {
      failures.push(failure(
        'automatic_strategic_action',
        '重大经营决策必须由授权人决定且不得标记为已执行',
        `decisionsRequired[${index}]`,
      ));
    }
  }

  return result(failures);
}

function requireObject(value, code, pathValue, failures) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failures.push(failure(code, `${pathValue}必须是对象`, pathValue));
  }
}

function requireNonEmptyArray(value, code, pathValue, failures, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum) {
    failures.push(failure(code, `${pathValue}至少需要${minimum}项`, pathValue));
  }
}

function failure(code, message, pathValue) {
  return { code, message, path: pathValue };
}

function result(failures) {
  failures.sort((left, right) => (
    left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
  ));
  return deepFreeze({ ok: failures.length === 0, failures });
}
