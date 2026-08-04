import { validateStrategyPlanningCandidate } from './strategy_planning_contract.mjs';

export function checkBeforeStrategyPlanning({
  task,
  enterpriseProfile,
  knowledgeContext,
  upstreamAnalysis,
} = {}) {
  const failures = [];
  if (!task || task.capabilityId !== 'strategy-planning'
    || !enterpriseProfile
    || task.enterpriseId !== enterpriseProfile.enterpriseId) {
    failures.push({ code: 'enterprise_context_missing', path: 'enterpriseId' });
  }
  const scopes = task?.accessEnvelope?.allowedScopes ?? [];
  if (!scopes.includes('strategy.read') || !scopes.includes('strategy.draft.write')) {
    failures.push({ code: 'access_scope_missing', path: 'accessEnvelope' });
  }
  if (!knowledgeContext
    || knowledgeContext.requestId !== task?.requestId
    || knowledgeContext.capabilityId !== 'ai-helmsman.strategy-planning'
    || knowledgeContext.status !== task?.knowledgeStatus
    || !['matched', 'no_hit', 'degraded'].includes(knowledgeContext.status)) {
    failures.push({ code: 'knowledge_preflight_incomplete', path: 'knowledgeContext' });
  }
  if (!upstreamAnalysis
    || upstreamAnalysis.enterpriseId !== task?.enterpriseId
    || upstreamAnalysis.capabilityId !== 'enterprise-analysis'
    || !Number.isInteger(upstreamAnalysis.version)
    || !/^[a-f0-9]{64}$/u.test(upstreamAnalysis.sha256 ?? '')) {
    failures.push({ code: 'upstream_analysis_invalid', path: 'upstreamAnalysis' });
  }
  failures.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

export function checkStrategyCandidate(input = {}) {
  return validateStrategyPlanningCandidate(input);
}

