import { validateEnterpriseAnalysisCandidate } from './enterprise_analysis_contract.mjs';
import { deepFreeze } from './strict_json.mjs';

const EVIDENCE_FIELDS = Object.freeze([
  ['externalContext', 'evidenceRefs'],
  ['internalCapabilities', 'evidenceRefs'],
  ['metricBaseline', 'evidenceRefs'],
  ['issueTree', 'evidenceRefs'],
  ['strengths', 'evidenceRefs'],
  ['constraints', 'evidenceRefs'],
  ['opportunities', 'evidenceRefs'],
  ['risks', 'evidenceRefs'],
  ['coreProblems', 'evidenceRefs'],
]);

export function debugEnterpriseAnalysisCandidate({
  candidate,
  task,
  enterpriseProfile,
  knowledgeContext,
  attempt = 1,
  maxAttempts = 3,
} = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error('maxAttempts must be between 1 and 3');
  }
  const failures = [
    ...validateEnterpriseAnalysisCandidate({
      candidate,
      task,
      enterpriseProfile,
      knowledgeContext,
    }).failures,
  ];
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const evidenceIds = new Set(
      (candidate.evidenceLedger ?? []).map((item) => item?.id).filter(Boolean),
    );
    for (const [collection, field] of EVIDENCE_FIELDS) {
      for (const [index, item] of (candidate[collection] ?? []).entries()) {
        for (const evidenceRef of (item?.[field] ?? [])) {
          if (!evidenceIds.has(evidenceRef)) {
            failures.push(failure(
              'unknown_evidence_ref',
              '分析结论引用了不存在的证据',
              `${collection}[${index}].${field}`,
            ));
          }
        }
      }
    }
    for (const [index, item] of (candidate.evidenceLedger ?? []).entries()) {
      if (Array.isArray(item?.conflictsWith) && item.conflictsWith.length > 0) {
        const resolution = item.conflictResolution;
        if (!resolution
          || (typeof resolution === 'string'
            && (!resolution.trim() || resolution.trim().toLowerCase() === 'unresolved'))) {
          failures.push(failure(
            'unresolved_source_conflict',
            '相互冲突的来源尚未记录处理方式',
            `evidenceLedger[${index}].conflictResolution`,
          ));
        } else if (!completeConflictResolution(resolution)) {
          failures.push(failure(
            'conflict_resolution_incomplete',
            '冲突处理必须记录口径、时效、可信度、采用方式和影响',
            `evidenceLedger[${index}].conflictResolution`,
          ));
        }
      }
    }
    for (const [index, item] of (candidate.issueTree ?? []).entries()) {
      const issue = normalize(item?.issue);
      if (issue && (item?.causes ?? []).some((cause) => normalize(cause) === issue)) {
        failures.push(failure(
          'circular_issue_cause',
          '问题不能把自身列为原因',
          `issueTree[${index}].causes`,
        ));
      }
    }
    const problems = new Map();
    for (const [index, item] of (candidate.coreProblems ?? []).entries()) {
      const key = normalize(item?.problem);
      if (!key) continue;
      if (problems.has(key)) {
        failures.push(failure(
          'duplicate_core_problem',
          '核心问题重复，必须合并后重新排序',
          `coreProblems[${index}].problem`,
        ));
      } else problems.set(key, index);
    }
  }
  const unique = deduplicateAndSort(failures);
  const waitingInput = unique.some((item) => item.code === 'unresolved_source_conflict');
  const decision = unique.length === 0
    ? 'pass'
    : attempt >= maxAttempts
      ? 'stop'
      : waitingInput
        ? 'waiting_input'
        : 'revise';
  return deepFreeze({
    ok: unique.length === 0,
    attempt,
    maxAttempts,
    decision,
    failures: unique,
  });
}

function completeConflictResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    'sourceScope',
    'timeScope',
    'confidenceAssessment',
    'adoptionMethod',
    'impact',
  ].every((field) => typeof value[field] === 'string' && value[field].trim());
}

function failure(code, message, path) {
  return { code, message, path };
}

function normalize(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
    : '';
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
