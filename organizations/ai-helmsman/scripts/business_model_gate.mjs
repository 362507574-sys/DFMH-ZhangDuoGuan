import { validateBusinessModelCandidate } from './business_model_contract.mjs';

export function checkBeforeBusinessModel({
  task,
  enterpriseProfile,
  knowledgeContext,
  upstreamAnalysis,
  upstreamStrategy,
} = {}) {
  const failures = [];
  if (!task || task.capabilityId !== 'business-model'
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
    || knowledgeContext.capabilityId !== 'ai-helmsman.business-model'
    || knowledgeContext.status !== task?.knowledgeStatus
    || !['matched', 'no_hit', 'degraded'].includes(knowledgeContext.status)) {
    failures.push({ code: 'knowledge_preflight_incomplete', path: 'knowledgeContext' });
  }
  for (const [value, capabilityId, pathValue] of [
    [upstreamAnalysis, 'enterprise-analysis', 'upstreamAnalysis'],
    [upstreamStrategy, 'strategy-planning', 'upstreamStrategy'],
  ]) {
    if (!value
      || value.capabilityId !== capabilityId
      || value.enterpriseId !== task?.enterpriseId
      || !Number.isInteger(value.version)
      || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '')) {
      failures.push({ code: 'upstream_invalid', path: pathValue });
    }
  }
  failures.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

export function checkBusinessModelCandidate(input = {}) {
  return validateBusinessModelCandidate(input);
}

