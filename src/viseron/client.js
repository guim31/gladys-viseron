// -----------------------------------------------------------------------------
// HTTP client of one Viseron server (roflcoopter/viseron), its web server on
// port 8888 by default. What the integration uses:
//   GET  api/v1/cameras                          every camera: name, on, connected, recording
//   GET  api/v1/camera/<id>/snapshot?access_token=…[&width=W]   one JPEG frame
//   POST api/v1/camera/<id>/manual_recording     { action: start | stop }
//   POST api/v1/auth/login, api/v1/auth/token    when authentication is on
//   GET  api/v1/auth/enabled                     whether it is
// The live events go through the WebSocket (src/viseron/socket.js).
//
// Authentication (checked on 3.7.0, see CLAUDE.md): the integration logs in
// as the web interface does. The login answers the header and payload of a
// JWT, and cookies (`signature_cookie`, `refresh_token`…): requests send
// `Authorization: Bearer <header>.<payload>` with `X-Requested-With:
// XMLHttpRequest` and the cookies; a POST sent with the cookies also needs the
// `_xsrf` double submit (Tornado). Personal access tokens are refused by the
// WebSocket of 3.7.0, hence a user name and password rather than a token.
//
// Errors carry a `kind`: `network` (no answer), `auth` (401/403, bad login),
// `notFound` (no such camera), `refused` (Viseron said no), `http` (else).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'viseron-api' });

export const REQUEST_TIMEOUT_MS = 15000;
export const DEFAULT_PORT = 8888;
// One client id for every login: Viseron ties its refresh tokens to it.
export const CLIENT_ID = 'gladys-viseron';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// The access token is renewed this long before it expires.
const RENEW_MARGIN_MS = 60 * 1000;

export class ViseronError extends Error {
  constructor(message, { kind = 'http', status } = {}) {
    super(message);
    this.name = 'ViseronError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * The address typed by the user: `192.0.2.10`, `nvr.lan:8888`,
 * `https://viseron.example/`… Resolves to `{ origin, basePath }`, or null.
 * Without a scheme nor a port, Viseron's own port (8888) is used.
 * Credentials in the address are refused: they go in their own fields.
 */
export function parseServerUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    return null;
  }
  if (!hasScheme && !url.port) {
    url.port = String(DEFAULT_PORT);
  }
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, '') };
}

/** One camera of api/v1/cameras. */
export function normalizeCamera(id, camera) {
  return {
    id: String(camera?.identifier ?? id),
    name: String(camera?.name ?? '').trim(),
    on: camera?.is_on === true,
    connected: camera?.connected === true,
    recording: camera?.is_recording === true,
    accessToken: typeof camera?.access_token === 'string' ? camera.access_token : null,
    width: Number(camera?.width) || null,
  };
}

async function readLimited(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ViseronError(`Answer too large (${length} bytes)`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) {
    throw new ViseronError(`Answer too large (${buffer.length} bytes)`);
  }
  return buffer;
}

const isJpeg = (buffer) => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;

/** The cookies of a response, `name=value` (attributes dropped). */
function setCookies(response) {
  const lines =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  const cookies = {};
  for (const line of lines) {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    if (at > 0) {
      cookies[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
  }
  return cookies;
}

export class ViseronClient {
  /**
   * @param {object} options
   * @param {string} options.url the server address (parseServerUrl)
   * @param {string} [options.username] empty when authentication is off
   * @param {string} [options.password]
   * @param {Function} [options.fetch] fetch (tests replace it)
   */
  constructor({ url, username = '', password = '', fetch = globalThis.fetch }) {
    const server = parseServerUrl(url);
    if (!server) {
      throw new ViseronError('Invalid Viseron address', { kind: 'config' });
    }
    this.origin = server.origin;
    this.basePath = server.basePath;
    this.username = username;
    this.password = password;
    this.fetch = fetch;
    this.session = null;
    this.loggingIn = null;
    this.xsrf = randomBytes(16).toString('hex');
  }

  /** The address, for messages and logs (never with credentials). */
  get label() {
    return `${this.origin}${this.basePath}`;
  }

  /** The WebSocket address of the server. */
  get socketUrl() {
    return `${this.label.replace(/^http/, 'ws')}/websocket`;
  }

  // --- Session ---------------------------------------------------------------

  /** The cookie header of the session, with the XSRF double submit. */
  cookieHeader() {
    const cookies = { ...(this.session?.cookies ?? {}), _xsrf: this.xsrf };
    return Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /** What the WebSocket needs: its headers and the token of its auth message. */
  async socketAuth() {
    if (!this.username) {
      return { headers: {}, token: null };
    }
    await this.ensureSession();
    return {
      headers: { cookie: this.cookieHeader() },
      token: `${this.session.header}.${this.session.payload}`,
    };
  }

  applyTokens(body, cookies) {
    if (typeof body?.header !== 'string' || typeof body?.payload !== 'string') {
      throw new ViseronError('This server does not answer like Viseron (no token)');
    }
    const lifetime = Number(body.expiration) > 0 ? Number(body.expiration) * 1000 : 3600 * 1000;
    this.session = {
      header: body.header,
      payload: body.payload,
      cookies: { ...(this.session?.cookies ?? {}), ...cookies },
      renewAt: Date.now() + Math.max(lifetime - RENEW_MARGIN_MS, lifetime / 2),
    };
  }

  async login() {
    const response = await this.send('api/v1/auth/login', {
      method: 'POST',
      body: { username: this.username, password: this.password, client_id: CLIENT_ID },
      anonymous: true,
    });
    this.session = null;
    this.applyTokens(await this.parse(response, 'auth/login'), setCookies(response));
    logger.debug('Logged in to Viseron');
  }

  /** Renew the access token with the refresh token cookie; log in again if refused. */
  async renew() {
    try {
      const response = await this.send('api/v1/auth/token', {
        method: 'POST',
        body: { grant_type: 'refresh_token', client_id: CLIENT_ID },
        anonymous: true,
        withCookies: true,
      });
      this.applyTokens(await this.parse(response, 'auth/token'), setCookies(response));
      logger.debug('Viseron access token renewed');
    } catch (err) {
      if (err.kind === 'network') {
        throw err;
      }
      logger.debug(`Cannot renew the Viseron token (${err.message}): logging in again`);
      await this.login();
    }
  }

  /** A valid session (logged in, token not about to expire), one at a time. */
  async ensureSession({ force = false } = {}) {
    if (!this.username) {
      return;
    }
    if (!force && this.session && Date.now() < this.session.renewAt) {
      return;
    }
    if (!this.loggingIn) {
      const task = (this.session && !force ? this.renew() : this.login()).finally(() => {
        this.loggingIn = null;
      });
      this.loggingIn = task;
    }
    await this.loggingIn;
  }

  // --- Requests --------------------------------------------------------------

  async send(path, { method = 'GET', params = {}, body, anonymous = false, withCookies } = {}) {
    const url = new URL(`${this.label}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const headers = { 'x-requested-with': 'XMLHttpRequest' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.username && !anonymous) {
      await this.ensureSession();
      headers.authorization = `Bearer ${this.session.header}.${this.session.payload}`;
    }
    if ((this.username && !anonymous) || withCookies) {
      headers.cookie = this.cookieHeader();
      headers['x-xsrftoken'] = this.xsrf;
    }
    // The path only: never the query (camera token) nor a header.
    logger.debug(`${method} ${path}`);
    let response;
    try {
      response = await this.fetch(url.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : (err?.cause?.code ?? err?.message);
      throw new ViseronError(`${this.label} does not answer (${reason})`, { kind: 'network' });
    }
    if (response.ok) {
      return response;
    }
    let reason = '';
    try {
      const text = (await readLimited(response, 64 * 1024)).toString('utf8');
      reason = String(JSON.parse(text)?.error ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 160);
    } catch {
      // Not JSON: the status says enough.
    }
    const detail = reason ? `: ${reason}` : '';
    if (response.status === 401 || response.status === 403) {
      throw new ViseronError(`Viseron refuses the access (HTTP ${response.status}${detail})`, {
        kind: 'auth',
        status: response.status,
      });
    }
    throw new ViseronError(`Viseron answered HTTP ${response.status} to ${path}${detail}`, {
      kind: response.status === 404 ? 'notFound' : response.status === 400 ? 'refused' : 'http',
      status: response.status,
    });
  }

  /** Send, and once again with a new login when the session was refused. */
  async request(path, options = {}) {
    try {
      return await this.send(path, options);
    } catch (err) {
      if (err.kind !== 'auth' || !this.username || options.anonymous) {
        throw err;
      }
      // Session revoked or expired on the server side: log in again, once.
      await this.ensureSession({ force: true });
      return this.send(path, options);
    }
  }

  async parse(response, path) {
    const buffer = await readLimited(response, MAX_JSON_BYTES);
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new ViseronError(`Viseron answered something else than JSON to ${path}`);
    }
  }

  async json(path, options) {
    return this.parse(await this.request(path, options), path);
  }

  /** Whether the server asks for a login (api/v1/auth/enabled). */
  async authEnabled() {
    const body = await this.parse(
      await this.send('api/v1/auth/enabled', { anonymous: true }),
      'auth/enabled',
    );
    if (typeof body?.enabled !== 'boolean') {
      throw new ViseronError('This server does not answer like Viseron (no "enabled")');
    }
    return body.enabled;
  }

  /** The cameras, keyed nowhere: a list of normalizeCamera. */
  async listCameras() {
    const body = await this.json('api/v1/cameras');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ViseronError('This server does not answer like Viseron (cameras)');
    }
    return Object.entries(body)
      .map(([id, camera]) => normalizeCamera(id, camera))
      .filter((camera) => /^[A-Za-z0-9_]+$/.test(camera.id));
  }

  /**
   * One JPEG frame. The snapshot route takes the camera's own short-lived
   * token (`access_token` of the camera list), not the session.
   */
  async snapshot(camera, { width } = {}) {
    const params = {};
    if (camera.accessToken) {
      params.access_token = camera.accessToken;
    }
    if (width) {
      params.width = width;
    }
    const response = await this.send(`api/v1/camera/${encodeURIComponent(camera.id)}/snapshot`, {
      params,
      anonymous: true,
    });
    const buffer = await readLimited(response, MAX_IMAGE_BYTES);
    if (!isJpeg(buffer)) {
      throw new ViseronError(`Camera ${camera.id} sent no JPEG image`);
    }
    return buffer;
  }

  /** Start or stop a manual recording (Viseron: admin or write role). */
  async setRecording(cameraId, on) {
    await this.request(`api/v1/camera/${encodeURIComponent(cameraId)}/manual_recording`, {
      method: 'POST',
      body: { action: on ? 'start' : 'stop' },
    });
  }
}
