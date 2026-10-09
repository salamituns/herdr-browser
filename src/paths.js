// Shared locations, so the pane (which runs with plugin env) and agent MCP
// servers (which don't) resolve the same Chrome for the same workspace.
import { homedir } from 'node:os';
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
