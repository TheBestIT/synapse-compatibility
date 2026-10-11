// Synapse HTTP client.
// The client keeps one session on disk. It logs in only when no session is valid.
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, HOME } from './config.mjs';

export { ROOT, HOME };
export const STATE = path.join(HOME, '.synapse');
const SESSION_FILE = path.join(STATE, 'session.json');
const FAIL_FILE = path.join(STATE, 'login-failed.json');
const REGISTRY_FILE = path.join(STATE, 'registry.json');
const THREADS_FILE = path.join(STATE, 'threads.json');
// The client does not try a new login for this time after a failed login.
const LOGIN_COOLDOWN_MS = 30 * 60 * 1000;

export class SynapseError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadEnv() {
  const env = { ...process.env };
  const file = path.join(HOME, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
  return env;
}

const env = loadEnv();
export const BASE = (env.SYNAPSE_URL || '').replace(/\/+$/, '');

let cookies = new Map(Object.entries(readJson(SESSION_FILE, {}).cookies || {}));
let loginPromise = null;

function storeCookies(res) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '' || /max-age=0/i.test(line)) cookies.delete(name);
    else cookies.set(name, value);
  }
}

function headers(json) {
  const h = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  const csrf = cookies.get('synapse_csrf');
  if (csrf) h['X-CSRF-Token'] = decodeURIComponent(csrf);
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function saveSession() {
  writeJson(SESSION_FILE, { saved: new Date().toISOString(), cookies: Object.fromEntries(cookies) });
}

// Log in one time. A failed login starts a cooldown, thus the service does not rate-limit the account.
export async function login({ force = false } = {}) {
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    if (!BASE || !env.SYNAPSE_USER || !env.SYNAPSE_PASSWORD) {
      throw new SynapseError('Set SYNAPSE_URL, SYNAPSE_USER and SYNAPSE_PASSWORD in the .env file.');
    }
    const failed = readJson(FAIL_FILE, null);
    if (failed && !force && Date.now() - failed.at < LOGIN_COOLDOWN_MS) {
      const left = Math.ceil((LOGIN_COOLDOWN_MS - (Date.now() - failed.at)) / 60000);
      throw new SynapseError(
        `The last login failed (${failed.message}). The cooldown ends in ${left} min. Use "login --force" to try again.`,
        failed.status,
        'login_cooldown',
      );
    }
    cookies = new Map();
    storeCookies(await fetch(`${BASE}/login`, { redirect: 'manual' }));
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ username: env.SYNAPSE_USER, password: env.SYNAPSE_PASSWORD }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error ?? data.detail ?? `HTTP ${res.status}`;
      writeJson(FAIL_FILE, { at: Date.now(), status: res.status, message });
      throw new SynapseError(`Login failed: ${message}`, res.status, data.code ?? '');
    }
    storeCookies(res);
    saveSession();
    fs.rmSync(FAIL_FILE, { force: true });
    return true;
  })();
  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

// Send one request. The function returns the raw response when `raw` is true.
async function send(method, p, body, { raw = false, signal } = {}) {
  if (cookies.size === 0) await login();
  let relogin = false;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/${p}`, {
      method,
      headers: headers(body !== undefined || method !== 'GET'),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    storeCookies(res);
    if (res.status === 401 && !relogin) {
      relogin = true;
      await login();
      continue;
    }
    if ((res.status === 429 || res.status >= 502) && attempt < 4) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
      await sleep(Math.min(wait, 60000));
      continue;
    }
    if (raw && res.ok) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SynapseError(`${method} ${p}: ${data.error ?? data.detail ?? `HTTP ${res.status}`}`, res.status, data.code ?? '');
    }
    return data;
  }
}

export const api = {
  get: (p) => send('GET', p),
  post: (p, body = {}) => send('POST', p, body),
  patch: (p, body) => send('PATCH', p, body),
  put: (p, body) => send('PUT', p, body),
};

// ---- Registry ---------------------------------------------------------------
// The registry lists the agents that this layer made. The layer changes only these agents.

export function registry() {
  return readJson(REGISTRY_FILE, { agents: {} });
}

function saveRegistry(reg) {
  writeJson(REGISTRY_FILE, reg);
}

// Remove an agent from the registry. The function does not change the service.
export function forgetAgent(key) {
  const reg = registry();
  delete reg.agents[key];
  saveRegistry(reg);
}

export function resolveAgent(key) {
  const reg = registry();
  if (reg.agents[key]) return reg.agents[key];
  const bySlug = Object.values(reg.agents).find((a) => a.slug === key);
  if (bySlug) return bySlug;
  throw new SynapseError(`Agent "${key}" is not in the registry. Known keys: ${Object.keys(reg.agents).join(', ') || 'none'}.`);
}

// ---- Agents -----------------------------------------------------------------

export async function listModels() {
  return (await api.get('models')).models;
}

export async function listAgents() {
  const data = await api.get('agents');
  return data.agents ?? data;
}

// Create a private agent. The `published` field is always false.
export async function createAgent(key, def) {
  const body = {
    ...(def.settings ?? {}),
    kind: def.kind ?? 'agent',
    name: def.name,
    description: def.description ?? '',
    system_prompt: def.system_prompt ?? '',
    model: def.model ?? '',
    icon: def.icon ?? '',
    subcategory: def.subcategory ?? '',
    published: false,
  };
  if (body.kind === 'super') body.members = def.members;
  const made = await api.post('agents', body);
  const reg = registry();
  reg.agents[key] = { key, slug: made.slug, id: made.id, name: def.name, kind: body.kind, model: body.model };
  saveRegistry(reg);
  return reg.agents[key];
}

// Change an agent of the registry. The function never changes the `published` field.
export async function updateAgent(key, patch) {
  const agent = resolveAgent(key);
  const { published, ...safe } = patch;
  await api.patch(`agents/${agent.slug}`, safe);
  const reg = registry();
  Object.assign(reg.agents[agent.key], { name: safe.name ?? agent.name, model: safe.model ?? agent.model });
  saveRegistry(reg);
  return reg.agents[agent.key];
}

export async function getAgent(key) {
  return api.get(`agents/${resolveAgent(key).slug}`);
}

// ---- Memory and learning ----------------------------------------------------

export async function memoryPut(key, notePath, content) {
  return api.put(`agents/${resolveAgent(key).slug}/memory/file`, { path: notePath, content });
}

export async function memoryTree(key) {
  return api.get(`agents/${resolveAgent(key).slug}/memory/tree`);
}

export async function memoryGet(key, notePath) {
  return api.get(`agents/${resolveAgent(key).slug}/memory/file?path=${encodeURIComponent(notePath)}`);
}

export async function memorySearch(key, q) {
  return api.get(`agents/${resolveAgent(key).slug}/memory/search?q=${encodeURIComponent(q)}`);
}

export async function loopGet(key) {
  return api.get(`agents/${resolveAgent(key).slug}/loop`);
}

export async function loopStart(key, topic = '') {
  return api.post(`agents/${resolveAgent(key).slug}/loop/start`, { topic });
}

export async function loopPatch(key, patch) {
  return api.patch(`agents/${resolveAgent(key).slug}/loop`, patch);
}

export async function loopAction(key, action) {
  return api.post(`agents/${resolveAgent(key).slug}/loop/${action}`, {});
}

// ---- Conversations ----------------------------------------------------------

function parseEvent(block) {
  let id = '';
  let name = '';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('event: ')) name = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!name) return null;
  try {
    return { id, name, data: data ? JSON.parse(data) : {} };
  } catch {
    return null;
  }
}

// Read the event stream of a conversation until the "end" event.
async function follow(conversationId, after, deadline, onEvent) {
  let cursor = after;
  let failures = 0;
  while (Date.now() < deadline) {
    const abort = new AbortController();
    let last = Date.now();
    const watchdog = setInterval(() => Date.now() - last > 60000 && abort.abort(), 5000);
    try {
      const res = await send('GET', `conversations/${conversationId}/events?after=${encodeURIComponent(cursor)}`, undefined, {
        raw: true,
        signal: abort.signal,
      });
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        last = Date.now();
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          const event = parseEvent(buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
          if (!event) continue;
          if (event.id) cursor = event.id;
          if (event.name === 'reconnect') break;
          onEvent(event);
          if (event.name === 'end' || event.name === 'resync') return event.name;
        }
      }
      failures = 0;
    } catch (e) {
      if (e instanceof SynapseError && e.status && e.status < 500 && e.status !== 429) throw e;
      failures += 1;
      await sleep(Math.min(15000, 500 * 2 ** failures));
    } finally {
      clearInterval(watchdog);
    }
  }
  throw new SynapseError(`Conversation ${conversationId} did not complete before the timeout.`, 0, 'timeout');
}

// Maximum number of characters that the service accepts in one message, with a margin for the part labels.
const MESSAGE_LIMIT = 96000;

function splitMessage(content) {
  if (content.length <= MESSAGE_LIMIT) return [content];
  const parts = [];
  for (let i = 0; i < content.length; ) {
    let end = Math.min(content.length, i + MESSAGE_LIMIT);
    if (end < content.length) {
      const cut = content.lastIndexOf('\n', end);
      if (cut > i + MESSAGE_LIMIT / 2) end = cut;
    }
    parts.push(content.slice(i, end));
    i = end;
  }
  return parts;
}

export function threads() {
  return readJson(THREADS_FILE, {});
}

// Send one message to an agent and wait for the full answer.
// A `thread` name keeps the conversation, thus the agent keeps the context between calls.
export async function ask(key, content, { thread, web = false, mode = 'chat', timeoutMs = 30 * 60 * 1000, onToken } = {}) {
  const agent = resolveAgent(key);
  const threadKey = thread ? `${agent.key}:${thread}` : null;
  let conversationId = threadKey ? threads()[threadKey] : null;
  if (!conversationId) {
    conversationId = (await api.post(`agents/${agent.slug}/conversations`, { mode })).id;
    if (threadKey) writeJson(THREADS_FILE, { ...threads(), [threadKey]: conversationId });
  }
  const out = { agent: agent.key, conversationId, text: '', sources: [], steps: [], tools: [], error: null, parts: 1 };
  const deadline = Date.now() + timeoutMs;
  const toolNames = new Map();
  // Send one message and read its events until the end.
  const turn = async (text, collect) => {
    const sent = await api.post(`conversations/${conversationId}/messages`, { content: text, web: collect ? web : false, attachments: [] });
    const ended = await follow(conversationId, sent.after, deadline, ({ name, data }) => {
      if (!collect) return;
      if (name === 'token') {
        out.text += data.text;
        onToken?.(data.text);
      } else if (name === 'sources') out.sources = data.sources;
      else if (name === 'agent_end') out.steps.push({ name: data.name, ok: data.ok, error: data.error });
      else if (name === 'tool_start') toolNames.set(data.id, data.name);
      else if (name === 'tool_end') out.tools.push({ name: toolNames.get(data.id), ok: data.ok, summary: data.summary });
      else if (name === 'error') out.error = data.message ?? 'error';
    });
    // The stream can close before the service completes the answer. Wait for the end of the generation.
    await settle();
    return ended;
  };
  // Read the answer after the last user message from the stored conversation.
  // The service can put a message in a queue. Then "generating" is false and the answer is not there yet.
  // Thus wait until the answer is there and does not change between two reads.
  const settle = async () => {
    let reply = '';
    let stable = 0;
    while (Date.now() < deadline) {
      const stored = await api.get(`conversations/${conversationId}`);
      const messages = stored.messages ?? [];
      const lastUser = messages.findLastIndex((m) => m.role === 'user');
      const now = messages.slice(lastUser + 1).filter((m) => m.role === 'assistant' && m.content).map((m) => m.content).join('\n\n');
      stable = !stored.generating && now && now === reply ? stable + 1 : 0;
      reply = now;
      if (stable || (out.error && !stored.generating)) break;
      await sleep(4000);
    }
    return reply;
  };
  // The service accepts a limited message size. A longer message goes in parts in the same conversation.
  const parts = splitMessage(content);
  out.parts = parts.length;
  for (let n = 0; n < parts.length - 1; n++) {
    await turn(`[Part ${n + 1} of ${parts.length} of one long message. More parts follow. Do not start the task. Answer with the one word OK.]\n\n${parts[n]}`, false);
  }
  const last = parts.length > 1 ? `[Part ${parts.length} of ${parts.length}. This is the last part.]\n\n${parts.at(-1)}\n\n[End of the long message. Now do the task from part 1 with the content of all ${parts.length} parts.]` : content;
  const state = await turn(last, true);
  // The stream can close early or lose its position. The stored conversation is the source of truth.
  // Wait until the service completes the generation, then read the answer after the last user message.
  const reply = await settle();
  if (reply.length >= out.text.length) out.text = reply;
  void state;
  if (out.error && !out.text) throw new SynapseError(`Agent ${agent.key}: ${out.error}`, 0, 'agent_error');
  if (!out.text) throw new SynapseError(`Conversation ${conversationId} did not give an answer before the timeout.`, 0, 'timeout');
  return out;
}
