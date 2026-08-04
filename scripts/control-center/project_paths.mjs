import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  requireBusinessProjectId,
  requireEnterpriseId,
  requireSafeId,
} from './project_contract.mjs';

export async function createProjectPaths({ projectRoot } = {}) {
  const root = await canonicalDirectory(projectRoot, 'projectRoot');
  const businessRoot = path.join(root, 'business-projects');
  const registryRoot = path.join(root, 'control-center', 'registries', 'projects');

  const project = (enterpriseId, businessProjectId) => bounded(
    businessRoot,
    requireEnterpriseId(enterpriseId),
    requireBusinessProjectId(businessProjectId),
  );
  return Object.freeze({
    businessRoot,
    registryRoot,
    projectRoot: project,
    projectFile: (enterpriseId, businessProjectId) =>
      path.join(project(enterpriseId, businessProjectId), 'project.json'),
    projectIndexFile: (businessProjectId) =>
      bounded(registryRoot, `${requireBusinessProjectId(businessProjectId)}.json`),
    organizationWorkspace: (enterpriseId, businessProjectId, organizationId) =>
      path.join(
        project(enterpriseId, businessProjectId),
        'organizations',
        requireSafeId(organizationId, 'organizationId'),
      ),
    artifactRoot: (enterpriseId, businessProjectId, artifactId) =>
      path.join(
        project(enterpriseId, businessProjectId),
        'shared-artifacts',
        requireSafeId(artifactId, 'artifactId'),
      ),
    importRoot: (enterpriseId, businessProjectId, importId) =>
      path.join(
        project(enterpriseId, businessProjectId),
        'imports',
        requireSafeId(importId, 'importId'),
      ),
    auditFile: (enterpriseId, businessProjectId) =>
      path.join(project(enterpriseId, businessProjectId), 'audit', 'timeline.ndjson'),
  });
}

function bounded(base, ...segments) {
  const candidate = path.resolve(base, ...segments);
  const relative = path.relative(path.resolve(base), candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('project path escapes its allowed root');
  }
  return candidate;
}

async function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  const canonical = await realpath(value).catch((error) => {
    throw new Error(`${label} does not exist: ${error.message}`, { cause: error });
  });
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}
