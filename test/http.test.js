import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { FakeClock } from '../src/clock.js';
import { SubstituteEngine } from '../src/engine.js';
import { createApp } from '../src/http.js';

const DAY = '2026-09-11';

function teachers() {
  return [
    { id: 't1', name: '张老师', subjects: ['chinese'], dailyMax: 4, schedule: [] },
    { id: 't2', name: '李老师', subjects: ['chinese'], dailyMax: 4, schedule: [] },
  ];
}

test('并发重复接受只有一个胜出，唯一人选被原子确认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-http-'));
  try {
    const clock = new FakeClock(Date.parse(`${DAY}T07:30:00+08:00`));
    const store = new Store(join(dir, 'log.jsonl'));
    const engine = new SubstituteEngine({ store, clock, teachers: teachers() });
    await engine.start();
    await engine.reportAbsence({
      id: 'ABS-1', classRef: 'CLASS-7A', subject: 'chinese',
      startsAt: `${DAY}T08:00:00+08:00`, endsAt: `${DAY}T08:45:00+08:00`,
      responseSeconds: 300,
    });
    const invId = (await engine.getAbsence('ABS-1')).currentInvitation.id;

    // 两份接受同时到达（模拟网络重放/双击）
    const [r1, r2] = await Promise.allSettled([
      engine.respondInvitation({ invitationId: invId, teacherId: 't1', action: 'accept' }),
      engine.respondInvitation({ invitationId: invId, teacherId: 't1', action: 'accept' }),
    ]);
    assert.equal(r1.status, 'fulfilled');
    assert.equal(r2.status, 'fulfilled'); // 幂等重放
    assert.equal(r1.value.invitation.state, 'accepted');
    assert.equal(r2.value.invitation.state, 'accepted');

    const view = await engine.getAbsence('ABS-1');
    assert.equal(view.state, 'covered');
    assert.equal(view.assignment.teacherId, 't1');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP 端到端：报告缺岗→教师查自己的邀请→接受→教务查状态与审计', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-http-'));
  try {
    const clock = new FakeClock(Date.parse(`${DAY}T07:30:00+08:00`));
    const store = new Store(join(dir, 'log.jsonl'));
    const engine = new SubstituteEngine({ store, clock, teachers: teachers() });
    await engine.start();
    const app = createApp(engine);
    await new Promise((resolve) => app.listen(0, resolve));
    const port = app.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const report = await fetch(`${base}/api/absences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'ABS-9', classRef: 'CLASS-7A', subject: 'chinese',
          startsAt: `${DAY}T08:00:00+08:00`, endsAt: `${DAY}T08:45:00+08:00`,
          responseSeconds: 300, actor: 'duty-li',
        }),
      });
      assert.equal(report.status, 200);
      const reported = await report.json();
      assert.equal(reported.data.state, 'inviting');
      const invitationId = reported.data.currentInvitation.id;

      // 教师端只看到自己的待确认邀请
      const mineRes = await fetch(`${base}/api/teachers/t1/invitations`);
      const mine = await mineRes.json();
      assert.equal(mine.data.length, 1);
      assert.equal(mine.data[0].invitationId, invitationId);
      assert.equal((await (await fetch(`${base}/api/teachers/t2/invitations`)).json()).data.length, 0);

      // 别人不能替答
      const forged = await fetch(`${base}/api/invitations/${invitationId}/respond`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacherId: 't2', action: 'accept' }),
      });
      assert.equal(forged.status, 409);
      assert.equal((await forged.json()).error.code, 'not-invitee');

      // 本人接受
      const accept = await fetch(`${base}/api/invitations/${invitationId}/respond`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacherId: 't1', action: 'accept', idempotencyKey: 'ack-1' }),
      });
      assert.equal(accept.status, 200);
      // 同样的幂等键再发一次
      const replay = await fetch(`${base}/api/invitations/${invitationId}/respond`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacherId: 't1', action: 'accept', idempotencyKey: 'ack-1' }),
      });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).data.idempotent, true);

      // 教务端状态
      const view = await (await fetch(`${base}/api/absences/ABS-9`)).json();
      assert.equal(view.data.state, 'covered');
      assert.equal(view.data.assignment.teacherId, 't1');
      assert.equal(view.data.assignment.source, 'ranked');

      // 审计可追溯
      const audit = await (await fetch(`${base}/api/absences/ABS-9/audit`)).json();
      assert.ok(audit.data.some((e) => e.type === 'accepted'));
      assert.ok(audit.data.some((e) => e.type === 'covered'));

      // 未知接口 404、健康检查
      assert.equal((await fetch(`${base}/api/nope`)).status, 404);
      const health = await (await fetch(`${base}/health`)).json();
      assert.equal(health.ok, true);
    } finally {
      await once(app.close(), 'close');
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
