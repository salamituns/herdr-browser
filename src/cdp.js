// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
export async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`CDP connect failed: ${wsUrl}`));
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p?.resolve(msg.result);
    } else {
      listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
    }
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('CDP socket closed'));
    pending.clear();
    listeners.get('close')?.forEach((fn) => fn());
  };

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close() { ws.close(); },
  };
}
