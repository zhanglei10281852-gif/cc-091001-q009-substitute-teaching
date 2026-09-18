import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { JsonStore } from '../src/store.js';
import { SchedulerEngine } from '../src/engine.js';
import { createServer } from '../src/server.js';

const T0 = Date.parse('2026-09-11T07:00:00+08:00');
let clock = T0;

async function start() {
  const file = join(tmpdir(), `sub-http-${Math.random().toString(36).slice(2)}.json`);
  const store = new JsonStore(file);
  await store.load();
  const engine = new SchedulerEngine(store, { now: () => clock });
  const teachers = JSON.parse(await readFile(new URL('../fixtures/teachers.sample.json', import.meta.url), 'utf8'));
  await engine.replaceTeachers(teachers);
  const server = createServer(engine);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const call = async (base, method, path, body, teacherId) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(teacherId ? { 'x-teacher-id': teacherId } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
};

test('HTTP 全链路：上报→教师查询→拒绝→顺延→接受→教务状态/审计', async () => {
  const h = await start();
  // 教师端看到自己的待确认邀请
  let r = await call(h.base, 'GET', '/teachers/T01/invitations', null, 'T01');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);

  // 教务上报缺岗
  const absence = {
    absenceId: 'ABS-HTTP-1',
    classRef: 'CLASS-7A',
    subject: 'chinese',
    startsAt: '2026-09-11T08:00:00+08:00',
    endsAt: '2026-09-11T08:45:00+08:00',
    responseSeconds: 300,
    absentTeacherId: 'T07',
  };
  r = await call(h.base, 'POST', '/absences', absence);
  assert.equal(r.status, 201);
  assert.equal(r.json.state, 'inviting');
  const inv1 = r.json.currentInvitation.invitationId;
  assert.equal(r.json.currentInvitation.teacher.id, 'T01');
  // 队列表里带跳过原因
  const skip = Object.fromEntries(r.json.queue.filter((c) => c.skipReason).map((c) => [c.teacher.id, c.skipReason]));
  assert.equal(skip.T03, 'unqualified');
  assert.equal(skip.T05, 'workload-limit');

  // T01 只能操作自己的邀请
  r = await call(h.base, 'POST', `/invitations/${inv1}/respond`, { action: 'decline' }, 'T02');
  assert.equal(r.status, 403);
  r = await call(h.base, 'POST', `/invitations/${inv1}/respond`, { action: 'decline', reason: 'ill' }, 'T01');
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'inviting');

  r = await call(h.base, 'GET', '/absences/ABS-HTTP-1');
  const inv2 = r.json.currentInvitation;
  assert.equal(inv2.teacher.id, 'T02');

  // T02 接受
  r = await call(h.base, 'POST', `/invitations/${inv2.invitationId}/respond`, { action: 'accept' }, 'T02');
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'covered');
  // 重复接受幂等
  r = await call(h.base, 'POST', `/invitations/${inv2.invitationId}/respond`, { action: 'accept' }, 'T02');
  assert.equal(r.json.idempotent, true);

  // 教师端不再出现已终态邀请
  r = await call(h.base, 'GET', '/teachers/T02/invitations', null, 'T02');
  assert.deepEqual(r.json, []);

  // 教务审计可追溯
  r = await call(h.base, 'GET', '/absences/ABS-HTTP-1/audit');
  const types = r.json.map((e) => e.type);
  for (const t of ['absence-reported', 'invitation-issued', 'invitation-declined', 'absence-covered']) {
    assert.ok(types.includes(t), `审计缺少 ${t}`);
  }

  // 人工指定必须给原因
  r = await call(h.base, 'POST', '/absences/ABS-HTTP-1/manual-assign', { teacherId: 'T04', reason: '' });
  assert.equal(r.status, 400);
  // 已接续不能重复指定
  r = await call(h.base, 'POST', '/absences/ABS-HTTP-1/manual-assign', { teacherId: 'T04', reason: 'x' });
  assert.equal(r.status, 409);

  await h.close();
});
