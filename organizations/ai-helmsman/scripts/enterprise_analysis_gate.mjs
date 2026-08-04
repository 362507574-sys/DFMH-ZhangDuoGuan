import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  sha256File,
  writeJsonAtomic,
} from '../../../scripts/feishu-commander/atomic_store.mjs';
import { validateEnterpriseAnalysisCandidate } from './enterprise_analysis_contract.mjs';
import { createOrganizationPaths } from './organization_paths.mjs';
import { readStrictJson } from './strict_json.mjs';

export function checkBeforeAnalysis({ task, enterpriseProfile, knowledgeContext } = {}) {
  const failures = [];
  if (!task || !enterpriseProfile || task.enterpriseId !== enterpriseProfile.enterpriseId) {
    failures.push(failure('enterprise_context_missing', '企业与任务上下文不匹配', 'enterpriseId'));
  }
  const scopes = task?.accessEnvelope?.allowedScopes ?? [];
  if (!scopes.includes('strategy.read') || !scopes.includes('strategy.draft.write')) {
    failures.push(failure('access_scope_missing', '企业分析需要战略读取和候选写入权限', 'accessEnvelope'));
  }
  if (!knowledgeContext
    || !['matched', 'no_hit', 'degraded'].includes(knowledgeContext.status)
    || task?.knowledgeStatus !== knowledgeContext?.status) {
    failures.push(failure('knowledge_preflight_incomplete', '知识前置尚未完成', 'knowledgeContext'));
  }
  if (knowledgeContext?.status === 'degraded' && !knowledgeContext.degradedReason?.trim()) {
    failures.push(failure(
      'knowledge_degraded_reason_missing',
      '知识降级必须保留原因',
      'knowledgeContext.degradedReason',
    ));
  }
  return result(failures);
}

export function checkCandidate({
  candidate,
  task,
  enterpriseProfile,
  knowledgeContext,
} = {}) {
  return validateEnterpriseAnalysisCandidate({
    candidate,
    task,
    enterpriseProfile,
    knowledgeContext,
  });
}

export async function promoteApprovedCandidate({
  projectRoot,
  task,
  enterpriseProfile,
  knowledgeContext,
  candidatePath,
  decision,
  accessEnvelope,
} = {}) {
  if (decision?.decision !== 'approve') throw new Error('user approval required before promotion');
  if (!task || task.status !== 'approved') throw new Error('organization task must be approved');
  if (task.enterpriseId !== enterpriseProfile?.enterpriseId
    || task.enterpriseId !== decision.enterpriseId
    || task.taskId !== decision.taskId) {
    throw new Error('promotion enterprise or task mismatch');
  }
  validateFormalWriteAccess(accessEnvelope, task.enterpriseId);
  const paths = await createOrganizationPaths({ projectRoot });
  const expectedCandidatePath = paths.candidateFile(
    task.enterpriseId,
    task.taskId,
    decision.candidateVersion,
  );
  if (path.resolve(candidatePath) !== path.resolve(expectedCandidatePath)) {
    throw new Error('candidate path must stay in the current enterprise task');
  }
  const candidate = await readStrictJson(candidatePath, { label: 'enterprise analysis candidate' });
  const actualCandidateSha256 = await sha256File(candidatePath);
  if (actualCandidateSha256 !== decision.candidateSha256) {
    throw new Error('candidate hash mismatch with user decision');
  }
  if (candidate.version !== decision.candidateVersion
    || candidate.enterpriseId !== task.enterpriseId
    || candidate.taskId !== task.taskId) {
    throw new Error('candidate identity mismatch');
  }
  const checked = checkCandidate({ candidate, task, enterpriseProfile, knowledgeContext });
  if (!checked.ok) {
    throw new Error(`candidate gate failed: ${checked.failures.map((item) => item.code).join(', ')}`);
  }
  const formalPath = paths.enterpriseAssetVersion(
    task.enterpriseId,
    'enterprise-analysis',
    candidate.version,
  );
  if (await exists(formalPath)) throw new Error('approved formal asset version cannot be overwritten');
  const formalRecord = {
    schemaVersion: 1,
    enterpriseId: task.enterpriseId,
    taskId: task.taskId,
    capabilityId: 'enterprise-analysis',
    version: candidate.version,
    candidateSha256: actualCandidateSha256,
    approval: decision,
    asset: candidate,
    archivedAt: decision.decidedAt,
  };
  await writeJsonAtomic(formalPath, formalRecord);
  const formalAssetSha256 = await sha256File(formalPath);
  await writeJsonAtomic(paths.enterpriseAssetCurrent(task.enterpriseId, 'enterprise-analysis'), {
    schemaVersion: 1,
    enterpriseId: task.enterpriseId,
    capabilityId: 'enterprise-analysis',
    version: candidate.version,
    formalAssetSha256,
    updatedAt: decision.decidedAt,
  });
  const formalAssetRef = path.relative(projectRoot, formalPath).split(path.sep).join('/');
  const returnPackage = {
    schemaVersion: 1,
    parentTaskId: task.parentTaskId,
    enterpriseId: task.enterpriseId,
    primaryOrganization: 'ai-helmsman',
    capabilityId: 'enterprise-analysis',
    status: 'completed',
    formalAssetRef,
    formalAssetSha256,
    evidenceRefs: candidate.evidenceLedger?.map((item) => item.sourceRef).filter(Boolean) ?? [],
    risks: candidate.risks ?? [],
    unresolvedItems: candidate.unknowns ?? [],
    completedAt: decision.decidedAt,
  };
  await writeJsonAtomic(paths.returnPackageFile(task.enterpriseId, task.taskId), returnPackage);
  return Object.freeze(returnPackage);
}

function validateFormalWriteAccess(envelope, enterpriseId) {
  const scope = 'strategy.formal.write';
  if (!envelope || envelope.enterpriseId !== enterpriseId) throw new Error('formal write enterprise mismatch');
  if (envelope.deniedScopes?.includes(scope)) throw new Error('formal write scope is denied');
  if (!envelope.allowedScopes?.includes(scope)) throw new Error('formal write scope is missing');
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= Date.now()) {
    throw new Error('formal write access expired');
  }
}

function failure(code, message, pathValue) {
  return { code, message, path: pathValue };
}

function result(failures) {
  failures.sort((left, right) => (
    left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
  ));
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

async function exists(filePath) {
  return Boolean(await lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }));
}
