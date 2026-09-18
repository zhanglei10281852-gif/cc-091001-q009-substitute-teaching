import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { FakeClock } from '../src/clock.js';
import { SubstituteEngine } from '../src/engine.js';
import { ApiError } from '../src/errors.js';

const DAY = '2026-09-11';
const START = Date.parse(`${DAY}T08:00:00+08:00`);
const END = Date.parse(`${DAY}T08:45:00+08:00`);

async function makeHarness({ now = START - 30 * 60 * 1000, teachers } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sub-'));
  const file = join(dir, 'log.jsonl');
  const clock = new FakeClock(now);
  const store = new Store(file);
  const engine = new SubstituteEngine({ store, clock, teachers: teachers ?? defaultTeachers() });
  await engine.start();
  return {
    dir, file, clock, store, engine,
    async dispose() {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function defaultTeachers() {
  return [
    { id: 't1', name: '张老师', subjects: ['chinese'], dailyMax: 4, schedule: [] },
    { id: 't2', name: '李老师', subjects: ['chinese'], dailyMax: 4, schedule: [] },
    { id: 't3', name: '王老师', subjects: ['math'], dailyMax: 4, schedule: [] },
    {
      id: 't4', name: '赵老师', subjects: ['chinese'], dailyMax: 4,
      schedule: [{ classRef: 'CLASS-7B', startsAt: `${DAY}T07:55:00+08:00`, endsAt: `${DAY}T08:40:00+08:00` }],
    },
    {
      id: 't5', name: '孙老师', subjects: ['chinese'], dailyMax: 1,
      schedule: [{ classRef: 'CLASS-9C', startsAt: `${DAY}T14:00:00+08:00`, endsAt: `${DAY}T14:45:00+08:00` }],
    },
    {
      id: 't6', name: '周老师', subjects: ['chinese'], dailyMax: 4, consecutiveMax: 1,
      schedule: [{ classRef: 'CLASS-8A', startsAt: `${DAY}T07:15:00+08:00`, endsAt: `${DAY}T08:00:00+08:00` }],
    },
  ];
}

const absenceInput = (over = {}) => ({
  id: 'ABS-001',
  classRef: 'CLASS-7A',
  subject: 'chinese',
  startsAt: `${DAY}T08:00:00+08:00`,
  endsAt: `${DAY}T08:45:00+08:00`,
  responseSeconds: 300,
  ...over,
});

test.afterEach(async (t) => {
  if (t._harness) await t._harness.dispose();
});

test('报告缺岗即生成有顺序的候选队列，并发出首位邀请', async (t) => {
  const h = (t._harness = await makeHarness());
  const view = await h.engine.reportAbsence(absenceInput());
  assert.equal(view.state, 'inviting');
  assert.equal(view.round, 1);

  const byId = Object.fromEntries(view.roster.map((e) => [e.teacherId, e]));
  assert.equal(byId.t1.disposition, 'invited');
  assert.equal(byId.t1.rank, 1);
  assert.equal(byId.t2.disposition, 'queued');
  // 跳过原因对教务端可见
  assert.equal(byId.t3.disposition, 'skipped');
  assert.equal(byId.t3.reason, 'unqualified');
  assert.equal(byId.t4.reason, 'schedule-conflict');
  assert.match(byId.t4.detail.kind, /overlap/);
  assert.equal(byId.t5.reason, 'workload-limit');
  assert.equal(byId.t5.detail.projected, 2);
  assert.equal(byId.t5.detail.dailyMax, 1);
  assert.equal(byId.t6.reason, 'schedule-conflict');
  assert.equal(byId.t6.detail.kind, 'consecutive-limit');

  assert.equal(view.currentInvitation.teacherId, 't1');
  assert.equal(view.currentInvitation.remainingSeconds, 300);
});

test('拒绝后顺位晋升；接受时原子确认唯一人选，其余候选全部排除', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());

  const first = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  const declined = await h.engine.respondInvitation({ invitationId: first.id, teacherId: 't1', action: 'decline' });
  assert.equal(declined.invitation.state, 'declined');

  const view = await h.engine.getAbsence('ABS-001');
  assert.equal(view.currentInvitation.teacherId, 't2');
  assert.equal(view.roster.find((e) => e.teacherId === 't1').reason, 'declined');

  const second = view.currentInvitation.id;
  const res = await h.engine.respondInvitation({ invitationId: second, teacherId: 't2', action: 'accept' });
  assert.equal(res.invitation.state, 'accepted');
  assert.equal(res.absence.state, 'covered');
  assert.equal(res.absence.assignment.teacherId, 't2');
  assert.equal(res.absence.assignment.source, 'ranked');

  const final = await h.engine.getAbsence('ABS-001');
  assert.equal(final.currentInvitation, null);
  assert.equal(final.roster.find((e) => e.teacherId === 't2').disposition, 'assigned');
  assert.equal(final.roster.find((e) => e.teacherId === 't1').disposition, 'skipped');
});

test('非受邀教师不能应答', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  await assert.rejects(
    h.engine.respondInvitation({ invitationId: inv.id, teacherId: 't2', action: 'accept' }),
    (err) => err instanceof ApiError && err.status === 409 && err.code === 'not-invitee',
  );
});

test('邀请超时自动失效并晋升下一位；队列走完等待人工，上课时刻转 uncovered', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv1 = (await h.engine.getAbsence('ABS-001')).currentInvitation;

  await h.clock.advance(301 * 1000); // 07:35:01，首邀超时

  const stored1 = h.store.invitations.get(inv1.id);
  assert.equal(stored1.state, 'expired');
  const mid = await h.engine.getAbsence('ABS-001');
  assert.equal(mid.currentInvitation.teacherId, 't2');
  assert.ok(Date.parse(mid.currentInvitation.expiresAt) <= START);

  await h.clock.advance(301 * 1000); // t2 也超时
  const waiting = await h.engine.getAbsence('ABS-001');
  assert.equal(waiting.state, 'inviting');
  assert.equal(waiting.awaitingManual, true);
  assert.equal(waiting.currentInvitation, null);

  await h.clock.advance(25 * 60 * 1000); // 到 08:00 之后
  const final = await h.engine.getAbsence('ABS-001');
  assert.equal(final.state, 'uncovered');
  assert.ok(final.closedAt);
});

test('有效期截断到上课时刻：临上课前的占位在上课瞬间失效', async (t) => {
  const h = (t._harness = await makeHarness({ now: START - 60 * 1000 }));
  await h.engine.reportAbsence(absenceInput({ responseSeconds: 300 }));
  const view = await h.engine.getAbsence('ABS-001');
  assert.equal(view.currentInvitation.remainingSeconds, 60);
  await h.clock.advance(61 * 1000);
  const final = await h.engine.getAbsence('ABS-001');
  assert.equal(final.state, 'uncovered');
});

test('教师端只能看到自己的待确认邀请', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const mine = await h.engine.listPendingForTeacher('t1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].absenceId, 'ABS-001');
  assert.equal(mine[0].classRef, 'CLASS-7A');
  assert.equal(mine[0].subject, 'chinese');
  assert.equal(mine[0].invitationId, (await h.engine.getAbsence('ABS-001')).currentInvitation.id);

  const others = await h.engine.listPendingForTeacher('t2');
  assert.equal(others.length, 0);
});

test('重复回执不改写最终结果：接受后再接受幂等重放，再拒绝被驳回', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv = (await h.engine.getAbsence('ABS-001')).currentInvitation;

  const first = await h.engine.respondInvitation({ invitationId: inv.id, teacherId: 't1', action: 'accept' });
  assert.equal(first.idempotent, false);
  const replay = await h.engine.respondInvitation({ invitationId: inv.id, teacherId: 't1', action: 'accept' });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.invitation.state, 'accepted');

  await assert.rejects(
    h.engine.respondInvitation({ invitationId: inv.id, teacherId: 't1', action: 'decline' }),
    (err) => err.code === 'already-decided',
  );
  const still = await h.engine.getAbsence('ABS-001');
  assert.equal(still.state, 'covered');
  assert.equal(still.assignment.teacherId, 't1');
});

test('幂等键重复提交只生效一次', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  const args = { invitationId: inv.id, teacherId: 't1', action: 'decline', idempotencyKey: 'K-1' };
  await h.engine.respondInvitation(args);
  const again = await h.engine.respondInvitation(args);
  assert.equal(again.idempotent, true);
  // 没有重复晋升：t2 仍是当前邀请
  const view = await h.engine.getAbsence('ABS-001');
  assert.equal(view.currentInvitation.teacherId, 't2');
});

test('超时后再接受被拒绝且不改写结果', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv1 = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  await h.clock.advance(301 * 1000);
  await assert.rejects(
    h.engine.respondInvitation({ invitationId: inv1.id, teacherId: 't1', action: 'accept' }),
    (err) => err.code === 'already-decided' && err.details.state === 'expired',
  );
  // t2 的邀请仍然有效，未被影响
  const view = await h.engine.getAbsence('ABS-001');
  assert.equal(view.currentInvitation.teacherId, 't2');
});

test('人工指定必须填写原因，且仍要通过冲突校验', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());

  await assert.rejects(
    h.engine.manualAssign('ABS-001', { teacherId: 't2' }),
    (err) => err.status === 400,
  );
  // 学科不符不能人工指定
  await assert.rejects(
    h.engine.manualAssign('ABS-001', { teacherId: 't3', reason: '骨干优先' }),
    (err) => err.code === 'manual-conflict' && err.details.reason === 'unqualified',
  );
  // 时间冲突不能人工指定
  await assert.rejects(
    h.engine.manualAssign('ABS-001', { teacherId: 't4', reason: '骨干优先' }),
    (err) => err.code === 'manual-conflict',
  );

  const before = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  const view = await h.engine.manualAssign('ABS-001', { teacherId: 't2', reason: '值班员电话确认骨干教师' });
  assert.equal(view.state, 'covered');
  assert.equal(view.assignment.source, 'manual');
  assert.equal(view.assignment.reason, '值班员电话确认骨干教师');
  // 原待确认邀请随即失效
  assert.equal(h.store.invitations.get(before.id).state, 'invalidated');
  assert.equal(view.roster.find((e) => e.teacherId === 't2').disposition, 'assigned');
  assert.equal(view.roster.find((e) => e.teacherId === 't1').disposition, 'excluded');
});

test('撤销邀请后队列继续晋升', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  await h.engine.revokeInvitation(inv.id, 'duty-officer');
  const view = await h.engine.getAbsence('ABS-001');
  assert.equal(view.currentInvitation.teacherId, 't2');
  assert.equal(h.store.invitations.get(inv.id).state, 'invalidated');
  assert.equal(h.store.invitations.get(inv.id).invalidateReason, 'revoked');
  // 已终态邀请不能重复撤销
  await assert.rejects(h.engine.revokeInvitation(inv.id), (err) => err.code === 'already-decided');
});

test('撤销缺岗事件后所有占位失效，课程开始后不能撤销', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  const view = await h.engine.cancelAbsence('ABS-001');
  assert.equal(view.state, 'cancelled');
  assert.equal(h.store.invitations.get(inv.id).state, 'invalidated');
  await assert.rejects(h.engine.cancelAbsence('ABS-001'), (err) => err.code === 'invalid-state');
});

test('二次缺岗：历任中选者进入历史并被排除，重新建队邀请', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv1 = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  await h.engine.respondInvitation({ invitationId: inv1.id, teacherId: 't1', action: 'decline' });
  const inv2 = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  await h.engine.respondInvitation({ invitationId: inv2.id, teacherId: 't2', action: 'accept' });

  const view = await h.engine.reopen('ABS-001', { reason: 't2 路上堵车二次缺岗' });
  assert.equal(view.state, 'inviting');
  assert.equal(view.round, 2);
  // 曾拒绝过的 t1 可以再次进入候选；中过选的 t2 被排除
  assert.equal(view.currentInvitation.teacherId, 't1');
  const t2entry = view.roster.find((e) => e.teacherId === 't2');
  assert.equal(t2entry.disposition, 'excluded');
  assert.equal(t2entry.reason, 'recurrent-absence');
  // 历史安排可追溯
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].teacherId, 't2');
  assert.equal(view.history[0].source, 'ranked');

  await assert.rejects(h.engine.reopen('ABS-001', {}), (err) => err.code === 'invalid-state');
});

test('待确认占位会阻止同一教师被派给同时段的另一个班', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput({ id: 'ABS-A' }));
  // t1 持有 A 的待确认占位期间，B 班同时段缺岗
  const viewB = await h.engine.reportAbsence(
    absenceInput({ id: 'ABS-B', classRef: 'CLASS-7C' }),
  );
  const t1 = viewB.roster.find((e) => e.teacherId === 't1');
  assert.equal(t1.disposition, 'skipped');
  assert.equal(t1.reason, 'already-held');
  assert.equal(t1.detail.absenceId, 'ABS-A');
  assert.equal(viewB.currentInvitation.teacherId, 't2');

  // t1 接受 A 之后，B 班仍不能指定 t1
  const invA = (await h.engine.getAbsence('ABS-A')).currentInvitation;
  await h.engine.respondInvitation({ invitationId: invA.id, teacherId: 't1', action: 'accept' });
  await assert.rejects(
    h.engine.manualAssign('ABS-B', { teacherId: 't1', reason: '想强行指定' }),
    (err) => err.code === 'manual-conflict' && err.details.reason === 'already-held',
  );
});

test('课程开始后不能应答、不能人工指定、不能重新开启', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  await h.clock.advance(31 * 60 * 1000); // 08:01
  await assert.rejects(
    h.engine.respondInvitation({ invitationId: inv.id, teacherId: 't1', action: 'accept' }),
    (err) => err.code === 'lesson-started',
  );
  await assert.rejects(
    h.engine.manualAssign('ABS-001', { teacherId: 't2', reason: '迟到的人工指定' }),
    (err) => err.code === 'lesson-started',
  );
  await assert.rejects(h.engine.reopen('ABS-001', {}), (err) => err.code === 'lesson-started');
});

test('每次紧急调整都有完整审计轨迹', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv = (await h.engine.getAbsence('ABS-001')).currentInvitation;
  await h.engine.respondInvitation({ invitationId: inv.id, teacherId: 't1', action: 'accept' });
  const audit = await h.engine.getAudit('ABS-001');
  const types = audit.map((x) => x.type);
  assert.deepEqual(types.slice(0, 4), ['reported', 'round-opened', 'roster-built', 'candidate-skipped']);
  assert.ok(types.includes('candidate-promoted'));
  assert.ok(types.includes('invited'));
  assert.ok(types.includes('accepted'));
  assert.ok(types.includes('covered'));
  // 不合格候选逐条留痕
  const skips = audit.filter((x) => x.type === 'candidate-skipped');
  assert.deepEqual(
    [...new Set(skips.map((x) => x.detail.reason))].sort(),
    ['schedule-conflict', 'unqualified', 'workload-limit'].sort(),
  );
  // 序号严格递增
  audit.forEach((x, i) => assert.equal(x.seq, i + 1));
});

test('重启后未过期占位继续有效；停服期间过期的项在恢复时被清理', async (t) => {
  const h = (t._harness = await makeHarness());
  await h.engine.reportAbsence(absenceInput());
  const inv1Id = (await h.engine.getAbsence('ABS-001')).currentInvitation.id;
  await h.clock.advance(120 * 1000); // 07:32，占位仍有效
  await h.store.close();

  // 用同一日志文件起新进程：未过期占位存活
  const clock2 = new FakeClock(START - 28 * 60 * 1000); // 07:32
  const store2 = new Store(h.file);
  const engine2 = new SubstituteEngine({ store: store2, clock: clock2, teachers: defaultTeachers() });
  await engine2.start();
  t._harness = { dispose: () => store2.close().then(() => rm(h.dir, { recursive: true, force: true })) };
  const pending = await engine2.listPendingForTeacher('t1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].invitationId, inv1Id);

  // 停服到 07:40（inv1 已于 07:35 过期、t2 应在恢复后自动晋升并随后也超时）
  await clock2.advance(8 * 60 * 1000);
  const view = await engine2.getAbsence('ABS-001');
  assert.equal(view.state, 'inviting');
  const inv1Again = (() => {
    let found = null;
    for (const x of store2.invitations.values()) if (x.id === inv1Id) found = x;
    return found;
  })();
  assert.equal(inv1Again.state, 'expired');
  const audit = await engine2.getAudit('ABS-001');
  assert.ok(audit.some((x) => x.type === 'restart-recovered'));
});

test('时间必须显式带时区偏移量；当日工作量按学校所在地日历划分', async (t) => {
  const teachers = [
    {
      id: 'z1', name: '跨日老师', subjects: ['chinese'], dailyMax: 1,
      // 按 UTC 是 09-11 白天，按学校 +08:00 已是 09-12 凌晨，不应计入 09-11 当日工作量
      schedule: [{ classRef: 'CLASS-9Z', startsAt: `2026-09-11T16:30:00+00:00`, endsAt: `2026-09-11T17:15:00+00:00` }],
    },
  ];
  const h = (t._harness = await makeHarness({ teachers }));
  await assert.rejects(
    h.engine.reportAbsence(absenceInput({ startsAt: '2026-09-11T08:00:00' })),
    (err) => err.status === 400,
  );
  const view = await h.engine.reportAbsence(absenceInput());
  const entry = view.roster.find((e) => e.teacherId === 'z1');
  assert.equal(entry.disposition, 'invited');
});

test('无合格候选时保持 inviting 并标记 awaitingManual，人工指定可直接兜底', async (t) => {
  const only = [
    { id: 'x1', subjects: ['math'], dailyMax: 4, schedule: [] },
  ];
  const h = (t._harness = await makeHarness({ teachers: only }));
  const view = await h.engine.reportAbsence(absenceInput());
  assert.equal(view.state, 'inviting');
  assert.equal(view.awaitingManual, true);
  assert.equal(view.roster[0].reason, 'unqualified');
  // 仍然无人可指定时给出明确冲突
  await assert.rejects(
    h.engine.manualAssign('ABS-001', { teacherId: 'x1', reason: '硬着头皮' }),
    (err) => err.code === 'manual-conflict',
  );
});
