import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { callSi } from './si-mcp.mjs';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('real stdio MCP advertises only safe tools and forwards to the current loopback instance', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'si-mcp-'));
  const file = path.join(dir, 'connection.json');
  const token = 'a'.repeat(64);
  const http = createServer(async (req, res) => {
    assert.equal(req.headers['x-si-mcp-token'], token);
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tool: req.url.split('/').at(-1), input: JSON.parse(body) }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('desktop/si-mcp.mjs')], env: { ...process.env, SI_MCP_CONNECTION: file } });
  const client = new Client({ name: 'si-test', version: '1' });
  try {
    await writeFile(file, JSON.stringify({ origin: `http://127.0.0.1:${http.address().port}`, token, pid: process.pid }));
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['list_workspaces', 'list_tasks', 'get_task', 'create_task', 'report_result']);
    const response = await client.callTool({ name: 'list_workspaces', arguments: {} });
    assert.deepEqual(JSON.parse(response.content[0].text), { tool: 'list_workspaces', input: {} });
    await writeFile(file, JSON.stringify({ origin: 'https://example.com', token, pid: process.pid }));
    const unavailable = await client.callTool({ name: 'list_workspaces', arguments: {} });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0].text, /尚未运行/);
    await writeFile(file, JSON.stringify({ origin: `http://127.0.0.1:${http.address().port}`, token, pid: process.pid }));
    assert.equal((await client.callTool({ name: 'list_workspaces', arguments: {} })).isError, undefined);
    await assert.rejects(callSi('approve', {}, file), /不支持/);
  } finally { await client.close(); await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('HTTP timeout aborts a hung dependency without hanging the MCP process', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'si-mcp-timeout-'));
  const file = path.join(dir, 'connection.json');
  const http = createServer(() => {});
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(file, JSON.stringify({ origin: `http://127.0.0.1:${http.address().port}`, token: 'a'.repeat(64), pid: process.pid }));
    await assert.rejects(callSi('list_workspaces', {}, file, 100), /响应超时/);
  } finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
