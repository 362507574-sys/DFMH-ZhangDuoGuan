import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { createProjectArtifactStore } from '../../../scripts/control-center/project_artifact_store.mjs';
import { createProjectPaths } from '../../../scripts/control-center/project_paths.mjs';
import {
  sha256File,
  writeJsonAtomic,
} from '../../../scripts/feishu-commander/atomic_store.mjs';
import { buildStrategyPlanningPlan } from './strategy_planning_planner.mjs';
import { debugStrategyPlanningCandidate } from './strategy_planning_debugger.mjs';
import { createSharedRuntimeAdapter } from './shared_runtime_adapter.mjs';
import { deepFreeze } from './strict_json.mjs';

const TASK_ID = /^[0-9]{8}-[0-9]{3}-[a-z0-9-]{3,80}$/u;
const RESUMABLE_PROJECT_STATUSES = new Set([
  'active',
  'waiting_input',
  'in_progress',
  'waiting_review',
  'completed',
]);
const TERMINAL_TASK_STATUSES = new Set(['failed', 'cancelled', 'published']);
export async function createStrategyPlanningRuntime({
  projectRoot,
  now = () => new Date(),
} = {}) {
  const paths = await createProjectPaths({ projectRoot });
  const artifactStore = await createProjectArtifactStore({ projectRoot, now });
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const { exclusive } = createSharedRuntimeAdapter({ now });

  const taskPaths = (enterpriseId, businessProjectId, taskId) => {
    requireTaskId(taskId);
    const workspace = paths.organizationWorkspace(
      enterpriseId,
      businessProjectId,
      'ai-helmsman',
    );
    const taskRoot = path.join(workspace, 'tasks', taskId);
    assertInside(workspace, taskRoot, 'strategy planning task');
    return Object.freeze({
      taskRoot,
      planFile: path.join(taskRoot, 'execution-plan.json'),
      plansRoot: path.join(taskRoot, 'plans'),
      stateFile: path.join(taskRoot, 'runtime-state.json'),
      candidatesRoot: path.join(taskRoot, 'candidates'),
      debugRoot: path.join(taskRoot, 'debug-reports'),
      publicationRoot: path.join(taskRoot, 'publication-requests'),
      evidenceRoot: path.join(taskRoot, 'evidence'),
      draftsRoot: path.join(taskRoot, 'drafts'),
    });
  };

  const readState = async ({ enterpriseId, businessProjectId, taskId } = {}) => {
    const task = taskPaths(enterpriseId, businessProjectId, taskId);
    return deepFreeze(await readJson(task.stateFile, 'strategy planning runtime state'));
  };

  return Object.freeze({
    async initializeTask({
      enterpriseId,
      businessProjectId,
      taskId,
      objective,
      artifactBindings = [],
      evidenceBindings = [],
    } = {}) {
      return exclusive(keyOf(enterpriseId, businessProjectId, taskId), async () => {
        await readProject(paths, enterpriseId, businessProjectId);
        const task = taskPaths(enterpriseId, businessProjectId, taskId);
        const existing = await readOptionalJson(task.stateFile);
        const createdAt = existing?.createdAt ?? isoNow(now);
        const plan = buildStrategyPlanningPlan({
          enterpriseId,
          businessProjectId,
          taskId,
          objective,
          planVersion: existing?.planVersion ?? 1,
          artifactBindings,
          evidenceBindings,
          createdAt,
        });
        await verifyEvidenceBindings(
          paths.projectRoot(enterpriseId, businessProjectId),
          plan.evidenceBindings,
        );
        for (const binding of plan.artifactBindings) {
          const exact = await artifactStore.readVersion({
            enterpriseId,
            businessProjectId,
            artifactId: binding.artifactId,
            version: binding.version,
          });
          if (exact.sha256 !== binding.sha256
            || exact.sourceOrganizationId !== binding.sourceOrganizationId) {
            throw new Error(`pinned artifact identity or hash mismatch: ${binding.artifactId}@${binding.version}`);
          }
        }
        if (existing) {
          if (existing.enterpriseId !== enterpriseId
            || existing.businessProjectId !== businessProjectId
            || existing.taskId !== taskId
            || existing.objective !== plan.objective
            || JSON.stringify(existing.artifactBindings) !== JSON.stringify(plan.artifactBindings)
            || JSON.stringify(existing.evidenceBindings ?? []) !== JSON.stringify(plan.evidenceBindings)) {
            throw new Error('strategy planning task identity conflict');
          }
          return deepFreeze({
            taskRoot: task.taskRoot,
            plan: await readJson(task.planFile, 'strategy planning execution plan'),
            state: existing,
          });
        }
        const state = {
          schemaVersion: 1,
          capabilityId: 'strategy-planning',
          enterpriseId,
          businessProjectId,
          taskId,
          objective: plan.objective,
          status: 'planned',
          revision: 1,
          planVersion: plan.planVersion,
          candidateVersion: 0,
          debugAttempt: 0,
          artifactBindings: plan.artifactBindings,
          evidenceBindings: plan.evidenceBindings,
          checkpoint: {
            completedStageIds: [],
            nextStageId: plan.stages[0].id,
            reason: '',
            unresolvedItems: [],
            failureCounts: {},
          },
          failureCounts: {},
          lastDebugReport: '',
          publicationRequest: '',
          publishedArtifact: null,
          pausedAt: '',
          lastFreshnessReview: null,
          createdAt,
          updatedAt: createdAt,
        };
        await Promise.all([
          mkdir(task.candidatesRoot, { recursive: true }),
          mkdir(task.debugRoot, { recursive: true }),
          mkdir(task.publicationRoot, { recursive: true }),
          mkdir(task.evidenceRoot, { recursive: true }),
          mkdir(task.draftsRoot, { recursive: true }),
          mkdir(task.plansRoot, { recursive: true }),
        ]);
        await writeJsonImmutable(
          path.join(task.plansRoot, 'execution-plan-v1.json'),
          plan,
          'execution plan version',
        );
        await writeJsonAtomic(task.planFile, plan);
        await writeJsonAtomic(task.stateFile, state);
        return deepFreeze({ taskRoot: task.taskRoot, plan, state });
      });
    },

    readState,

    async pauseTask({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision,
      reason,
      checkpoint,
    } = {}) {
      return exclusive(keyOf(enterpriseId, businessProjectId, taskId), async () => {
        await readProject(paths, enterpriseId, businessProjectId);
        const task = taskPaths(enterpriseId, businessProjectId, taskId);
        const current = await readJson(task.stateFile, 'strategy planning runtime state');
        assertRevision(current, expectedRevision);
        assertTaskMutable(current);
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('pause reason is required');
        const next = {
          ...current,
          status: 'paused',
          revision: current.revision + 1,
          checkpoint: validateCheckpoint(
            checkpoint,
            reason.trim(),
            current.failureCounts ?? {},
          ),
          pausedAt: isoNow(now),
          updatedAt: isoNow(now),
        };
        await writeJsonAtomic(task.stateFile, next);
        return deepFreeze(next);
      });
    },

    async resumeTask({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision,
      freshnessReview,
    } = {}) {
      return exclusive(keyOf(enterpriseId, businessProjectId, taskId), async () => {
        await readProject(paths, enterpriseId, businessProjectId);
        const task = taskPaths(enterpriseId, businessProjectId, taskId);
        const current = await readJson(task.stateFile, 'strategy planning runtime state');
        assertRevision(current, expectedRevision);
        if (!['paused', 'waiting_input'].includes(current.status)) {
          throw new Error(`strategy planning task cannot resume from ${current.status}`);
        }
        const stale = isFreshnessReviewRequired(current.pausedAt, now);
        const checkedFreshnessReview = stale
          ? validateFreshnessReview(freshnessReview, current.pausedAt, now)
          : freshnessReview
            ? validateFreshnessReview(freshnessReview, current.pausedAt, now)
            : current.lastFreshnessReview;
        const manifests = await artifactStore.listPublished({ enterpriseId, businessProjectId });
        const byArtifact = new Map(manifests.map((item) => [item.artifactId, item]));
        const notices = [];
        for (const binding of current.artifactBindings) {
          const exact = await artifactStore.readVersion({
            enterpriseId,
            businessProjectId,
            artifactId: binding.artifactId,
            version: binding.version,
          });
          if (exact.sha256 !== binding.sha256) {
            throw new Error(`pinned artifact hash mismatch: ${binding.artifactId}@${binding.version}`);
          }
          const availableVersion = byArtifact.get(binding.artifactId)?.currentVersion ?? binding.version;
          if (availableVersion > binding.version) {
            notices.push({
              artifactId: binding.artifactId,
              boundVersion: binding.version,
              availableVersion,
              action: 'keep-bound-version-until-explicit-replan',
            });
          }
        }
        const next = {
          ...current,
          status: 'analyzing',
          revision: current.revision + 1,
          checkpoint: {
            ...current.checkpoint,
            reason: '',
          },
          pausedAt: '',
          lastFreshnessReview: checkedFreshnessReview,
          updatedAt: isoNow(now),
        };
        await writeJsonAtomic(task.stateFile, next);
        return deepFreeze({
          state: next,
          newVersionNotices: notices.sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
        });
      });
    },

    async recordDebugReport({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision,
      candidateVersion,
      candidatePath,
      rootCauseId,
      validationContext,
      debugResult,
    } = {}) {
      return exclusive(keyOf(enterpriseId, businessProjectId, taskId), async () => {
        await readProject(paths, enterpriseId, businessProjectId);
        const task = taskPaths(enterpriseId, businessProjectId, taskId);
        const current = await readJson(task.stateFile, 'strategy planning runtime state');
        assertRevision(current, expectedRevision);
        assertTaskMutable(current);
        if (!Number.isInteger(candidateVersion) || candidateVersion < 1) {
          throw new Error('candidateVersion must be positive');
        }
        if (typeof rootCauseId !== 'string' || !rootCauseId.trim()) {
          throw new Error('rootCauseId is required');
        }
        validateDebugResult(debugResult);
        let candidateSha256 = '';
        if (debugResult.ok === true) {
          await requireRegularFileInside(candidatePath, task.candidatesRoot, 'candidate');
          const candidate = await readJson(candidatePath, 'strategy planning candidate');
          if (candidate.enterpriseId !== enterpriseId
            || candidate.taskId !== taskId
            || candidate.version !== candidateVersion) {
            throw new Error('debugged candidate identity mismatch');
          }
          if (!validationContext
            || typeof validationContext !== 'object'
            || Array.isArray(validationContext)) {
            throw new Error('independent validation context is required for a passing candidate');
          }
          const pinnedUpstream = current.artifactBindings.find(
            (item) => item.artifactId === 'enterprise-analysis',
          );
          const independent = debugStrategyPlanningCandidate({
            candidate,
            task: validationContext.task,
            enterpriseProfile: validationContext.enterpriseProfile,
            knowledgeContext: validationContext.knowledgeContext,
            pinnedUpstream,
            attempt: debugResult.attempt,
            maxAttempts: debugResult.maxAttempts ?? 3,
          });
          if (!independent.ok) {
            throw new Error(
              `candidate failed independent validation: ${independent.failures
                .map((item) => item.code)
                .join(',')}`,
            );
          }
          candidateSha256 = await sha256File(candidatePath);
        }
        const rootCauseHash = createHash('sha256').update(rootCauseId.trim()).digest('hex');
        const attempt = debugResult.attempt;
        const expectedAttempt = (current.failureCounts?.[rootCauseHash] ?? 0) + 1;
        if (attempt !== expectedAttempt) {
          throw new Error(`debug attempt must be ${expectedAttempt} for the same root cause`);
        }
        const effectiveDecision = debugResult.ok === true
          ? 'pass'
          : attempt >= 3
            ? 'stop'
            : debugResult.decision;
        const reportPath = path.join(
          task.debugRoot,
          `candidate-v${candidateVersion}`,
          rootCauseHash,
          `attempt-${attempt}.json`,
        );
        const report = {
          schemaVersion: 1,
          enterpriseId,
          businessProjectId,
          taskId,
          capabilityId: 'strategy-planning',
          candidateVersion,
          attempt,
          rootCauseId: rootCauseHash,
          decision: effectiveDecision,
          candidateSha256,
          failures: debugResult.failures,
          recordedAt: isoNow(now),
        };
        await writeJsonImmutable(reportPath, report, 'debug report');
        const next = {
          ...current,
          status: debugStatus(effectiveDecision),
          revision: current.revision + 1,
          candidateVersion: Math.max(current.candidateVersion, candidateVersion),
          debugAttempt: attempt,
          failureCounts: debugResult.ok === true
            ? { ...(current.failureCounts ?? {}) }
            : {
              ...(current.failureCounts ?? {}),
              [rootCauseHash]: attempt,
            },
          lastDebugReport: relativeToTask(task.taskRoot, reportPath),
          updatedAt: isoNow(now),
        };
        await writeJsonAtomic(task.stateFile, next);
        return deepFreeze({ reportPath, report, state: next });
      });
    },

    async preparePublicationRequest({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision,
      candidatePath,
      candidateVersion,
      approval,
      debugResult,
    } = {}) {
      return exclusive(keyOf(enterpriseId, businessProjectId, taskId), async () => {
        await readProject(paths, enterpriseId, businessProjectId);
        const task = taskPaths(enterpriseId, businessProjectId, taskId);
        const current = await readJson(task.stateFile, 'strategy planning runtime state');
        assertRevision(current, expectedRevision);
        assertTaskMutable(current);
        if (current.status !== 'waiting_review'
          || current.candidateVersion !== candidateVersion
          || !current.lastDebugReport) {
          throw new Error('current candidate must have a bound passing debug report and waiting_review status');
        }
        if (approval?.decision !== 'approve'
          || typeof approval.decidedBy !== 'string'
          || !approval.decidedBy.trim()
          || Number.isNaN(Date.parse(approval.decidedAt))) {
          throw new Error('valid enterprise owner approval is required');
        }
        if (!Number.isInteger(candidateVersion) || candidateVersion < 1) {
          throw new Error('candidateVersion must be positive');
        }
        const candidateRoot = task.candidatesRoot;
        await requireRegularFileInside(candidatePath, candidateRoot, 'candidate');
        const candidate = await readJson(candidatePath, 'strategy planning candidate');
        if (candidate.enterpriseId !== enterpriseId
          || candidate.taskId !== taskId
          || candidate.version !== candidateVersion) {
          throw new Error('candidate identity mismatch');
        }
        const candidateSha256 = await sha256File(candidatePath);
        const debugReportPath = path.join(task.taskRoot, ...current.lastDebugReport.split('/'));
        assertInside(task.taskRoot, debugReportPath, 'debug report');
        const debugReport = await readJson(debugReportPath, 'strategy planning debug report');
        if (debugReport.enterpriseId !== enterpriseId
          || debugReport.businessProjectId !== businessProjectId
          || debugReport.taskId !== taskId
          || debugReport.candidateVersion !== candidateVersion
          || debugReport.decision !== 'pass'
          || debugReport.candidateSha256 !== candidateSha256) {
          throw new Error('passing debug report does not match current candidate');
        }
        const requestPath = path.join(
          task.publicationRoot,
          `strategy-planning-v${candidateVersion}.json`,
        );
        const request = {
          schemaVersion: 1,
          enterpriseId,
          businessProjectId,
          taskId,
          artifactId: 'strategy-planning',
          artifactType: 'strategy-planning-candidate',
          sourceOrganizationId: 'ai-helmsman',
          version: candidateVersion,
          candidatePath: relativeToTask(task.taskRoot, candidatePath),
          candidateSha256,
          dependencies: current.artifactBindings.map(({ artifactId, version, sha256 }) => ({
            artifactId,
            version,
            sha256,
          })),
          evidenceBindings: current.evidenceBindings ?? [],
          debugReport: current.lastDebugReport,
          approval: {
            decision: 'approve',
            decidedBy: approval.decidedBy.trim(),
            decidedAt: approval.decidedAt,
          },
          status: 'awaiting_control_center_publication',
          requestedAt: isoNow(now),
        };
        await writeJsonImmutable(requestPath, request, 'publication request');
        const next = {
          ...current,
          status: 'ready_for_publication',
          revision: current.revision + 1,
          candidateVersion,
          publicationRequest: relativeToTask(task.taskRoot, requestPath),
          updatedAt: isoNow(now),
        };
        await writeJsonAtomic(task.stateFile, next);
        return deepFreeze({ ...request, requestPath, state: next });
      });
    },

    async markPublished({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision,
      publishedArtifact,
    } = {}) {
      return exclusive(keyOf(enterpriseId, businessProjectId, taskId), async () => {
        await readProject(paths, enterpriseId, businessProjectId);
        const task = taskPaths(enterpriseId, businessProjectId, taskId);
        const current = await readJson(task.stateFile, 'strategy planning runtime state');
        assertRevision(current, expectedRevision);
        if (current.status !== 'ready_for_publication' || !current.publicationRequest) {
          throw new Error('strategy planning task is not ready for publication');
        }
        if (publishedArtifact?.artifactId !== 'strategy-planning'
          || !Number.isInteger(publishedArtifact.version)
          || !/^[a-f0-9]{64}$/u.test(publishedArtifact.sha256 ?? '')) {
          throw new Error('published artifact reference is invalid');
        }
        const request = await readJson(
          path.join(task.taskRoot, ...current.publicationRequest.split('/')),
          'strategy planning publication request',
        );
        if (request.version !== publishedArtifact.version
          || request.candidateSha256 !== publishedArtifact.sha256) {
          throw new Error('published artifact does not match publication request');
        }
        const exact = await artifactStore.readVersion({
          enterpriseId,
          businessProjectId,
          artifactId: publishedArtifact.artifactId,
          version: publishedArtifact.version,
        });
        if (exact.sha256 !== publishedArtifact.sha256
          || exact.sourceOrganizationId !== 'ai-helmsman'
          || exact.sourceTaskId !== taskId) {
          throw new Error('published artifact identity or hash mismatch');
        }
        const next = {
          ...current,
          status: 'published',
          revision: current.revision + 1,
          publishedArtifact: {
            artifactId: 'strategy-planning',
            version: exact.version,
            sha256: exact.sha256,
            publishedAt: exact.publishedAt,
          },
          updatedAt: isoNow(now),
        };
        await writeJsonAtomic(task.stateFile, next);
        return deepFreeze(next);
      });
    },

    async replanTask({
      enterpriseId,
      businessProjectId,
      taskId,
      expectedRevision,
      reason,
      artifactBindings,
      evidenceBindings,
    } = {}) {
      return exclusive(keyOf(enterpriseId, businessProjectId, taskId), async () => {
        await readProject(paths, enterpriseId, businessProjectId);
        const task = taskPaths(enterpriseId, businessProjectId, taskId);
        const current = await readJson(task.stateFile, 'strategy planning runtime state');
        assertRevision(current, expectedRevision);
        if (['failed', 'cancelled'].includes(current.status)) {
          throw new Error(`terminal strategy planning task cannot be replanned: ${current.status}`);
        }
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('replan reason is required');
        const planVersion = current.planVersion + 1;
        const plan = buildStrategyPlanningPlan({
          enterpriseId,
          businessProjectId,
          taskId,
          objective: current.objective,
          planVersion,
          artifactBindings,
          evidenceBindings: evidenceBindings ?? current.evidenceBindings ?? [],
          createdAt: isoNow(now),
        });
        await verifyEvidenceBindings(
          paths.projectRoot(enterpriseId, businessProjectId),
          plan.evidenceBindings,
        );
        for (const binding of plan.artifactBindings) {
          const exact = await artifactStore.readVersion({
            enterpriseId,
            businessProjectId,
            artifactId: binding.artifactId,
            version: binding.version,
          });
          if (exact.sha256 !== binding.sha256) {
            throw new Error(`replan artifact hash mismatch: ${binding.artifactId}@${binding.version}`);
          }
        }
        const planPath = path.join(task.plansRoot, `execution-plan-v${planVersion}.json`);
        await writeJsonImmutable(planPath, plan, 'execution plan version');
        await writeJsonAtomic(task.planFile, plan);
        const next = {
          ...current,
          status: 'analyzing',
          revision: current.revision + 1,
          planVersion,
          candidateVersion: Math.max(1, current.candidateVersion + 1),
          debugAttempt: 0,
          artifactBindings: plan.artifactBindings,
          evidenceBindings: plan.evidenceBindings,
          checkpoint: {
            completedStageIds: [],
            nextStageId: plan.stages[0].id,
            reason: reason.trim(),
            unresolvedItems: [],
            failureCounts: { ...(current.failureCounts ?? {}) },
          },
          publicationRequest: '',
          updatedAt: isoNow(now),
        };
        await writeJsonAtomic(task.stateFile, next);
        return deepFreeze({ planPath, plan, state: next });
      });
    },
  });
}

async function readProject(paths, enterpriseId, businessProjectId) {
  const project = await readJson(
    paths.projectFile(enterpriseId, businessProjectId),
    'business project',
  );
  if (project.enterpriseId !== enterpriseId || project.businessProjectId !== businessProjectId) {
    throw new Error('business project identity mismatch');
  }
  if (!RESUMABLE_PROJECT_STATUSES.has(project.status)) {
    throw new Error(`business project is ${project.status} and cannot be resumed`);
  }
  return project;
}

function validateCheckpoint(value, reason, failureCounts) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('checkpoint must be an object');
  }
  if (!Array.isArray(value.completedStageIds)
    || typeof value.nextStageId !== 'string'
    || !value.nextStageId.trim()) {
    throw new Error('checkpoint stages are incomplete');
  }
  return {
    completedStageIds: [...new Set(value.completedStageIds.map((item) => String(item)))],
    nextStageId: value.nextStageId.trim(),
    reason,
    unresolvedItems: Array.isArray(value.unresolvedItems)
      ? [...new Set(value.unresolvedItems.map((item) => String(item).trim()).filter(Boolean))]
      : [],
    failureCounts: { ...failureCounts },
  };
}

function validateDebugResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('debugResult must be an object');
  }
  if (!Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 3) {
    throw new Error('debugResult attempt must be between 1 and 3');
  }
  if (!['pass', 'revise', 'waiting_input', 'stop'].includes(value.decision)) {
    throw new Error('debugResult decision is invalid');
  }
  if (!Array.isArray(value.failures)) throw new Error('debugResult failures must be an array');
  const passing = value.ok === true && value.decision === 'pass' && value.failures.length === 0;
  const failing = value.ok === false && value.decision !== 'pass' && value.failures.length > 0;
  if (!passing && !failing) {
    throw new Error('debugResult ok, decision and failures must be consistent');
  }
}

function isFreshnessReviewRequired(pausedAt, now) {
  if (typeof pausedAt !== 'string' || Number.isNaN(Date.parse(pausedAt))) return false;
  const current = now();
  const currentDate = current instanceof Date ? current : new Date(current);
  if (Number.isNaN(currentDate.getTime())) throw new TypeError('now must return a valid date');
  return currentDate.getTime() - Date.parse(pausedAt) >= 30 * 24 * 60 * 60 * 1000;
}

function validateFreshnessReview(value, pausedAt, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evidence freshness review is required after a long pause');
  }
  const reviewedAt = Date.parse(value.reviewedAt);
  const current = now();
  const currentDate = current instanceof Date ? current : new Date(current);
  if (Number.isNaN(reviewedAt)
    || reviewedAt < Date.parse(pausedAt)
    || reviewedAt > currentDate.getTime()) {
    throw new Error('evidence freshness review time is invalid');
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) {
    throw new Error('evidence freshness review requires evidenceRefs');
  }
  if (typeof value.outcome !== 'string' || !value.outcome.trim()) {
    throw new Error('evidence freshness review outcome is required');
  }
  return {
    reviewedAt: new Date(reviewedAt).toISOString(),
    evidenceRefs: [...new Set(value.evidenceRefs.map((item) => String(item).trim()).filter(Boolean))],
    outcome: value.outcome.trim(),
  };
}

function debugStatus(decision) {
  if (decision === 'pass') return 'waiting_review';
  if (decision === 'waiting_input') return 'waiting_input';
  if (decision === 'stop') return 'failed';
  return 'debugging';
}

function assertTaskMutable(state) {
  if (TERMINAL_TASK_STATUSES.has(state.status)) {
    throw new Error(`terminal strategy planning task cannot change: ${state.status}`);
  }
}

function assertRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || state.revision !== expectedRevision) {
    throw new Error('strategy planning runtime revision conflict');
  }
}

async function requireRegularFileInside(filePath, root, label) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute`);
  }
  assertInside(root, filePath, label);
  const direct = await lstat(filePath);
  if (!direct.isFile() || direct.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}

async function verifyEvidenceBindings(projectDirectory, bindings) {
  for (const binding of bindings) {
    const evidencePath = path.resolve(
      projectDirectory,
      ...binding.sourceRef.split('/'),
    );
    await requireRegularFileInside(evidencePath, projectDirectory, 'evidence binding');
    const actual = await sha256File(evidencePath);
    if (actual !== binding.sha256) {
      throw new Error(`evidence binding hash mismatch: ${binding.evidenceId}@${binding.revision}`);
    }
  }
}

function assertInside(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes its allowed root`);
  }
}

function requireTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    throw new Error('taskId is invalid or unsafe');
  }
}

function relativeToTask(taskRoot, filePath) {
  assertInside(taskRoot, filePath, 'task artifact');
  return path.relative(taskRoot, filePath).split(path.sep).join('/');
}

async function readJson(filePath, label) {
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} JSON is invalid: ${error.message}`, { cause: error });
  }
}

async function readOptionalJson(filePath) {
  return readJson(filePath, 'optional JSON').catch((error) =>
    error?.code === 'ENOENT' ? null : Promise.reject(error));
}

async function writeJsonImmutable(filePath, value, label) {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${label} already exists and is immutable`);
    throw error;
  }
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date');
  return date.toISOString();
}

function keyOf(enterpriseId, businessProjectId, taskId) {
  return `${enterpriseId || ''}|${businessProjectId || ''}|${taskId || ''}`;
}
