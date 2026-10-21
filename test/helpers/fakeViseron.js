// -----------------------------------------------------------------------------
// A simulated Viseron behind the `fetch` and `WebSocket` seams, built on
// answers recorded from a real Viseron 3.7.0 (test/fixtures/viseron): the
// camera list, the entities, a snapshot, the login.
//
// Authentication behaves like 3.7.0: the login answers the JWT header and
// payload and sets the cookies; the REST API wants `Bearer <header>.<payload>`
// with the cookies, a POST the `_xsrf` double submit too; the snapshot wants
// the camera's own token; the WebSocket wants the cookies on the upgrade and
// the header and payload in its auth message.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const fixture = (name) => new URL(`../fixtures/viseron/${name}`, import.meta.url);
const read = (name) => JSON.parse(readFileSync(fixture(name), 'utf8'));

export const FRAME = readFileSync(fixture('frame.jpg'));

function json(body, status = 200, cookies = []) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const error = (status, text) => json({ status, error: text }, status);

function cookiesOf(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) {
      cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
  }
  return cookies;
}

export class FakeViseron {
  /**
   * @param {object} [options]
   * @param {string} [options.auth] `user:password` when authentication is on
   */
  constructor({ auth } = {}) {
    this.cameras = read('cameras.json');
    this.entities = read('entities.json');
    this.auth = auth ?? null;
    this.down = false;
    this.socketDown = false;
    this.requests = [];
    this.sockets = new Set();
    this.session = 0;
    this.tokens = new Set();
    this.frame = FRAME;
    this.fetch = this.fetch.bind(this);
    const server = this;
    this.WebSocket = class extends FakeSocket {
      constructor(url, init) {
        super(server, url, init);
      }
    };
  }

  count(text) {
    return this.requests.filter((line) => line.includes(text)).length;
  }

  // --- REST --------------------------------------------------------------------

  /** A new session: the header and payload of a JWT, and its cookies. */
  newSession() {
    this.session += 1;
    const token = `h${this.session}.p${this.session}`;
    this.tokens.add(token);
    return json(
      { header: `h${this.session}`, payload: `p${this.session}`, expiration: 3600 },
      200,
      [
        `signature_cookie=s${this.session}; HttpOnly; Path=/`,
        `refresh_token=r${this.session}; HttpOnly; Path=/`,
      ],
    );
  }

  /** The browser flow of Viseron: Bearer header.payload + signature cookie. */
  authorized(headers) {
    if (!this.auth) {
      return true;
    }
    const bearer = /^Bearer (h(\d+)\.p\2)$/.exec(headers.get('authorization') ?? '');
    const cookies = cookiesOf(headers.get('cookie'));
    return Boolean(
      bearer && this.tokens.has(bearer[1]) && cookies.signature_cookie === `s${bearer[2]}`,
    );
  }

  async fetch(href, init = {}) {
    const url = new URL(href);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    if (this.down) {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === '/auth/enabled') {
      return json({ enabled: Boolean(this.auth), onboarding_complete: true });
    }
    if (path === '/auth/login' && method === 'POST') {
      if (!this.auth || `${body?.username}:${body?.password}` !== this.auth) {
        return error(401, 'Invalid username or password');
      }
      return this.newSession();
    }
    if (path === '/auth/token' && method === 'POST') {
      const cookies = cookiesOf(headers.get('cookie'));
      const session = /^r(\d+)$/.exec(cookies.refresh_token ?? '');
      if (!session || cookies._xsrf !== headers.get('x-xsrftoken')) {
        return error(400, 'Invalid grant');
      }
      this.tokens.delete(`h${session[1]}.p${session[1]}`);
      return this.newSession();
    }
    let match = /^\/camera\/([A-Za-z0-9_]+)\/snapshot$/.exec(path);
    if (match) {
      const camera = this.cameras[match[1]];
      if (!camera) {
        return error(404, `Camera ${match[1]} not found`);
      }
      if (this.auth && url.searchParams.get('access_token') !== camera.access_token) {
        return error(401, 'Unauthorized');
      }
      const width = Number(url.searchParams.get('width'));
      // A narrower frame weighs less: cut short in proportion is enough here.
      const frame = width
        ? this.frame.subarray(0, Math.round((this.frame.length * width) / camera.width))
        : this.frame;
      return new Response(frame, { headers: { 'content-type': 'image/jpeg' } });
    }
    if (!this.authorized(headers)) {
      return error(401, 'Authentication required');
    }
    if (path === '/cameras') {
      return json(this.cameras);
    }
    match = /^\/camera\/([A-Za-z0-9_]+)\/manual_recording$/.exec(path);
    if (match && method === 'POST') {
      const cookies = cookiesOf(headers.get('cookie'));
      if (this.auth && cookies._xsrf !== headers.get('x-xsrftoken')) {
        return error(403, "'_xsrf' argument missing from POST");
      }
      const camera = this.cameras[match[1]];
      if (!camera) {
        return error(404, `Camera ${match[1]} not found`);
      }
      if (!camera.is_on || !camera.connected) {
        return error(400, 'Camera is off or disconnected');
      }
      camera.is_recording = body.action === 'start';
      this.setState(`binary_sensor.${match[1]}_recorder`, camera.is_recording ? 'on' : 'off');
      return json({ success: true });
    }
    return error(404, 'Not found');
  }

  // --- States ------------------------------------------------------------------

  /** Change an entity and tell the sockets that follow it. */
  setState(entityId, state, attributes) {
    const previous = this.entities[entityId] ?? null;
    const current = {
      ...(previous ?? { entity_id: entityId, attributes: {} }),
      state,
      attributes: attributes ?? previous?.attributes ?? {},
    };
    this.entities[entityId] = current;
    for (const socket of this.sockets) {
      socket.stateChanged(entityId, previous, current);
    }
  }

  /** Close every open socket, as a restart of Viseron does. */
  dropSockets() {
    for (const socket of [...this.sockets]) {
      socket.close();
    }
  }
}

/** The WebSocket of the fake: the EventTarget surface undici offers. */
class FakeSocket extends EventTarget {
  constructor(server, url, init = {}) {
    super();
    this.server = server;
    this.url = url;
    this.headers = init.headers ?? {};
    this.authed = false;
    this.subscriptions = new Map();
    this.open = true;
    queueMicrotask(() => this.start());
  }

  emit(type, props = {}) {
    const event = new Event(type);
    Object.assign(event, props);
    this.dispatchEvent(event);
  }

  reply(message) {
    if (this.open) {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify(message) }));
    }
  }

  start() {
    if (this.server.down || this.server.socketDown) {
      this.open = false;
      this.emit('error', { message: 'connect ECONNREFUSED' });
      this.emit('close');
      return;
    }
    this.server.sockets.add(this);
    this.emit('open');
    if (this.server.auth) {
      this.reply({ type: 'auth_required', message: 'Authentication required.' });
    } else {
      this.authed = true;
      this.reply({ type: 'auth_not_required', system_information: { version: '3.7.0' } });
    }
  }

  send(text) {
    const message = JSON.parse(text);
    if (!this.authed) {
      const cookies = cookiesOf(this.headers.cookie);
      const session = /^h(\d+)\.p\1$/.exec(message.access_token ?? '');
      if (
        message.type === 'auth' &&
        session &&
        this.server.tokens.has(message.access_token) &&
        cookies.signature_cookie === `s${session[1]}`
      ) {
        this.authed = true;
        this.reply({ type: 'auth_ok', system_information: { version: '3.7.0' } });
      } else {
        this.reply({ type: 'auth_failed', message: 'Authentication failed.' });
      }
      return;
    }
    const id = message.command_id;
    switch (message.type) {
      case 'ping':
        this.reply({ command_id: id, type: 'pong' });
        break;
      case 'get_entities':
        this.reply({ command_id: id, type: 'result', success: true, result: this.server.entities });
        break;
      case 'subscribe_states':
        this.subscriptions.set(id, message.entity_ids ?? null);
        this.reply({ command_id: id, type: 'result', success: true, result: null });
        break;
      case 'unsubscribe_states':
        this.subscriptions.delete(message.subscription);
        this.reply({ command_id: id, type: 'result', success: true, result: null });
        break;
      default:
        this.reply({
          command_id: id,
          type: 'result',
          success: false,
          error: { code: 'unknown_command', message: 'Unknown command.' },
        });
    }
  }

  stateChanged(entityId, previous, current) {
    for (const [id, ids] of this.subscriptions) {
      if (!ids || ids.includes(entityId)) {
        this.reply({
          command_id: id,
          type: 'subscription_result',
          result: {
            name: 'state_changed',
            data: { entity_id: entityId, previous_state: previous, current_state: current },
          },
        });
      }
    }
  }

  close() {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.server.sockets.delete(this);
    queueMicrotask(() => this.emit('close'));
  }
}
