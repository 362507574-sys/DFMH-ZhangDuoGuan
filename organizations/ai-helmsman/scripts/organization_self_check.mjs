import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOrganizationConfig } from './organization_config.mjs';
import { readStrictJson } from './strict_json.mjs';

const REQUIRED_FILES = [
  'AGENTS.md',
  'ORGANIZATION.md',
  'ORGANIZATION_OVERVIEW.md',
  'WORKFLOWS.md',
  'USER_GUIDE.md',
  'DECISIONS.md',
  'CHANGELOG.md',
  'TROUBLESHOOTING.md',
  'ENVIRONMENT.md',
  'config/organization.json',
  'quality/organization-quality.json',
  'contracts/enterprise-profile.schema.json',
  'contracts/organization-task.schema.json',
  'contracts/collaboration-request.schema.json',
  'contracts/collaboration-result.schema.json',
  'contracts/enterprise-analysis-candidate.schema.json',
  'contracts/strategy-planning-candidate.schema.json',
  'contracts/business-model-candidate.schema.json',
  'contracts/business-model-execution-plan.schema.json',
  'contracts/business-model-runtime-state.schema.json',
  'contracts/business-model-publication-request.schema.json',
  'contracts/helmsman-pipeline-candidate.schema.json',
  'integration/root-registration-candidate.json',
  'integration/CONTROL_CENTER_HANDOFF.md',
  'scripts/strict_json.mjs',
  'scripts/organization_paths.mjs',
  'scripts/organization_config.mjs',
  'scripts/enterprise_store.mjs',
  'scripts/organization_task_store.mjs',
  'scripts/shared_runtime_adapter.mjs',
  'scripts/knowledge_preflight_adapter.mjs',
  'scripts/collaboration_contract.mjs',
  'scripts/enterprise_analysis_contract.mjs',
  'scripts/enterprise_analysis_gate.mjs',
  'scripts/strategy_planning_contract.mjs',
  'scripts/strategy_planning_gate.mjs',
  'scripts/business_model_contract.mjs',
  'scripts/business_model_gate.mjs',
  'scripts/business_model_planner.mjs',
  'scripts/business_model_debugger.mjs',
  'scripts/business_model_runtime.mjs',
  'scripts/helmsman_pipeline_contract.mjs',
  'workflows/ENTERPRISE_ANALYSIS_PILOT.md',
  'workflows/STRATEGY_PLANNING_PILOT.md',
  'workflows/BUSINESS_MODEL_PILOT.md',
  'templates/ENTERPRISE_STRATEGY_PROFILE.json',
  'templates/ORGANIZATION_TASK.json',
  'templates/ENTERPRISE_ANALYSIS_CANDIDATE.json',
  'templates/STRATEGY_PLANNING_CANDIDATE.json',
  'templates/BUSINESS_MODEL_CANDIDATE.json',
  'templates/BUSINESS_MODEL_EXECUTION_PLAN.json',
  'templates/HELMSMAN_PIPELINE_CANDIDATE.json',
  'enterprises/README.md',
  'tasks/README.md',
  'temp/README.md',
  'skills/README.md',
  'skills/enterprise-analysis/SKILL.md',
  'skills/enterprise-analysis/agents/openai.yaml',
  'skills/strategy-planning/SKILL.md',
  'skills/strategy-planning/agents/openai.yaml',
  'skills/business-model/SKILL.md',
  'skills/business-model/agents/openai.yaml',
];

export async function runOrganizationSelfCheck({ projectRoot } = {}) {
  const organizationRoot = path.join(projectRoot, 'organizations', 'ai-helmsman');
  const issues = [];
  for (const relative of REQUIRED_FILES) {
    const details = await lstat(path.join(organizationRoot, relative)).catch(() => null);
    if (!details?.isFile() || details.size === 0) issues.push(`missing or empty file: ${relative}`);
  }

  let config;
  try {
    config = await loadOrganizationConfig({ projectRoot });
  } catch (error) {
    issues.push(`organization config invalid: ${error.message}`);
  }
  if (config) {
    const statuses = new Map(config.coreSkills.map((item) => [item.id, item.status]));
    if (statuses.get('enterprise-analysis') !== 'pilot') {
      issues.push('enterprise-analysis must remain pilot');
    }
    if (statuses.get('strategy-planning') !== 'pilot') {
      issues.push('strategy-planning must be pilot after completed trial');
    }
    if (statuses.get('business-model') !== 'pilot') {
      issues.push('business-model must be pilot after completed trial');
    }
    if (config.coreSkills.some((item) => item.id.startsWith('public.'))) {
      issues.push('public skills must not enter coreSkills');
    }
  }

  const charter = await readText(path.join(organizationRoot, 'ORGANIZATION.md'));
  if (!/不修改总控根级路由/u.test(charter)) issues.push('charter must state 不修改总控根级路由');
  if (!/不直接写根级`outputs\/`/u.test(charter)) issues.push('charter must forbid root outputs writes');
  for (const skill of ['企业分析', '战略规划', '商业模式']) {
    if (!charter.includes(skill)) issues.push(`charter is missing core skill: ${skill}`);
  }

  const workflow = await readText(path.join(organizationRoot, 'workflows', 'ENTERPRISE_ANALYSIS_PILOT.md'));
  for (const expected of ['飞书知识前置', '证据账本', '使用者决策', '小范围试运行', '正式晋级']) {
    if (!workflow.includes(expected)) issues.push(`ENTERPRISE_ANALYSIS_PILOT missing: ${expected}`);
  }
  for (const [relative, expected] of [
    ['workflows/STRATEGY_PLANNING_PILOT.md', ['至少两个', '不做清单', '90天', '候选']],
    ['workflows/BUSINESS_MODEL_PILOT.md', ['付费者', '单位经济', '变量', '停止']],
  ]) {
    const content = await readText(path.join(organizationRoot, relative));
    const phrases = relative === 'workflows/BUSINESS_MODEL_PILOT.md'
      ? [
        '付费者',
        '单位经济',
        '变量',
        '停止',
        '产品结构',
        '盈利模式',
        '客户价值链',
        '增长模型',
        'resumeKey',
      ]
      : expected;
    for (const phrase of phrases) {
      if (!content.includes(phrase)) issues.push(`${relative} missing: ${phrase}`);
    }
  }

  for (const relative of REQUIRED_FILES.filter((item) => (
    item.endsWith('.json') && (item.startsWith('contracts/') || item.startsWith('templates/'))
  ))) {
    try {
      await readStrictJson(path.join(organizationRoot, relative), { label: relative });
    } catch (error) {
      issues.push(`${relative} invalid: ${error.message}`);
    }
  }

  try {
    const candidate = await readStrictJson(
      path.join(organizationRoot, 'integration', 'root-registration-candidate.json'),
      { label: 'root registration candidate' },
    );
    if (candidate.rootControllerRegistration !== 'registered_designing'
      || candidate.formalTaskRouting !== 'fallback_existing'
      || candidate.peerOrganizationCalls !== 'contract_only'
      || candidate.acceptsFormalTasks !== false
      || candidate.organizationStatusUpdate !== 'designing') {
      issues.push('root registration candidate overstates connected or operational status');
    }
    const updates = new Map(candidate.coreSkillStatusUpdates?.map((item) => [item.id, item.status]));
    if (updates.get('enterprise-analysis') !== 'designing'
      || updates.get('strategy-planning') !== 'designing'
      || updates.get('business-model') !== 'designing') {
      issues.push('root registration candidate must keep all root skills designing');
    }
  } catch (error) {
    issues.push(`root registration candidate invalid: ${error.message}`);
  }

  const counts = await countTree(organizationRoot);
  return Object.freeze({
    ok: issues.length === 0,
    files: counts.files,
    directories: counts.directories,
    issues: Object.freeze(issues.sort()),
  });
}

async function countTree(root) {
  let files = 0;
  let directories = 1;
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories += 1;
        await walk(target);
      } else if (entry.isFile()) files += 1;
    }
  };
  await walk(root);
  return { files, directories };
}

async function readText(filePath) {
  return readFile(filePath, 'utf8').catch(() => '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const result = await runOrganizationSelfCheck({ projectRoot });
  if (result.ok) {
    console.log(
      `PASS: AI helmsman self-check completed. Files=${result.files}, Directories=${result.directories}, Issues=0.`,
    );
  } else {
    for (const issue of result.issues) console.error(`FAIL: ${issue}`);
    process.exitCode = 1;
  }
}
