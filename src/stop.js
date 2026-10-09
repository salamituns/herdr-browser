// Stop a workspace's Chrome. Runs on `workspace.closed` and as the "stop" action.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { connectCDP } from './cdp.js';
import { livePort } from './chrome.js';
import { profileDir, workspaceId } from './paths.js';

function closedWorkspace() {
  try {
    const event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? '{}');
    const data = event.data ?? event;
    return data.workspace_id ?? data.workspace?.workspace_id ?? data.workspace?.id ?? null;
  } catch {
    return null;
  }
}

const workspace = closedWorkspace() ?? workspaceId();
const dir = profileDir(workspace);
const port = await livePort(dir);
if (port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = await connectCDP(webSocketDebuggerUrl);
  await browser.send('Browser.close').catch(() => {});
  console.log(`stopped Chrome for workspace ${workspace} (port ${port})`);
} else {
  console.log(`no Chrome running for workspace ${workspace}`);
}
rmSync(join(dir, 'DevToolsActivePort'), { force: true });
