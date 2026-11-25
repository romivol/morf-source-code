import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepo } from '../../src/repo/scan.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'morf-test-'));
}

test('scanRepo finds every primitive and flags unparseable files', async () => {
  const dir = tmp();
  const w = (rel, text) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  w('skills/s1/SKILL.md', 'x');
  w('skills/not-a-skill/readme.md', 'x');
  w('agents/a1.md', 'x');
  w('rules/r1.mdc', 'x');
  w('prompts/p1.md', 'x');
  w('commands/p2.md', 'x');
  w('hooks/h1.json', JSON.stringify({ hooks: { Stop: [] } }));
  w('hooks/bad.json', '{ nope');
  w('mcp/one.json', JSON.stringify({ command: 'npx' }));
  w('.mcp.json', JSON.stringify({ mcpServers: { two: { url: 'https://e' }, three: { nothing: true } } }));

  const items = await scanRepo(dir);
  const key = i => `${i.type}:${i.name}`;
  assert.deepEqual(items.map(key).sort(), [
    'agent:a1', 'hook:bad', 'hook:h1', 'mcp:one', 'mcp:three', 'mcp:two',
    'prompt:p1', 'prompt:p2', 'rule:r1', 'skill:s1',
  ]);
  assert.deepEqual(items.find(i => key(i) === 'hook:h1').payload, { Stop: [] });
  assert.match(items.find(i => key(i) === 'hook:bad').invalid, /invalid hook file/);
  assert.match(items.find(i => key(i) === 'mcp:three').invalid, /command/);
  rmSync(dir, { recursive: true, force: true });
});
