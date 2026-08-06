import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

const defaultFileSystem = Object.freeze({ lstat, open });

export async function readArtifactSource(sourcePath, { fileSystem = defaultFileSystem } = {}) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw new Error('artifact sourcePath must be absolute');
  }
  if (!fileSystem || typeof fileSystem.lstat !== 'function' || typeof fileSystem.open !== 'function') {
    throw new TypeError('artifact source fileSystem is invalid');
  }

  let handle;
  let result;
  let primaryError = null;
  try {
    const initialPathState = await fileSystem.lstat(sourcePath, { bigint: true });
    assertRegularSourcePath(initialPathState);
    handle = await fileSystem.open(sourcePath, 'r');
    const openedHandleState = await handle.stat({ bigint: true });
    if (!openedHandleState.isFile() || !sameStableFileState(initialPathState, openedHandleState)) {
      throw new Error('artifact source changed while reading');
    }

    const bytes = await handle.readFile();
    const finalHandleState = await handle.stat({ bigint: true });
    const finalPathState = await fileSystem.lstat(sourcePath, { bigint: true });
    assertRegularSourcePath(finalPathState);
    if (!sameStableFileState(openedHandleState, finalHandleState)
        || !sameStableFileState(finalHandleState, finalPathState)
        || BigInt(bytes.length) !== finalHandleState.size) {
      throw new Error('artifact source changed while reading');
    }
    result = {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    primaryError = error;
  }

  let closeError = null;
  if (handle) {
    try { await handle.close(); }
    catch (error) { closeError = error; }
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return result;
}

function assertRegularSourcePath(stats) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('artifact source must be a regular file');
  }
}

function sameStableFileState(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}
