/**
 * B5: WebSocket Hub — broadcasts EventBus events to connected clients.
 * Clients subscribe to channels (e.g., 'board:<id>') and receive real-time updates.
 *
 * Usage:
 *   const hub = new WebSocketHub(eventBus);
 *   hub.handleUpgrade(server); // attach to HTTP server
 *
 * Client connects: ws://host:port/__torque_ws
 * Client sends: { type: 'subscribe', channel: 'board:abc-123' }
 * Server pushes: { type: 'event', event: 'kanban-app.card.moved', data: {...} }
 */
export class WebSocketHub {
  constructor(eventBus, { authResolver } = {}) {
    this.clients = new Map(); // ws → { channels: Set, user }
    this.channels = new Map(); // channelName → Set<ws>
    this.eventBus = eventBus;
    this.authResolver = authResolver;

    // Subscribe to all events and broadcast to relevant channels
    if (eventBus?.onAny) {
      eventBus.onAny((eventName, payload) => {
        this._broadcast(eventName, payload);
      });
    }
  }

  /** Attach to an HTTP server for WebSocket upgrade */
  async handleUpgrade(httpServer) {
    let WebSocketServer;
    try {
      const ws = await import('ws');
      WebSocketServer = ws.WebSocketServer || ws.default?.Server;
    } catch {
      console.log('[ws-hub] ws package not installed — real-time push disabled');
      return;
    }

    if (!WebSocketServer) {
      console.log('[websocket] Disabled (ws package found but WebSocketServer not available)');
      return;
    }

    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url !== '/__torque_ws') {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        this._onConnection(ws, req);
      });
    });

    this.wss = wss;
  }

  _onConnection(ws, req) {
    const clientData = { channels: new Set(), user: null };

    // Try to authenticate from query string token
    if (this.authResolver) {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) {
        try {
          clientData.user = this.authResolver({
            headers: { authorization: 'Bearer ' + token },
          });
        } catch {}
      }
    }

    this.clients.set(ws, clientData);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.channel) {
          clientData.channels.add(msg.channel);
          if (!this.channels.has(msg.channel)) {
            this.channels.set(msg.channel, new Set());
          }
          this.channels.get(msg.channel).add(ws);
        } else if (msg.type === 'unsubscribe' && msg.channel) {
          clientData.channels.delete(msg.channel);
          this.channels.get(msg.channel)?.delete(ws);
        }
      } catch {}
    });

    ws.on('close', () => {
      for (const ch of clientData.channels) {
        this.channels.get(ch)?.delete(ws);
      }
      this.clients.delete(ws);
    });

    // Send hello
    ws.send(JSON.stringify({ type: 'connected', clientCount: this.clients.size }));
  }

  _broadcast(eventName, payload) {
    // Determine channel from event payload (board_id, workspace_id, etc.)
    const channelKeys = [];
    if (payload?.board_id) channelKeys.push('board:' + payload.board_id);
    if (payload?.workspace_id) channelKeys.push('workspace:' + payload.workspace_id);
    // Also broadcast to a global channel
    channelKeys.push('*');

    const msg = JSON.stringify({ type: 'event', event: eventName, data: payload });

    for (const ch of channelKeys) {
      const subs = this.channels.get(ch);
      if (!subs) continue;
      for (const ws of subs) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  /** Get connected client count */
  get clientCount() {
    return this.clients.size;
  }
}
