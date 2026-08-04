import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { createOrganizationPaths } from './organization_paths.mjs';
import { deepFreeze, readStrictJson } from './strict_json.mjs';

const ACCEPTED = new Set(['matched', 'no_hit', 'degraded']);

export async function runOrganizationKnowledgePreflight({
  projectRoot,
  task,
  executeCli = defaultExecuteCli,
} = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError('knowledge preflight task is required');
  }
  const paths = await createOrganizationPaths({ projectRoot });
  if (task.requestId !== task.taskId) throw new Error('requestId must match organization taskId');
  const evidenceAbsolutePath = paths.evidenceFile(
    task.enterpriseId,
    task.taskId,
    'knowledge_context.json',
  );
  const evidencePath = path.relative(projectRoot, evidenceAbsolutePath).split(path.sep).join('/');
  if (task.evidencePath !== undefined && task.evidencePath !== evidencePath) {
    throw new Error('evidencePath is fixed to the current enterprise and task');
  }
  const input = {
    requestId: task.requestId,
    text: requiredText(task.text, 'text', 20_000),
    summary: requiredText(task.summary, 'summary', 1_000),
    capabilityId: requiredText(task.capabilityId, 'capabilityId', 160),
    evidencePath,
  };
  await mkdir(path.dirname(evidenceAbsolutePath), { recursive: true });
  await executeCli({
    projectRoot,
    input,
    evidenceAbsolutePath,
    cliPath: path.join(projectRoot, 'scripts', 'run_feishu_knowledge_preflight.mjs'),
  });
  const evidence = await readStrictJson(evidenceAbsolutePath, {
    label: 'organization knowledge preflight evidence',
    maxBytes: 2 * 1024 * 1024,
  });
  if (evidence.requestId !== input.requestId || evidence.capabilityId !== input.capabilityId) {
    throw new Error('knowledge evidence request or capability mismatch');
  }
  if (evidence.status === 'skipped_non_business') {
    throw new Error('formal enterprise analysis task cannot use skipped_non_business');
  }
  if (!ACCEPTED.has(evidence.status)) throw new Error('knowledge evidence status is invalid');
  if (!Array.isArray(evidence.sources)) throw new Error('knowledge evidence sources must be an array');
  if (evidence.status === 'degraded' && !requiredText(evidence.degradedReason, 'degradedReason', 2_000)) {
    throw new Error('degraded knowledge evidence requires a reason');
  }
  for (const [index, source] of evidence.sources.entries()) {
    if (!source || typeof source !== 'object'
      || !requiredText(source.spaceName, `sources[${index}].spaceName`, 160)
      || !requiredText(source.title, `sources[${index}].title`, 500)
      || !(source.url || source.token)
      || !requiredText(source.excerpt, `sources[${index}].excerpt`, 1_500)) {
      throw new Error(`knowledge source is incomplete at index ${index}`);
    }
  }
  return deepFreeze(evidence);
}

async function defaultExecuteCli({ projectRoot, input, cliPath }) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('knowledge preflight adapter timed out'));
    }, 20_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`knowledge preflight CLI failed (${code}): ${stderr.slice(0, 1000)}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function requiredText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${label} exceeds size limit`);
  return result;
}
