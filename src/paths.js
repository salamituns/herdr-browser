// Shared locations, so the pane (which runs with plugin env) and agent MCP
// servers (which don't) resolve the same Chrome for the same workspace.
import { homedir } from 'node:os';
import { mkdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export const PLUGIN_ID = 'devtuns.browser';

export const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'herdr', 'plugins', PLUGIN_ID);

export function workspaceId() {
  return process.env.HERDR_WORKSPACE_ID ?? 'default';
}

export function profileDir(workspace = workspaceId()) {
  return join(stateDir, 'profiles', workspace.replace(/[^\w.-]/g, '_'));
}

// GitHub-installed plugins move to a new directory on every update, so agents'
// MCP configs point at <stateDir>/current, kept aimed at the active install.
export const currentLink = join(stateDir, 'current');

export function refreshCurrentLink() {
  const root = process.env.HERDR_PLUGIN_ROOT;
  if (!root) return;
  try {
    if (readlinkSync(currentLink) === root) return;
  } catch {}
  try {
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${currentLink}.${process.pid}`;
    symlinkSync(root, tmp);
    renameSync(tmp, currentLink); // atomic swap
  } catch {}
}
