// -----------------------------------------------------------------------------
// The WebSocket of one Viseron server (`/websocket`): the live events.
//
// The handshake (3.7.0): the server speaks first, `auth_not_required` (no
// authentication) or `auth_required`, answered by `{ type: "auth",
// access_token: "<header>.<payload>" }` with the session cookies on the
// upgrade request; then `auth_ok` or `auth_failed`. Commands carry a
// `command_id`; their answer is a `result` with the same id (`success`,
// `result` or `error`), and a subscription's events come as
// `subscription_result` with the id of the subscribing command.
//
// The integration uses `get_entities` (every entity and its state) and
// `subscribe_states` (the `state_changed` events of the entities it reads).
// A `ping` every 30 s proves the link alive; the socket is opened again after
// a loss, sooner the first times (2 s, 4 s… up to a minute).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ViseronError } from './client.js';

const logger = createLogger({ name: 'viseron-socket' });

export const SOCKET_TIMINGS = {
  handshakeMs: 15000,
  commandMs: 15000,
  pingMs: 30000,
  retryMinMs: 2000,
  retryMaxMs: 60000,
};

export class ViseronSocket {
  /**
   * @param {object} options
   * @param {import('./client.js').ViseronClient} options.client the REST client (address, session)
   * @param {Function} [options.WebSocket] the WebSocket class (tests replace it)
   * @param {Function} options.onOpen called once authenticated, after each (re)connection
   * @param {Function} options.onState called with each `state_changed` event data
   * @param {Function} options.onClose called with the error when an open link is lost
   * @param {object} [options.timings] overrides of SOCKET_TIMINGS
   */
  constructor({ client, WebSocket = globalThis.WebSocket, onOpen, onState, onClose, timings }) {
    this.client = client;
    this.WebSocket = WebSocket;
    this.onOpen = onOpen;
    this.onState = onState;
    this.onClose = onClose;
    this.timings = { ...SOCKET_TIMINGS, ...timings };
    this.ws = null;
    this.nextId = 1;
    this.waiting = new Map();
    this.stateSubscription = null;
    this.ready = false;
    this.closed = false;
    this.failures = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.lastError = null;
  }

  // --- Connection ------------------------------------------------------------

  /** Open the link; resolves once authenticated, rejects on failure. */
  async open() {
    if (this.closed) {
      return;
    }
    const { headers, token } = await this.client.socketAuth();
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () =>
          settle(new ViseronError('The Viseron WebSocket does not answer', { kind: 'network' })),
        this.timings.handshakeMs,
      );
      let ws;
      try {
        // undici (Node's WebSocket) takes headers in its init object: the
        // session cookies when authentication is on.
        ws = new this.WebSocket(this.client.socketUrl, { headers });
      } catch (err) {
        settle(new ViseronError(`Cannot open the Viseron WebSocket: ${err.message}`));
        return;
      }
      this.ws = ws;
      ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (this.ready) {
          this.dispatch(message);
          return;
        }
        if (message?.type === 'auth_required') {
          if (!token) {
            settle(
              new ViseronError('Viseron asks for a login: enter a user name and password', {
                kind: 'auth',
              }),
            );
            ws.close();
            return;
          }
          ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        } else if (message?.type === 'auth_ok' || message?.type === 'auth_not_required') {
          this.ready = true;
          this.version = message.system_information?.version ?? null;
          settle();
        } else if (message?.type === 'auth_failed' || message?.type === 'auth_invalid') {
          settle(new ViseronError('Viseron refuses the WebSocket login', { kind: 'auth' }));
          ws.close();
        }
      });
      ws.addEventListener('error', (event) => {
        settle(
          new ViseronError(
            `The Viseron WebSocket failed (${event?.message ?? event?.error?.message ?? 'error'})`,
            { kind: 'network' },
          ),
        );
      });
      ws.addEventListener('close', () => {
        settle(new ViseronError('The Viseron WebSocket closed', { kind: 'network' }));
        this.lost(ws);
      });
    });
    this.failures = 0;
    this.lastError = null;
    this.startPing();
    await this.onOpen?.();
  }

  /** Open, and keep it open: every failure plans another try. */
  connect() {
    if (this.closed) {
      return Promise.resolve();
    }
    return this.open().catch((err) => {
      this.failures += 1;
      this.drop();
      this.lastError = err;
      this.onClose?.(err, { connected: false });
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) {
      return;
    }
    const delay = Math.min(
      this.timings.retryMinMs * 2 ** Math.max(this.failures - 1, 0),
      this.timings.retryMaxMs,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** The open link was lost: tell the hub, try again. */
  lost(ws) {
    if (ws !== this.ws) {
      return;
    }
    const wasReady = this.ready;
    this.drop();
    if (wasReady && !this.closed) {
      const err = new ViseronError('The Viseron WebSocket closed', { kind: 'network' });
      this.lastError = err;
      this.failures = 1;
      this.onClose?.(err, { connected: true });
      this.scheduleRetry();
    }
  }

  drop() {
    this.ready = false;
    this.stateSubscription = null;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const { reject, timer } of this.waiting.values()) {
      clearTimeout(timer);
      reject(new ViseronError('The Viseron WebSocket closed', { kind: 'network' }));
    }
    this.waiting.clear();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // Already closed.
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop();
  }

  startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      this.command({ type: 'ping' }).catch((err) => {
        // No pong: the link is dead even if TCP has not noticed yet.
        logger.debug(`No answer to the ping: ${err.message}`);
        if (ws === this.ws) {
          this.lost(ws);
        }
      });
    }, this.timings.pingMs);
    this.pingTimer.unref?.();
  }

  // --- Messages --------------------------------------------------------------

  dispatch(message) {
    const id = message?.command_id;
    if (message?.type === 'subscription_result') {
      if (id === this.stateSubscription && message.result?.data) {
        this.onState?.(message.result.data);
      }
      return;
    }
    const entry = this.waiting.get(id);
    if (!entry) {
      return;
    }
    this.waiting.delete(id);
    clearTimeout(entry.timer);
    if (message.type === 'pong' || message.success !== false) {
      entry.resolve(message.result);
    } else {
      entry.reject(
        new ViseronError(`Viseron: ${message.error?.message ?? 'command failed'}`, {
          kind: 'refused',
        }),
      );
    }
  }

  command(body) {
    if (!this.ready || !this.ws) {
      return Promise.reject(
        new ViseronError('The Viseron WebSocket is not open', { kind: 'network' }),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new ViseronError(`No answer to ${body.type}`, { kind: 'network' }));
      }, this.timings.commandMs);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...body, command_id: id }));
    });
  }

  /** Every entity: `{ entity_id: { state, attributes… } }`. */
  async entities() {
    const result = await this.command({ type: 'get_entities' });
    return result && typeof result === 'object' ? result : {};
  }

  /**
   * Follow the state of these entities (replaces the previous list). The
   * subscription id is the command id: set it before the answer, so no event
   * sent right after is lost.
   */
  async followStates(entityIds) {
    const previous = this.stateSubscription;
    const id = this.nextId;
    this.stateSubscription = id;
    await this.command({ type: 'subscribe_states', entity_ids: entityIds });
    if (previous !== null) {
      await this.command({ type: 'unsubscribe_states', subscription: previous }).catch((err) =>
        logger.debug(`Cannot unsubscribe: ${err.message}`),
      );
    }
  }
}
