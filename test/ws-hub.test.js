import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketHub } from '../kernel/ws-hub.js';

// Mock EventBus that supports onAny
function createMockEventBus() {
  const handlers = [];
  return {
    onAny(fn) { handlers.push(fn); },
    emit(name, payload) { for (const h of handlers) h(name, payload); },
  };
}

// Mock WebSocket client that records sent messages
function createMockWs() {
  return {
    sent: [],
    send(msg) { this.sent.push(JSON.parse(msg)); },
  };
}

describe('WebSocketHub - manifest-driven channel routing', () => {
  it('registerChannels is a function on the hub', () => {
    const hub = new WebSocketHub(null);
    assert.equal(typeof hub.registerChannels, 'function');
  });

  it('registers channel declarations from a bundle manifest', () => {
    const hub = new WebSocketHub(null);
    hub.registerChannels('kanban', [
      { name: 'board:{board_id}', events: ['kanban.card.*'], auth: null },
    ]);
    assert.equal(hub._channelDefs.length, 1);
    assert.equal(hub._channelDefs[0].bundle, 'kanban');
    assert.equal(hub._channelDefs[0].name, 'board:{board_id}');
    assert.deepEqual(hub._channelDefs[0].events, ['kanban.card.*']);
  });

  it('accumulates channels from multiple bundles', () => {
    const hub = new WebSocketHub(null);
    hub.registerChannels('kanban', [
      { name: 'board:{board_id}', events: ['kanban.card.*'], auth: null },
    ]);
    hub.registerChannels('crm', [
      { name: 'workspace:{workspace_id}', events: ['crm.contact.*'], auth: null },
    ]);
    assert.equal(hub._channelDefs.length, 2);
    assert.equal(hub._channelDefs[0].bundle, 'kanban');
    assert.equal(hub._channelDefs[1].bundle, 'crm');
  });

  it('routes events to matching channels via subscribed clients', () => {
    const eventBus = createMockEventBus();
    const hub = new WebSocketHub(eventBus);
    hub.registerChannels('kanban', [
      { name: 'board:{board_id}', events: ['kanban.card.moved'], auth: null },
    ]);

    // Set up a subscribed client on 'board:abc-123'
    const ws = createMockWs();
    hub.clients.set(ws, { channels: new Set(['board:abc-123']), user: null });
    hub.channels.set('board:abc-123', new Set([ws]));

    eventBus.emit('kanban.card.moved', { board_id: 'abc-123' });

    assert.ok(ws.sent.length > 0, 'client should receive the matched event');
    assert.equal(ws.sent[0].type, 'event');
    assert.equal(ws.sent[0].event, 'kanban.card.moved');
    assert.deepEqual(ws.sent[0].data, { board_id: 'abc-123' });
  });

  it('does NOT broadcast unmatched events', () => {
    const eventBus = createMockEventBus();
    const hub = new WebSocketHub(eventBus);
    hub.registerChannels('kanban', [
      { name: 'board:{board_id}', events: ['kanban.card.moved'], auth: null },
    ]);

    const ws = createMockWs();
    hub.clients.set(ws, { channels: new Set(['board:abc-123']), user: null });
    hub.channels.set('board:abc-123', new Set([ws]));

    // Fire an event NOT in the declared events list
    eventBus.emit('crm.contact.created', { board_id: 'abc-123' });

    assert.equal(ws.sent.length, 0, 'unmatched event should not be broadcast');
  });

  it('broadcasts to global * channel for matching events', () => {
    const eventBus = createMockEventBus();
    const hub = new WebSocketHub(eventBus);
    hub.registerChannels('kanban', [
      { name: '*', events: ['kanban.card.moved'], auth: null },
    ]);

    const ws = createMockWs();
    hub.clients.set(ws, { channels: new Set(['*']), user: null });
    hub.channels.set('*', new Set([ws]));

    eventBus.emit('kanban.card.moved', {});

    assert.ok(ws.sent.length > 0, 'global * channel should receive the matched event');
    assert.equal(ws.sent[0].type, 'event');
    assert.equal(ws.sent[0].event, 'kanban.card.moved');
  });

  it('matches wildcard event patterns like kanban.card.*', () => {
    const eventBus = createMockEventBus();
    const hub = new WebSocketHub(eventBus);
    hub.registerChannels('kanban', [
      { name: 'board:{board_id}', events: ['kanban.card.*'], auth: null },
    ]);

    const ws = createMockWs();
    hub.clients.set(ws, { channels: new Set(['board:abc-123']), user: null });
    hub.channels.set('board:abc-123', new Set([ws]));

    // kanban.card.created matches kanban.card.*
    eventBus.emit('kanban.card.created', { board_id: 'abc-123' });

    assert.ok(ws.sent.length > 0, 'wildcard kanban.card.* should match kanban.card.created');
    assert.equal(ws.sent[0].event, 'kanban.card.created');

    // kanban.card.moved also matches
    eventBus.emit('kanban.card.moved', { board_id: 'abc-123' });
    assert.ok(ws.sent.length >= 2, 'wildcard should match kanban.card.moved too');
  });

  it('broadcasts nothing with no channel declarations', () => {
    const eventBus = createMockEventBus();
    const hub = new WebSocketHub(eventBus);
    // No registerChannels() called

    const ws = createMockWs();
    hub.clients.set(ws, { channels: new Set(['board:abc-123']), user: null });
    hub.channels.set('board:abc-123', new Set([ws]));

    eventBus.emit('kanban.card.moved', { board_id: 'abc-123' });

    assert.equal(ws.sent.length, 0, 'nothing should be broadcast when no channel declarations exist');
  });
});
