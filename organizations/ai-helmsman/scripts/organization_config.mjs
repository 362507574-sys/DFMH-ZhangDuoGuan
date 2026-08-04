import path from 'node:path';

import { deepFreeze, readStrictJson } from './strict_json.mjs';

const FIELDS = new Set([
  'schemaVersion',
  'id',
  'displayName',
  'systemName',
  'deploymentMode',
  'status',
  'acceptsFormalTasks',
  'rootControllerRegistration',
  'formalTaskRouting',
  'coreSkills',
  'publicSkillDependencies',
]);
const CORE = [
  ['enterprise-analysis', '企业分析'],
  ['strategy-planning', '战略规划'],
  ['business-model', '商业模式'],
];
const PUBLIC = ['public.promotional-poster', 'public.taobao-ecommerce-image-set'];

export async function loadOrganizationConfig({ projectRoot } = {}) {
  const filePath = path.join(
    projectRoot,
    'organizations',
    'ai-helmsman',
    'config',
    'organization.json',
  );
  const value = await readStrictJson(filePath, {
    label: 'AI helmsman config',
    allowedKeys: FIELDS,
  });
  for (const field of FIELDS) {
    if (!Object.hasOwn(value, field)) throw new Error(`organization config missing field: ${field}`);
  }
  if (value.schemaVersion !== 1
    || value.id !== 'ai-helmsman'
    || value.displayName !== 'AI掌舵官'
    || value.systemName !== '战略决策系统'
    || value.deploymentMode !== 'same_project_organization_module') {
    throw new Error('organization identity or deployment mode drifted');
  }
  if (!['designing', 'pilot'].includes(value.status)) throw new Error('organization status is invalid');
  if (value.acceptsFormalTasks !== false) throw new Error('non-operational organization cannot accept formal tasks');
  if (value.rootControllerRegistration !== 'registered_designing'
    || value.formalTaskRouting !== 'fallback_existing') {
    throw new Error('root registration or formal task routing is overstated');
  }
  if (!Array.isArray(value.coreSkills) || value.coreSkills.length !== 3) {
    throw new Error('organization must declare exactly three core skills');
  }
  value.coreSkills.forEach((skill, index) => {
    const expected = CORE[index];
    if (Object.keys(skill).sort().join(',') !== 'id,name,status'
      || skill.id !== expected[0]
      || skill.name !== expected[1]
      || !['designing', 'pilot'].includes(skill.status)) {
      throw new Error(`core skill status or identity is invalid: ${expected[0]}`);
    }
  });
  if (!Array.isArray(value.publicSkillDependencies)
    || value.publicSkillDependencies.length !== 2
    || value.publicSkillDependencies.some(
      (item, index) => Object.keys(item).sort().join(',') !== 'id,mode'
        || item.id !== PUBLIC[index]
        || item.mode !== 'via-control-center',
    )) {
    throw new Error('public skill dependencies are invalid');
  }
  return deepFreeze(value);
}
