/**
 * B5: WebSocket Hub — broadcasts EventBus events to connected clients.
 * Clients subscribe to channels (e.g., 'board:<id>') and receive real-time updates.
 *
 * Channel routing is driven by bundle manifest `realtime:` declarations registered
 * via registerChannels(). Events are only broadcast to channels whose declared
 * event patterns match the fired event.
 *
 * Usage:
 *   const hub = new WebSocketHub(eventBus);
 *   hub.registerChannels('kanban', manifest.realtime.channels);
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
    this._channelDefs = []; // { bundle, name, events, auth } objects from manifests

    // Subscribe to all events and broadcast to relevant channels
    if (eventBus?.onAny) {
      eventBus.onAny((eventName, payload) => {
        this._broadcast(eventName, payload);
      });
    }
  }

  /**
   * Register channel declarations from a bundle manifest's realtime.channels array.
   * Each entry: { name, events, auth }
   * @param {string} bundleName
   * @param {Array<{name: string, events: string[], auth: string|null}>} channels
   */
  registerChannels(bundleName, channels) {
    for (const ch of channels) {
      this._channelDefs.push({ bundle: bundleName, name: ch.name, events: ch.events, auth: ch.auth });
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

  /**
   * Broadcast an event to all subscribed clients whose channel declarations match.
   * Routing is driven by registered _channelDefs from bundle manifests.
   * If no declarations are registered, nothing is broadcast.
   */
  _broadcast(eventName, payload) {
    if (this._channelDefs.length === 0) return;

    const msg = JSON.stringify({ type: 'event', event: eventName, data: payload });
    const sent = new Map(); // channelName → Set<ws> — uses object identity for ws, not string coercion

    for (const def of this._channelDefs) {
      if (!this._eventMatchesPatterns(eventName, def.events)) continue;

      const channelName = this._resolveChannelName(def.name, payload);
      const subs = this.channels.get(channelName);
      if (!subs) continue;

      if (!sent.has(channelName)) sent.set(channelName, new Set());
      const channelSent = sent.get(channelName);

      for (const ws of subs) {
        if (channelSent.has(ws)) continue; // object identity, not string coercion
        channelSent.add(ws);
        try { ws.send(msg); } catch {}
      }
    }
  }

  /**
   * Check if an event name matches any of the declared patterns.
   * Supports exact matches and wildcard patterns ending with '.*'.
   * @param {string} eventName
   * @param {string[]} patterns
   * @returns {boolean}
   */
  _eventMatchesPatterns(eventName, patterns) {
    for (const pattern of patterns) {
      if (pattern === '*') return true;
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2); // strip '.*'
        if (eventName === prefix || eventName.startsWith(prefix + '.')) return true;
      } else {
        if (eventName === pattern) return true;
      }
    }
    return false;
  }

  /**
   * Resolve a channel name template using payload fields.
   * e.g. 'board:{board_id}' + { board_id: 'abc-123' } => 'board:abc-123'
   * The global '*' channel resolves to '*' as-is.
   * @param {string} template
   * @param {object} payload
   * @returns {string}
   */
  _resolveChannelName(template, payload) {
    return template.replace(/\{(\w+)\}/g, (_, key) => payload?.[key] ?? `{${key}}`);
  }

  /** Get connected client count */
  get clientCount() {
    return this.clients.size;
  }
}
