import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validationEnvironment, redactValidationLog } from './validation-runtime.mjs';

test('acceptance environments cannot inherit user databases, credentials or Node preloads', () => {
  const inherited = {PATH:'system-tools', APPDATA:'real-user', DATABASE_URL:'private-db', PGHOST:'private-host', PAPERCLIP_HOME:'real-data', SI_MCP_CONNECTION:'real-capability', OPENAI_API_KEY:'private-key', NODE_OPTIONS:'--require private-file', NODE_PATH:'private-modules'};
  const home = path.resolve('isolated-validation');
  const env = validationEnvironment(home, {PORT:'3101'}, inherited);
  for (const key of ['DATABASE_URL','PGHOST','SI_MCP_CONNECTION','OPENAI_API_KEY','NODE_OPTIONS','NODE_PATH']) assert.equal(env[key], undefined);
  assert.equal(env.PAPERCLIP_HOME, home);
  assert.equal(env.SI_DATA_DIRECTORY, home);
  assert.equal(env.HOME, home);
  assert.equal(env.PAPERCLIP_TELEMETRY_DISABLED, '1');
  assert.equal(env.PATH, 'system-tools');
  assert.equal(env.PORT, '3101');
  assert.equal(inherited.PAPERCLIP_HOME, 'real-data');
});

test('published diagnostics redact capabilities and database credentials', () => {
  const log = redactValidationLog('Bearer example-token {"token":"private", "password":"private"} postgresql://user:private@localhost/db');
  assert.ok(!log.includes('private'));
  assert.ok(!log.includes('example-token'));
  assert.ok(log.includes('localhost/db'));
});
