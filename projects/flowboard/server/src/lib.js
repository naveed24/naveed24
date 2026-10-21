import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function assert(ok, status, message) { if (!ok) throw new ApiError(status, message); }
export function database(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  return db;
}
export const id = () => randomBytes(12).toString('hex');
export const now = () => new Date().toISOString();
export function passwordHash(password) {
  assert(typeof password === 'string' && password.length >= 8 && password.length <= 128, 400, 'Password must contain 8 to 128 characters');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordVerify(password, stored) {
  if (typeof password !== 'string' || !stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}
function base64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
export function signToken(user, secret) {
  const payload = base64({ sub: user.id, exp: Date.now() + 24 * 60 * 60 * 1000 });
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
export function tokenUser(req, db, secret) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  assert(token, 401, 'Authentication required');
  const [payload, signature] = token.split('.');
  assert(payload && signature, 401, 'Invalid token');
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  assert(signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected)), 401, 'Invalid token');
  let claims; try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new ApiError(401, 'Invalid token'); }
  assert(Number.isFinite(claims.exp) && claims.exp > Date.now(), 401, 'Token expired');
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id=?').get(claims.sub);
  assert(user, 401, 'Unknown account');
  return user;
}
export async function bodyJson(req) {
  let data = ''; for await (const chunk of req) { data += chunk; assert(data.length <= 100_000, 413, 'Payload too large'); }
  try { return data ? JSON.parse(data) : {}; } catch { throw new ApiError(400, 'Invalid JSON'); }
}
export function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
export function apiServer(handler) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CLIENT_ORIGIN || 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try { await handler(req, res, new URL(req.url, 'http://localhost').pathname); }
    catch (err) { json(res, err.status || 500, { error: err.status ? err.message : 'Internal server error' }); if (!err.status) console.error(err); }
  };
}
export function string(value, label, max = 120) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, 400, `${label} is required (max ${max} characters)`);
  return value.trim();
}
export function email(value) { const result = string(value, 'Email', 254).toLowerCase(); assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result), 400, 'Invalid email'); return result; }
