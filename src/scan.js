import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { TARGETS } from './targets.js';

// Scan a cloned repo and return [{type, name, srcPath}] for all skills + agents.
// Missing top-level dirs are silently skipped (spec E6).
export async function scanRepo(repoDir) {
  const items = [];
  await Promise.all([
    scanSkills(repoDir, items),
    scanAgents(repoDir, items),
  ]);
  return items;
}

// A directory is a skill iff it contains SKILL.md (spec E6).
async function isSkillDir(dirPath) {
  try { await fs.access(join(dirPath, 'SKILL.md')); return true; }
  catch { return false; }
}

async function scanSkills(repoDir, items) {
  const skillsDir = join(repoDir, 'skills');
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    if (!await isSkillDir(skillDir)) continue;
    items.push({ type: 'skill', name: entry.name, srcPath: skillDir });
  }
}

async function scanAgents(repoDir, items) {
  const agentsDir = join(repoDir, 'agents');
  let entries;
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    items.push({ type: 'agent', name: entry.name.slice(0, -3), srcPath: join(agentsDir, entry.name) });
  }
}

// Scan the actual target install directories and return what exists on disk.
// Used by `list --all-on-disk` to discover unmanaged items.
export async function scanDisk(targetName) {
  const profile = TARGETS[targetName];
  if (!profile) return [];
  const items = [];

  // Skills: subdirs containing SKILL.md.
  const skillMapping = profile.types.skill;
  if (skillMapping && skillMapping.kind === 'dir') {
    try {
      const entries = await fs.readdir(skillMapping.base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (await isSkillDir(join(skillMapping.base, entry.name))) {
          items.push({ type: 'skill', name: entry.name, target: targetName });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // Agents: *.md files.
  const agentMapping = profile.types.agent;
  if (agentMapping && agentMapping.kind === 'file') {
    try {
      const entries = await fs.readdir(agentMapping.base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        items.push({ type: 'agent', name: entry.name.slice(0, -3), target: targetName });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return items;
}
