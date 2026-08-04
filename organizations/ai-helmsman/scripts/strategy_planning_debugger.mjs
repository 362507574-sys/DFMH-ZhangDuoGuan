import { validateStrategyPlanningCandidate } from './strategy_planning_contract.mjs';
import { deepFreeze } from './strict_json.mjs';

export function debugStrategyPlanningCandidate({
  candidate,
  task,
  enterpriseProfile,
  knowledgeContext,
  pinnedUpstream,
  attempt = 1,
  maxAttempts = 3,
} = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error('maxAttempts must be between 1 and 3');
  }
  const failures = [
    ...validateStrategyPlanningCandidate({
      candidate,
      task,
      enterpriseProfile,
      knowledgeContext,
    }).failures,
  ];
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    checkPinnedUpstream(candidate, pinnedUpstream, failures);
    checkOptionDistinctness(candidate.strategicOptions, failures);
    checkDevelopmentPath(candidate.developmentPath, candidate.milestones, failures);
    checkResourceAllocation(candidate.resourceAllocation, failures);
    checkNinetyDayPlan(candidate, failures);
    checkTriggers(candidate.assumptions, candidate.risks, failures);
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

function checkPinnedUpstream(candidate, pinned, failures) {
  if (!pinned) return;
  const upstream = candidate.upstreamAnalysis;
  if (pinned.artifactId !== 'enterprise-analysis'
    || upstream?.version !== pinned.version
    || upstream?.sha256 !== pinned.sha256) {
    failures.push(failure(
      'pinned_upstream_mismatch',
      '战略候选绑定的企业分析与运行时固定版本或哈希不一致',
      'upstreamAnalysis',
    ));
  }
}

function checkOptionDistinctness(options, failures) {
  if (!Array.isArray(options)) return;
  const fingerprints = new Map();
  for (const [index, option] of options.entries()) {
    const fingerprint = [
      normalize(option?.thesis),
      normalizedList(option?.tradeOffs),
      normalizedList(option?.resourceRequirements),
    ].join('|');
    if (!fingerprint.replace(/\|/gu, '')) continue;
    if (fingerprints.has(fingerprint)) {
      failures.push(failure(
        'strategic_options_not_distinct',
        '战略选项只是换名，主张、取舍和资源组合没有实质差异',
        `strategicOptions[${index}]`,
      ));
    } else fingerprints.set(fingerprint, index);
  }
}

function checkDevelopmentPath(value, milestones, failures) {
  if (!Array.isArray(value) || value.length === 0) return;
  const ids = new Set(value.map((item) => item?.id).filter(Boolean));
  const sequences = new Set();
  const milestoneIds = new Set((milestones ?? []).map((item) => item?.id).filter(Boolean));
  for (const [index, phase] of value.entries()) {
    if (!phase?.id?.trim()
      || !Number.isInteger(phase.sequence)
      || phase.sequence < 1
      || sequences.has(phase.sequence)
      || !phase.objective?.trim()
      || !Array.isArray(phase.exitCriteria)
      || phase.exitCriteria.length === 0) {
      failures.push(failure(
        'development_path_incomplete',
        '发展路径阶段必须包含唯一顺序、目标和退出标准',
        `developmentPath[${index}]`,
      ));
    }
    sequences.add(phase?.sequence);
    if ((phase?.dependsOn ?? []).some((id) => !ids.has(id) || id === phase.id)) {
      failures.push(failure(
        'development_path_dependency_missing',
        '发展路径引用了不存在或自循环的依赖阶段',
        `developmentPath[${index}].dependsOn`,
      ));
    }
    if (!Array.isArray(phase?.milestoneRefs)
      || phase.milestoneRefs.length === 0
      || phase.milestoneRefs.some((id) => !milestoneIds.has(id))) {
      failures.push(failure(
        'development_path_milestone_missing',
        '发展路径阶段必须绑定现有里程碑',
        `developmentPath[${index}].milestoneRefs`,
      ));
    }
  }
  const dependencies = new Map(
    value
      .filter((item) => item?.id)
      .map((item) => [item.id, Array.isArray(item.dependsOn) ? item.dependsOn : []]),
  );
  if (hasDependencyCycle(dependencies)) {
    failures.push(failure(
      'development_path_cycle',
      '发展路径存在多阶段循环依赖',
      'developmentPath',
    ));
  }
}

function checkResourceAllocation(value, failures) {
  if (!Array.isArray(value) || value.length === 0) return;
  const totals = new Map();
  const capacities = new Map();
  for (const [index, item] of value.entries()) {
    if (!item?.resourceId?.trim()
      || !item.resourceType?.trim()
      || !item.phaseRef?.trim()
      || !Number.isFinite(item.percentage)
      || item.percentage <= 0
      || item.percentage > 100
      || !Number.isInteger(item.priority)
      || item.priority < 1
      || !item.rationale?.trim()) {
      failures.push(failure(
        'resource_allocation_incomplete',
        '资源配置必须包含资源、阶段、占比、优先级和理由',
        `resourceAllocation[${index}]`,
      ));
      continue;
    }
    const window = item.timeWindow?.trim() || item.phaseRef;
    const key = `${item.resourceId}|${window}`;
    const capacity = Number.isFinite(item.capacity) ? item.capacity : 100;
    if (capacity <= 0) {
      failures.push(failure(
        'resource_capacity_invalid',
        '资源容量必须大于0',
        `resourceAllocation[${index}].capacity`,
      ));
      continue;
    }
    if (capacities.has(key) && capacities.get(key) !== capacity) {
      failures.push(failure(
        'resource_capacity_conflict',
        '同一资源同一时间窗使用了冲突的容量口径',
        `resourceAllocation[${index}].capacity`,
      ));
    }
    capacities.set(key, capacity);
    totals.set(key, (totals.get(key) ?? 0) + item.percentage);
  }
  for (const [key, total] of totals.entries()) {
    const capacity = capacities.get(key) ?? 100;
    if (total > capacity) {
      const [resourceId, window] = key.split('|');
      failures.push(failure(
        'resource_allocation_over_capacity',
        `资源 ${resourceId} 在 ${window} 的总配置 ${total}% 超过容量 ${capacity}%`,
        'resourceAllocation',
      ));
    }
  }
}

function checkNinetyDayPlan(candidate, failures) {
  const metricIds = new Set((candidate.metrics ?? []).map((item) => item?.id).filter(Boolean));
  const goalIds = new Set((candidate.phaseGoals ?? []).map((item) => item?.id).filter(Boolean));
  for (const [index, item] of (candidate.ninetyDayPlan ?? []).entries()) {
    const path = `ninetyDayPlan[${index}]`;
    if (!item?.days?.trim()
      || !Array.isArray(item.actions)
      || item.actions.length === 0
      || !item.owner?.trim()
      || !Array.isArray(item.metricRefs)
      || item.metricRefs.length === 0
      || !Array.isArray(item.evidenceRequired)
      || item.evidenceRequired.length === 0
      || !Array.isArray(item.stopConditions)
      || item.stopConditions.length === 0) {
      failures.push(failure(
        'ninety_day_action_not_executable',
        '90天行动必须包含时间窗、动作、负责人、指标、证据和停止条件',
        path,
      ));
    }
    if (!Array.isArray(item?.phaseGoalRefs)
      || item.phaseGoalRefs.length === 0
      || item.phaseGoalRefs.some((id) => !goalIds.has(id))
      || (item?.metricRefs ?? []).some((id) => !metricIds.has(id))) {
      failures.push(failure(
        'ninety_day_action_alignment_missing',
        '90天行动必须绑定现有阶段目标和衡量指标',
        path,
      ));
    }
  }
  const covered = new Set(
    (candidate.ninetyDayPlan ?? [])
      .map((item) => normalizeDayWindow(item?.days))
      .filter(Boolean),
  );
  if (!['1-30', '31-60', '61-90'].every((window) => covered.has(window))) {
    failures.push(failure(
      'ninety_day_coverage_incomplete',
      '90天行动必须完整覆盖1至30天、31至60天和61至90天',
      'ninetyDayPlan',
    ));
  }
}

function checkTriggers(assumptions, risks, failures) {
  for (const [collection, values] of [['assumptions', assumptions], ['risks', risks]]) {
    for (const [index, item] of (values ?? []).entries()) {
      if (!item?.trigger?.trim()) {
        failures.push(failure(
          'trigger_missing',
          '战略假设和风险必须设置触发条件',
          `${collection}[${index}].trigger`,
        ));
      }
    }
  }
}

function normalize(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
    : '';
}

function normalizedList(value) {
  return Array.isArray(value)
    ? value.map(normalize).filter(Boolean).sort().join('~')
    : '';
}

function normalizeDayWindow(value) {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/gu, '');
  for (const window of ['1-30', '31-60', '61-90']) {
    const [start, end] = window.split('-');
    if (new RegExp(`(?:^|[^0-9])${start}[^0-9]+${end}(?:[^0-9]|$)`, 'u').test(compact)) {
      return window;
    }
  }
  return '';
}

function hasDependencyCycle(graph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
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
