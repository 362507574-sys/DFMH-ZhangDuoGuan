import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  sanitizeFileName,
  writeJsonAtomic,
} from '../feishu-commander/atomic_store.mjs';
import {
  deepFreeze,
  requireBusinessProjectId,
  requireEnterpriseId,
  requireSafeId,
} from './project_contract.mjs';
import { createProjectArtifactLock } from './project_artifact_lock.mjs';
import { readArtifactSource } from './project_artifact_source.mjs';
import { createProjectPaths } from './project_paths.mjs';
import { parseStrictJson } from './strict_json.mjs';

const locks = new Map();

export async function createProjectArtifactStore({ projectRoot, now = () => new Date() } = {}) {
  const paths = await createProjectPaths({ projectRoot });
  const root = path.dirname(paths.businessRoot);
  const artifactLock = await createProjectArtifactLock({ projectRoot: root });
  return Object.freeze({
    async publish(value = {}) {
      const identity = validateIdentity(value);
      if (value.status !== 'published_for_project_use') {
        throw new Error('artifact status must be published_for_project_use');
      }
      const version = requireVersion(value.version);
      const publishJsonContractView = requirePublishJsonContractView(value.publishJsonContractView);
      const source = await readArtifactSource(value.sourcePath);
      if (publishJsonContractView) validateJsonContractDocument(source.bytes, identity, version);
      const dependencies = validateDependencies(value.dependencies);
      const artifactType = requireSafeId(value.artifactType, 'artifactType');
      const sourceOrganizationId = requireSafeId(value.sourceOrganizationId, 'sourceOrganizationId');
      const sourceTaskId = requiredText(value.sourceTaskId, 'sourceTaskId', 500);
      const key = `${identity.enterpriseId}|${identity.businessProjectId}|${identity.artifactId}`;
      return exclusive(key, async () => {
        const artifactRoot = paths.artifactRoot(
          identity.enterpriseId,
          identity.businessProjectId,
          identity.artifactId,
        );
        await assertSafeDirectoryChain(root, artifactRoot);
        await mkdir(artifactRoot, { recursive: true });
        await assertSafeDirectoryChain(root, artifactRoot, { allowMissing: false });
        return artifactLock.run(identity, async () => {
          const manifestPath = path.join(artifactRoot, 'manifest.json');
          const current = await readOptionalJson(manifestPath);
          if (current) {
            assertExistingManifest(current, identity, { artifactType, sourceOrganizationId });
          }
          const safeName = sanitizeFileName(path.basename(value.sourcePath));
          const versionRoot = path.join(artifactRoot, 'versions', String(version));
          const contentPath = path.join(versionRoot, 'content', safeName);
          const artifactMetadataPath = path.join(versionRoot, 'artifact.json');
          const claimPath = path.join(versionRoot, 'claim.json');
          const contractViewAbsolutePath = path.join(artifactRoot, `v${version}.json`);
          const contractViewPath = path.relative(root, contractViewAbsolutePath).split(path.sep).join('/');
          const prior = current?.versions?.find((item) => item.version === version);
          await assertSafeDirectoryChain(root, versionRoot);
          const orphanedMetadata = prior ? null : await readOptionalJson(artifactMetadataPath);
          const metadata = {
            schemaVersion: 1,
            ...identity,
            artifactType,
            sourceOrganizationId,
            sourceTaskId,
            version,
            status: value.status,
            sha256: source.sha256,
            size: source.bytes.length,
            contentPath: path.relative(artifactRoot, contentPath).split(path.sep).join('/'),
            dependencies,
            publishedAt: prior?.publishedAt ?? orphanedMetadata?.publishedAt ?? isoNow(now),
            ...(publishJsonContractView ? { contractViewPath } : {}),
          };
          if (prior) {
            if (JSON.stringify(prior) !== JSON.stringify(metadata)) {
              throw new Error('artifact version is immutable and conflicts with stored metadata');
            }
            const verified = await materializeAndVerify(prior, artifactRoot, root);
            await ensureImmutableClaim(claimPath, stableClaim(prior), root);
            return deepFreeze(verified);
          }
          if (orphanedMetadata) {
            if (JSON.stringify(orphanedMetadata) !== JSON.stringify(metadata)) {
              throw new Error('artifact version is immutable and conflicts with stored metadata');
            }
            await materializeAndVerify(orphanedMetadata, artifactRoot, root);
            await ensureImmutableClaim(claimPath, stableClaim(orphanedMetadata), root);
          } else {
            await assertSafeDirectoryChain(root, path.dirname(contentPath));
            await assertSafeDirectoryChain(root, artifactRoot);
            await assertImmutableTargetCompatible(contentPath, source.bytes);
            if (publishJsonContractView) {
              await assertImmutableTargetCompatible(contractViewAbsolutePath, source.bytes);
            }
            await mkdir(versionRoot, { recursive: true });
            await assertSafeDirectoryChain(root, versionRoot, { allowMissing: false });
            await ensureImmutableClaim(claimPath, stableClaim(metadata), root);
            await mkdir(path.dirname(contentPath), { recursive: true });
            await assertSafeDirectoryChain(root, path.dirname(contentPath), { allowMissing: false });
            await writeImmutable(contentPath, source.bytes);
            if (publishJsonContractView) {
              await assertSafeDirectoryChain(root, artifactRoot, { allowMissing: false });
              await writeImmutable(contractViewAbsolutePath, source.bytes);
            }
            await assertSafeDirectoryChain(root, versionRoot, { allowMissing: false });
            await writeJsonAtomic(artifactMetadataPath, metadata);
          }
          const manifest = {
            schemaVersion: 1,
            ...identity,
            artifactType: metadata.artifactType,
            sourceOrganizationId: metadata.sourceOrganizationId,
            currentVersion: current?.currentVersion ?? version,
            versions: [...(current?.versions ?? []), metadata].sort((a, b) => a.version - b.version),
          };
          await assertSafeDirectoryChain(root, artifactRoot, { allowMissing: false });
          await writeJsonAtomic(manifestPath, manifest);
          return deepFreeze(await materializeAndVerify(metadata, artifactRoot, root));
        });
      });
    },

    async readVersion(value = {}) {
      const identity = validateIdentity(value);
      const version = requireVersion(value.version);
      const artifactRoot = paths.artifactRoot(
        identity.enterpriseId,
        identity.businessProjectId,
        identity.artifactId,
      );
      await assertSafeDirectoryChain(root, artifactRoot, { allowMissing: false });
      const manifest = await readJson(path.join(artifactRoot, 'manifest.json'));
      const artifactType = requireSafeId(manifest?.artifactType, 'artifact manifest artifactType');
      const sourceOrganizationId = requireSafeId(
        manifest?.sourceOrganizationId,
        'artifact manifest sourceOrganizationId',
      );
      assertExistingManifest(manifest, identity, { artifactType, sourceOrganizationId });
      const metadata = manifest.versions.find((item) => item.version === version);
      if (!metadata) throw new Error('artifact version does not exist');
      return deepFreeze(await materializeAndVerify(metadata, artifactRoot, root));
    },

    async setCurrentVersion(value = {}) {
      const identity = validateIdentity(value);
      const expected = requireVersion(value.expectedCurrentVersion);
      const next = requireVersion(value.nextVersion);
      const key = `${identity.enterpriseId}|${identity.businessProjectId}|${identity.artifactId}`;
      return exclusive(key, async () => {
        const artifactRoot = paths.artifactRoot(
          identity.enterpriseId,
          identity.businessProjectId,
          identity.artifactId,
        );
        await assertSafeDirectoryChain(root, artifactRoot, { allowMissing: false });
        return artifactLock.run(identity, async () => {
          const manifestPath = path.join(artifactRoot, 'manifest.json');
          const manifest = await readJson(manifestPath);
          assertManifestIdentity(manifest, identity);
          if (manifest.currentVersion !== expected) throw new Error('artifact current version conflict');
          if (!manifest.versions.some((item) => item.version === next)) {
            throw new Error('next artifact version does not exist');
          }
          if (expected === next) return deepFreeze(manifest);
          const updated = { ...manifest, currentVersion: next };
          await assertSafeDirectoryChain(root, artifactRoot, { allowMissing: false });
          await writeJsonAtomic(manifestPath, updated);
          return deepFreeze(updated);
        });
      });
    },

    async listPublished({ enterpriseId, businessProjectId } = {}) {
      requireEnterpriseId(enterpriseId);
      requireBusinessProjectId(businessProjectId);
      const root = paths.projectRoot(enterpriseId, businessProjectId);
      const sharedRoot = path.join(root, 'shared-artifacts');
      await assertSafeDirectoryChain(path.dirname(paths.businessRoot), sharedRoot);
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(sharedRoot, { withFileTypes: true }).catch((error) =>
        error?.code === 'ENOENT' ? [] : Promise.reject(error));
      const manifests = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        await assertSafeDirectoryChain(path.dirname(paths.businessRoot), path.join(sharedRoot, entry.name), {
          allowMissing: false,
        });
        manifests.push(await readJson(path.join(sharedRoot, entry.name, 'manifest.json')));
      }
      return deepFreeze(manifests.sort((a, b) => a.artifactId.localeCompare(b.artifactId)));
    },
  });
}

function validateIdentity(value) {
  return {
    enterpriseId: requireEnterpriseId(value.enterpriseId),
    businessProjectId: requireBusinessProjectId(value.businessProjectId),
    artifactId: requireSafeId(value.artifactId, 'artifactId'),
  };
}

function validateDependencies(value) {
  if (!Array.isArray(value)) throw new TypeError('dependencies must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`dependencies[${index}] must be an object`);
    }
    return {
      artifactId: requireSafeId(item.artifactId, `dependencies[${index}].artifactId`),
      version: requireVersion(item.version),
      sha256: requireSha256(item.sha256, `dependencies[${index}].sha256`),
    };
  });
}

function requireVersion(value) {
  if (!Number.isInteger(value) || value < 1) throw new Error('artifact version is required and must be positive');
  return value;
}

function requirePublishJsonContractView(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError('publishJsonContractView must be a boolean');
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validateJsonContractDocument(bytes, identity, version) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error('JSON contract view source must not contain a BOM');
  }
  let document;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error('JSON contract view source must contain valid UTF-8 JSON', { cause: error });
  }
  try {
    document = parseStrictJson(text, 'JSON contract view source');
  } catch (error) {
    throw new Error(`JSON contract view source must contain valid JSON: ${error.message}`, { cause: error });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('JSON contract view source must be a top-level object');
  }
  if (document.schemaVersion !== 1) throw new Error('JSON contract view schemaVersion must be 1');
  for (const field of ['artifactId', 'enterpriseId', 'businessProjectId']) {
    if (document[field] !== identity[field]) {
      throw new Error(`JSON contract view ${field} must match publication`);
    }
  }
  if (document.version !== version) throw new Error('JSON contract view version must match publication');
  if (document.status !== 'published') throw new Error('JSON contract view status must be published');
}

async function materializeAndVerify(metadata, artifactRoot, root) {
  const absolutePath = path.resolve(artifactRoot, ...metadata.contentPath.split('/'));
  const relative = path.relative(artifactRoot, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('artifact content path escapes artifact root');
  }
  await assertSafeDirectoryChain(root, path.dirname(absolutePath), { allowMissing: false });
  const direct = await lstat(absolutePath);
  if (!direct.isFile() || direct.isSymbolicLink()) throw new Error('artifact content must be a regular file');
  const bytes = await readFile(absolutePath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== metadata.sha256 || bytes.length !== metadata.size) throw new Error('artifact hash mismatch');
  if (Object.hasOwn(metadata, 'contractViewPath')) {
    const expectedAbsolutePath = path.join(artifactRoot, `v${metadata.version}.json`);
    const expectedPath = path.relative(root, expectedAbsolutePath).split(path.sep).join('/');
    if (metadata.contractViewPath !== expectedPath) {
      throw new Error('artifact contract view path mismatch');
    }
    const contractViewAbsolutePath = path.resolve(root, ...metadata.contractViewPath.split('/'));
    if (contractViewAbsolutePath !== expectedAbsolutePath) {
      throw new Error('artifact contract view path mismatch');
    }
    await assertSafeDirectoryChain(root, artifactRoot, { allowMissing: false });
    const contractViewDirect = await lstat(contractViewAbsolutePath);
    if (!contractViewDirect.isFile() || contractViewDirect.isSymbolicLink()) {
      throw new Error('artifact contract view must be a regular file');
    }
    const contractViewBytes = await readFile(contractViewAbsolutePath);
    const contractViewSha256 = createHash('sha256').update(contractViewBytes).digest('hex');
    if (contractViewSha256 !== metadata.sha256 || contractViewBytes.length !== metadata.size) {
      throw new Error('artifact contract view hash mismatch');
    }
  }
  return { ...metadata, absolutePath };
}

function assertManifestIdentity(manifest, identity) {
  for (const field of ['enterpriseId', 'businessProjectId', 'artifactId']) {
    if (manifest[field] !== identity[field]) throw new Error(`artifact ${field} mismatch`);
  }
  if (!Array.isArray(manifest.versions)) throw new Error('artifact manifest versions are invalid');
}

async function writeImmutable(filePath, bytes) {
  try {
    await writeFile(filePath, bytes, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const direct = await lstat(filePath);
    if (!direct.isFile() || direct.isSymbolicLink()) throw new Error('artifact version is immutable');
    const existing = await readFile(filePath);
    if (!existing.equals(bytes)) throw new Error('artifact version is immutable');
  }
}

async function assertImmutableTargetCompatible(filePath, bytes) {
  const direct = await lstat(filePath).catch((error) =>
    error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!direct) return;
  if (!direct.isFile() || direct.isSymbolicLink()) throw new Error('artifact version is immutable');
  const existing = await readFile(filePath);
  if (!existing.equals(bytes)) throw new Error('artifact version is immutable');
}

async function readOptionalJson(filePath) {
  return readJson(filePath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
}

async function readJson(filePath) {
  const direct = await lstat(filePath);
  if (!direct.isFile() || direct.isSymbolicLink()) throw new Error('artifact JSON must be a regular non-link file');
  const raw = await readFile(filePath, 'utf8');
  return parseStrictJson(raw, 'artifact JSON');
}

function assertExistingManifest(manifest, identity, { artifactType, sourceOrganizationId }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('artifact manifest schema is invalid');
  }
  if (manifest.schemaVersion !== 1) throw new Error('artifact manifest schemaVersion is invalid');
  for (const field of ['enterpriseId', 'businessProjectId', 'artifactId']) {
    if (manifest[field] !== identity[field]) throw new Error(`artifact manifest ${field} mismatch`);
  }
  if (manifest.artifactType !== artifactType) throw new Error('artifact manifest artifactType mismatch');
  if (manifest.sourceOrganizationId !== sourceOrganizationId) {
    throw new Error('artifact manifest sourceOrganizationId mismatch');
  }
  if (!Array.isArray(manifest.versions)) throw new Error('artifact manifest versions are invalid');
  const seen = new Set();
  for (const item of manifest.versions) {
    assertManifestVersion(item, manifest);
    if (seen.has(item.version)) throw new Error('artifact manifest contains duplicate versions');
    seen.add(item.version);
  }
  if (manifest.versions.length > 0) {
    if (!Number.isInteger(manifest.currentVersion) || !seen.has(manifest.currentVersion)) {
      throw new Error('artifact manifest currentVersion is invalid');
    }
  } else if (manifest.currentVersion !== undefined && manifest.currentVersion !== null) {
    throw new Error('artifact manifest currentVersion is invalid');
  }
}

function assertManifestVersion(item, manifest) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('artifact manifest version metadata is invalid');
  }
  if (item.schemaVersion !== 1) throw new Error('artifact manifest version schemaVersion is invalid');
  for (const field of ['enterpriseId', 'businessProjectId', 'artifactId']) {
    if (item[field] !== manifest[field]) throw new Error(`artifact manifest version ${field} mismatch`);
  }
  if (item.artifactType !== manifest.artifactType) throw new Error('artifact manifest version artifactType mismatch');
  if (item.sourceOrganizationId !== manifest.sourceOrganizationId) {
    throw new Error('artifact manifest version sourceOrganizationId mismatch');
  }
  requiredText(item.sourceTaskId, 'artifact manifest version sourceTaskId', 500);
  requireVersion(item.version);
  if (item.status !== 'published_for_project_use') throw new Error('artifact manifest version status is invalid');
  requireSha256(item.sha256, 'artifact manifest version sha256');
  if (!Number.isInteger(item.size) || item.size < 0) throw new Error('artifact manifest version size is invalid');
  if (!isSafeRelativeFilePath(item.contentPath)) throw new Error('artifact manifest version contentPath is invalid');
  validateDependencies(item.dependencies);
  if (typeof item.publishedAt !== 'string' || Number.isNaN(Date.parse(item.publishedAt))) {
    throw new Error('artifact manifest version publishedAt is invalid');
  }
  if (Object.hasOwn(item, 'contractViewPath') && !isSafeRelativeFilePath(item.contractViewPath)) {
    throw new Error('artifact manifest version contractViewPath is invalid');
  }
}

function isSafeRelativeFilePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

async function assertSafeDirectoryChain(root, target, { allowMissing = true } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('artifact path escapes its safe directory');
  }
  let current = resolvedRoot;
  const segments = relative ? relative.split(path.sep) : [];
  for (const segment of segments) {
    current = path.join(current, segment);
    const direct = await lstat(current).catch((error) =>
      error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!direct) {
      if (allowMissing) return;
      const error = new Error('artifact safe directory does not exist');
      error.code = 'ENOENT';
      throw error;
    }
    if (!direct.isDirectory() || direct.isSymbolicLink()) {
      throw new Error('artifact safe directory must not contain a link or reparse point');
    }
    const canonical = await realpath(current);
    if (!sameFilesystemPath(canonical, current) || !isPathInside(resolvedRoot, canonical)) {
      throw new Error('artifact safe directory must not contain a link or reparse point');
    }
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function requiredText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${label} exceeds size limit`);
  return result;
}

function isoNow(now) {
  const date = now();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('now must return a valid Date');
  return date.toISOString();
}

function stableClaim(metadata) {
  const { publishedAt: _publishedAt, ...claim } = metadata;
  return claim;
}

async function ensureImmutableClaim(claimPath, claim, root) {
  const directory = path.dirname(claimPath);
  await assertSafeDirectoryChain(root, directory);
  await mkdir(directory, { recursive: true });
  await assertSafeDirectoryChain(root, directory, { allowMissing: false });
  const bytes = Buffer.from(JSON.stringify(claim));
  try {
    await writeFile(claimPath, bytes, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const direct = await lstat(claimPath);
    if (!direct.isFile() || direct.isSymbolicLink()) throw new Error('artifact version claim is immutable');
    const existingBytes = await readFile(claimPath);
    let existing;
    try { existing = parseStrictJson(existingBytes.toString('utf8'), 'artifact version claim'); }
    catch (cause) { throw new Error('artifact version claim is invalid', { cause }); }
    if (JSON.stringify(existing) !== JSON.stringify(claim)) {
      throw new Error('artifact version claim is immutable and conflicts with stored metadata');
    }
  }
}

async function exclusive(key, operation) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}
