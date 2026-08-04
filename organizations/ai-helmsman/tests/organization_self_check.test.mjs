import assert from 'node:assert/strict';
import test from 'node:test';

import { runOrganizationSelfCheck } from '../scripts/organization_self_check.mjs';
import { projectRoot } from './helpers.mjs';

test('完整AI掌舵官模块通过结构化自检', async () => {
  const result = await runOrganizationSelfCheck({ projectRoot });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.files > 25);
  assert.equal(result.issues.length, 0);
});
