import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMcp, normalizeMcp } from '../../src/convert/mcp.js';

const stdio = { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: '${API_KEY}', MODE: 'fast' } };
const remote = { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Region': 'us' } };

test('normalizeMcp accepts an OpenCode-style command array', () => {
  const s = normalizeMcp({ type: 'local', command: ['npx', '-y', 'pkg'], environment: { A: '1' } });
  assert.deepEqual(s, { remote: false, command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } });
});

test('convertMcp(opencode) uses a command array and {env:VAR}', () => {
  assert.deepEqual(convertMcp(stdio, 'opencode').value, {
    type: 'local', command: ['npx', '-y', 'pkg'], environment: { API_KEY: '{env:API_KEY}', MODE: 'fast' }, enabled: true,
  });
  assert.equal(convertMcp(remote, 'kilo').value.headers.Authorization, 'Bearer {env:TOKEN}');
});

test('convertMcp(cursor/windsurf) use ${env:VAR}', () => {
  assert.equal(convertMcp(stdio, 'cursor').value.env.API_KEY, '${env:API_KEY}');
  assert.equal(convertMcp(stdio, 'cursor').value.type, 'stdio');
  assert.deepEqual(convertMcp(remote, 'windsurf').value,
    { url: 'https://x/mcp', transport: 'http', headers: { Authorization: 'Bearer ${env:TOKEN}', 'X-Region': 'us' } });
});

test('convertMcp(claude/copilot) keep ${VAR}', () => {
  assert.deepEqual(convertMcp(stdio, 'claude').value, stdio);
  assert.deepEqual(convertMcp(remote, 'copilot').value, { ...remote, tools: ['*'] });
});

test('convertMcp(codex) renders a TOML table', () => {
  const s = convertMcp(stdio, 'codex', { name: 'ctx' }).text;
  assert.match(s, /^\[mcp_servers\.ctx\]\ncommand = "npx"\nargs = \["-y", "pkg"\]\nenv_vars = \["API_KEY"\]\n\n\[mcp_servers\.ctx\.env\]\nMODE = "fast"\n$/);
  const r = convertMcp(remote, 'codex', { name: 'fig' }).text;
  assert.match(r, /^bearer_token_env_var = "TOKEN"$/m);
  assert.match(r, /^http_headers = \{ X-Region = "us" \}$/m);
});
