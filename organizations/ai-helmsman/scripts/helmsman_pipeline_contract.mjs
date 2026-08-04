import { deepFreeze } from './strict_json.mjs';

const SEQUENCE = ['enterprise-analysis', 'strategy-planning', 'business-model'];

export function validateHelmsmanPipelineCandidate(candidate) {
  const failures = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return result([{ code: 'pipeline_missing', message: '联合候选必须是对象', path: 'candidate' }]);
  }
  if (candidate.schemaVersion !== 1
    || candidate.capabilityId !== 'helmsman-pipeline'
    || candidate.status !== 'candidate'
    || !Number.isInteger(candidate.version)
    || candidate.version < 1
    || !candidate.enterpriseId?.trim()
    || !candidate.taskId?.trim()) {
    failures.push(failure('pipeline_identity_invalid', '联合候选身份或版本无效', 'candidate'));
  }
  if (!Array.isArray(candidate.stages)
    || candidate.stages.length !== SEQUENCE.length
    || candidate.stages.some((stage, index) => stage?.capabilityId !== SEQUENCE[index])) {
    failures.push(failure('pipeline_sequence_invalid', '联合链路必须按企业分析、战略规划、商业模式顺序', 'stages'));
  }
  const seenTasks = new Set();
  for (const [index, stage] of (candidate.stages ?? []).entries()) {
    const itemPath = `stages[${index}]`;
    if (stage?.enterpriseId !== candidate.enterpriseId) {
      failures.push(failure('pipeline_enterprise_mismatch', '三个技能必须属于同一企业', `${itemPath}.enterpriseId`));
    }
    if (!stage?.taskId?.trim() || seenTasks.has(stage.taskId)) {
      failures.push(failure('pipeline_task_invalid', '每个技能必须绑定唯一任务', `${itemPath}.taskId`));
    } else seenTasks.add(stage.taskId);
    if (!Number.isInteger(stage?.version) || stage.version < 1) {
      failures.push(failure('pipeline_version_invalid', '每个技能必须绑定有效版本', `${itemPath}.version`));
    }
    if (!/^[a-f0-9]{64}$/u.test(stage?.sha256 ?? '')) {
      failures.push(failure('pipeline_hash_invalid', '每个技能必须绑定SHA-256', `${itemPath}.sha256`));
    }
    if (!['candidate', 'formal'].includes(stage?.status)) {
      failures.push(failure('pipeline_stage_status_invalid', '技能阶段状态必须是candidate或formal', `${itemPath}.status`));
    }
  }
  if (!candidate.readiness
    || candidate.readiness.enterpriseAnalysis !== 'passed'
    || candidate.readiness.strategyPlanning !== 'passed'
    || candidate.readiness.businessModel !== 'passed') {
    failures.push(failure('pipeline_readiness_incomplete', '三个技能质量门禁必须全部通过', 'readiness'));
  }
  if (!Array.isArray(candidate.unresolvedRisks) || candidate.unresolvedRisks.length === 0) {
    failures.push(failure('pipeline_risks_missing', '联合候选必须保留未解决风险', 'unresolvedRisks'));
  }
  if (!Array.isArray(candidate.decisionsRequired) || candidate.decisionsRequired.length === 0) {
    failures.push(failure('pipeline_decisions_missing', '联合候选必须包含使用者决策项', 'decisionsRequired'));
  }
  for (const [index, item] of (candidate.decisionsRequired ?? []).entries()) {
    if (!item?.decision?.trim() || !item?.owner?.trim() || item.executed !== false) {
      failures.push(failure('automatic_pipeline_action', '联合候选不得自动执行重大动作', `decisionsRequired[${index}]`));
    }
  }
  return result(failures);
}

function failure(code, message, path) {
  return { code, message, path };
}

function result(failures) {
  const unique = [...new Map(failures.map((item) => [`${item.code}|${item.path}`, item])).values()];
  unique.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return deepFreeze({ ok: unique.length === 0, failures: unique });
}
