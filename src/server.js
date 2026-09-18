// 极简 HTTP 适配层，不引入第三方依赖；身份以 X-Teacher-Id 头区分教师/教务（演示用）。
import { createServer as createHttpServer } from 'node:http';
import { ApiError } from './engine.js';

export function createServer(engine) {
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = match(req.method, url.pathname);
      if (!route) return send(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });

      const body = await readJson(req);
      const teacherId = req.headers['x-teacher-id'] || body.teacherId || null;
      const ctx = { query: url.searchParams, body, teacherId };
      const result = await route.handler(engine, route.params, ctx);
      send(res, result?.status ?? 200, result?.body ?? result ?? { ok: true });
    } catch (err) {
      if (err instanceof ApiError) return send(res, err.status, { error: { code: err.code, message: err.message, reason: err.reason ?? null } });
      send(res, 500, { error: { code: 'INTERNAL', message: err.message } });
    }
  });
}

const routes = [
  ['GET', /^\/health$/, () => ({ ok: true })],
  ['GET', /^\/audit$/, (e) => e.auditTrail()],
  ['POST', /^\/admin\/teachers$/, (e, p, c) => e.replaceTeachers(c.body.teachers, c.body.operator), 200],
  ['POST', /^\/absences$/, (e, p, c) => e.reportAbsence(c.body, c.body.operator), 201],
  ['GET', /^\/absences$/, (e) => e.listAbsences()],
  ['GET', /^\/absences\/([^/]+)$/, (e, p) => e.getStatus(p[0])],
  ['POST', /^\/absences\/([^/]+)\/reopen$/, (e, p, c) => e.reopenAbsence(p[0], c.body, c.body.operator)],
  ['POST', /^\/absences\/([^/]+)\/cancel$/, (e, p, c) => e.cancelAbsence(p[0], c.body?.operator)],
  ['POST', /^\/absences\/([^/]+)\/manual-assign$/, (e, p, c) => e.manualAssign(p[0], c.body.teacherId, c.body.reason, c.body.operator)],
  ['GET', /^\/absences\/([^/]+)\/audit$/, (e, p) => e.auditTrail(p[0])],
  ['GET', /^\/teachers\/([^/]+)\/invitations$/, (e, p) => e.myInvitations(p[0])],
  ['POST', /^\/invitations\/([^/]+)\/respond$/, (e, p, c) =>
    e.respond(p[0], c.teacherId, c.body.action, { reason: c.body.reason })],
  ['POST', /^\/reconcile$/, (e) => e.reconcile()],
];

function match(method, pathname) {
  for (const [m, pattern, handler, status] of routes) {
    if (m !== method) continue;
    const params = pattern.exec(pathname);
    if (params) return { handler: async (...args) => ({ body: await handler(...args), status }), params: params.slice(1) };
  }
  return null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new ApiError(413, 'TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
