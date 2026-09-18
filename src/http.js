import { createServer } from 'node:http';
import { ApiError } from './errors.js';

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
};

// 极简路由：不引入第三方依赖，满足 Node.js 20 后端能力的交付形态
export function createApp(engine) {
  const routes = [
    ['POST', /^\/api\/absences$/, (body) => engine.reportAbsence(body, body?.actor)],
    ['GET', /^\/api\/absences$/, () => engine.listAbsences()],
    ['POST', /^\/api\/absences\/([^/]+)\/rounds$/, (_body, m) => engine.openRound(m[1], _body?.actor)],
    ['POST', /^\/api\/absences\/([^/]+)\/cancel$/, (body, m) => engine.cancelAbsence(m[1], body?.actor)],
    ['POST', /^\/api\/absences\/([^/]+)\/reopen$/, (body, m) => engine.reopen(m[1], { reason: body?.reason }, body?.actor)],
    ['POST', /^\/api\/absences\/([^/]+)\/manual-assignment$/, (body, m) =>
      engine.manualAssign(m[1], { teacherId: body?.teacherId, reason: body?.reason }, body?.actor)],
    ['GET', /^\/api\/absences\/([^/]+)$/, (_body, m) => engine.getAbsence(m[1])],
    ['GET', /^\/api\/absences\/([^/]+)\/audit$/, (_body, m) => engine.getAudit(m[1])],
    ['POST', /^\/api\/invitations\/([^/]+)\/respond$/, (body, m) =>
      engine.respondInvitation(
        { invitationId: m[1], teacherId: body?.teacherId, action: body?.action, idempotencyKey: body?.idempotencyKey },
        body?.actor,
      )],
    ['POST', /^\/api\/invitations\/([^/]+)\/revoke$/, (body, m) => engine.revokeInvitation(m[1], body?.actor)],
    ['GET', /^\/api\/teachers\/([^/]+)\/invitations$/, (_body, m) => engine.listPendingForTeacher(m[1])],
    ['POST', /^\/api\/sweep$/, () => engine.sweep()],
  ];

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) reject(new ApiError(413, 'payload-too-large', '请求体过大'));
        else chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new ApiError(400, 'invalid-json', '请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        const result = await handler(body, match);
        return json(res, 200, { ok: true, data: result });
      }
      return json(res, 404, { ok: false, error: { code: 'not-found', message: '接口不存在' } });
    } catch (err) {
      if (err instanceof ApiError) {
        return json(res, err.status, { ok: false, error: { code: err.code, message: err.message, details: err.details ?? undefined } });
      }
      console.error('未处理错误:', err);
      return json(res, 500, { ok: false, error: { code: 'internal-error', message: '服务内部错误' } });
    }
  });
}
