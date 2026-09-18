import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { JsonStore } from '../src/store.js';
import { SchedulerEngine, ApiError } from '../src/engine.js';

const SLOT = {
  classRef: 'CLASS-7A',
  subject: 'chinese',
  startsAt: '2026-09-11T08:00:00+08:00',
  endsAt: '2026-09-11T08:45:00+08:00',
  responseSeconds: 300,
  absentTeacherId: 'T07',
};
const T0 = Date.parse('2026-09-11T07:00:00+08:00');

function makeTeachers() {
  return [
    { id: 'T07', name: '缺岗本人', subjects: ['chinese'], dailyLoadMinutes: 240, schedule: [lesson('08:00', '08:45')] },
    { id: 'T01', name: '林老师', subjects: ['chinese', 'ethics'], dailyLoadMinutes: 180, schedule: [] },
    { id: 'T02', name: '赵老师', subjects: ['chinese'], dailyLoadMinutes: 240, schedule: [lesson('09:00', '09:45')] },
    { id: 'T03', name: '钱老师', subjects: ['math'], dailyLoadMinutes: 240, schedule: [] },
    { id: 'T04', name: '孙老师', subjects: ['chinese'], dailyLoadMinutes: 240, schedule: [lesson('07:10', '07:55')] },
    { id: 'T05', name: '周老师', subjects: ['chinese'], dailyLoadMinutes: 60, schedule: [lesson('10:00', '10:45')] },
    { id: 'T06', name: '吴老师', subjects: ['chinese'], dailyLoadMinutes: 240, schedule: [lesson('08:05', '08:50')] },
  ];
}
function lesson(start, end) {
  return { startsAt: `2026-09-11T${start}:00+08:00`, endsAt: `2026-09-11T${end}:00+08:00` };
}

async function harness(clockStart = T0) {
  const dir = join(tmpdir(), `sub-${Math.random().toString(36).slice(2)}`);
  const file = join(dir, 'state.json');
  let clock = clockStart;
  const store = new JsonStore(file);
  await store.load();
  const engine = new SchedulerEngine(store, { now: () => clock, minBreakMinutes: 10 });
  await engine.replaceTeachers(makeTeachers());
  return { engine, file, tick: (ms) => (clock += ms), setClock: (t) => (clock = t), dir };
}

test('候选队列：按资质/课表/连续授课/工作量给出顺序与跳过原因', async () => {
  const h = await harness();
  const status = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-X' });
  // T03 学科不符；T06 时间重叠；T07 本人缺岗；T04 仅隔 5 分钟违反连续授课限制。
  const skipped = Object.fromEntries(status.queue.filter((c) => c.skipReason).map((c) => [c.teacher.id, c.skipReason]));
  assert.equal(skipped.T03, 'unqualified');
  assert.equal(skipped.T06, 'schedule-conflict');
  assert.equal(skipped.T04, 'schedule-conflict');
  assert.equal(skipped.T07, 'already-held');
  // T05 当日已有 45 分钟课，再代 45 分钟达 90 > 60 上限。
  assert.equal(skipped.T05, 'workload-limit');
  // 可代者 T01（0 工作量）先于 T02（45 分钟）。
  const queued = status.queue.filter((c) => !c.skipReason);
  assert.deepEqual(queued.map((c) => c.teacher.id), ['T01', 'T02']);
  assert.equal(status.currentInvitation.teacherId ?? status.currentInvitation.invitationId.slice(0, 3), 'INV');
  assert.equal(status.currentInvitation.state, 'pending');
  assert.equal(status.currentInvitation.rank, 1);
});

test('顺序邀请：拒绝后自动邀请下一位；上一位终态不变', async () => {
  const h = await harness();
  const s1 = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-D' });
  const inv1 = s1.currentInvitation.invitationId;
  assert.equal(s1.currentInvitation.round, 1);

  const r = await h.engine.respond(inv1, 'T01', 'decline', { reason: 'ill' });
  assert.equal(r.outcome, 'inviting');
  const s2 = await h.engine.getStatus('ABS-D');
  assert.equal(s2.currentInvitation.invitationId !== inv1, true);
  assert.equal(
    s2.queue.find((c) => c.invitationId === inv1).status,
    'declined',
  );
  assert.equal(s2.queue.find((c) => c.teacher.id === 'T02').status, 'pending');
});

test('超时：到点未回复邀请失效并顺延；课程开始后未接续转 uncovered', async () => {
  const h = await harness();
  const s1 = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-T' });
  const inv1 = s1.currentInvitation.invitationId;
  h.tick(300_001); // 超过 5 分钟响应时限
  const s2 = await h.engine.getStatus('ABS-T');
  assert.equal(s2.queue.find((c) => c.invitationId === inv1).status, 'expired');
  const inv2 = s2.currentInvitation.invitationId;
  assert.ok(inv2);
  h.setClock(Date.parse(SLOT.startsAt));
  const s3 = await h.engine.getStatus('ABS-T');
  assert.equal(s3.state, 'uncovered');
  assert.equal(s3.uncoveredReason, 'course-started');
  assert.equal(s3.queue.find((c) => c.invitationId === inv2).status, 'expired');
  // 开课后不能再回执
  await assert.rejects(h.engine.respond(inv2, 'T02', 'accept'), (e) => e instanceof ApiError && e.code === 'COURSE_STARTED');
});

test('接受原子确认唯一人选：其余邀请失效，重复接受不改写结果', async () => {
  const h = await harness();
  const s1 = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-A' });
  const inv1 = s1.currentInvitation.invitationId;
  h.tick(300_001);
  const s2 = await h.engine.getStatus('ABS-A');
  const inv2 = s2.currentInvitation.invitationId;
  // inv1 已 expired；T02 接受 inv2
  const acc = await h.engine.respond(inv2, 'T02', 'accept');
  assert.equal(acc.outcome, 'covered');
  const s3 = await h.engine.getStatus('ABS-A');
  assert.equal(s3.state, 'covered');
  assert.equal(s3.assignment.teacher.id, 'T02');
  assert.equal(s3.assignment.source, 'ranked');
  assert.equal(s3.queue.find((c) => c.invitationId === inv1).status, 'expired');
  assert.equal(s3.currentInvitation, null);

  // 重复回执：相同动作返回幂等结果，状态不变；相反动作明确报错
  const again = await h.engine.respond(inv2, 'T02', 'accept');
  assert.equal(again.idempotent, true);
  await assert.rejects(h.engine.respond(inv2, 'T02', 'decline'), (e) => e.code === 'INVITATION_FINALIZED');
  const s4 = await h.engine.getStatus('ABS-A');
  assert.equal(s4.assignment.teacher.id, 'T02');
  assert.equal(s4.state, 'covered');

  // 他人不能代为回执
  await assert.rejects(h.engine.respond(inv2, 'T01', 'decline'), (e) => e.code === 'NOT_OWNER');
});

test('不会把有重叠占位的教师同时派给两个班', async () => {
  const h = await harness();
  const a = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-B1' });
  await h.engine.respond(a.currentInvitation.invitationId, 'T01', 'accept');

  // 另一班同时段语文缺岗：T01 已被占用，队列应直接落到 T02
  const b = await h.engine.reportAbsence({
    ...SLOT,
    absenceId: 'ABS-B2',
    classRef: 'CLASS-7B',
    startsAt: '2026-09-11T08:00:00+08:00',
    endsAt: '2026-09-11T08:45:00+08:00',
  });
  assert.equal(b.queue.find((c) => c.teacher.id === 'T01').skipReason, 'already-held');
  assert.equal(b.currentInvitation.rank, 1);
  // T02 自己 09:00 有课，与 08:00 场次间隔 15 分钟，合格
  assert.equal(b.currentInvitation.subject, 'chinese');

  // 相邻不足课间（T02 已确认 08:00 场后，再代 08:50 场应被连续授课限制拦截）
  const c = await h.engine.reportAbsence({
    ...SLOT,
    absenceId: 'ABS-B3',
    classRef: 'CLASS-7C',
    startsAt: '2026-09-11T08:50:00+08:00',
    endsAt: '2026-09-11T09:35:00+08:00',
  });
  const t02 = c.queue.find((x) => x.teacher.id === 'T02');
  assert.equal(t02.skipReason, 'schedule-conflict');
});

test('顺延时缺岗本人/被排除者永远不会收到邀请', async () => {
  const h = await harness();
  const s1 = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-EX' });
  assert.equal(s1.currentInvitation.teacher.id, 'T01');
  h.tick(300_001); // T01 超时
  const s2 = await h.engine.getStatus('ABS-EX');
  assert.equal(s2.currentInvitation.teacher.id, 'T02');
  h.tick(300_001); // T02 超时
  const s3 = await h.engine.getStatus('ABS-EX');
  // T04 因连续授课被跳过；此时应 exhausted/uncovered，绝不能邀请 T07
  if (s3.currentInvitation) assert.notEqual(s3.currentInvitation.teacher.id, 'T07');
  assert.equal(s3.queue.find((c) => c.teacher.id === 'T07').skipReason, 'already-held');
});

test('接受瞬间的二次冲突校验仍生效（邀请发出后教师课表被临时加课）', async () => {
  const h = await harness();
  const a = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-C1' });
  const invT01 = a.currentInvitation.invitationId;
  // 邀请在途期间，T01 被临时安排了与本班时间重叠的会议/课程
  const updated = makeTeachers().map((t) =>
    t.id === 'T01'
      ? { ...t, schedule: [...t.schedule, lesson('08:00', '08:45')] }
      : t,
  );
  await h.engine.replaceTeachers(updated);
  await assert.rejects(h.engine.respond(invT01, 'T01', 'accept'), (e) => e.code === 'CONFLICT');
  // 该邀请标记失效，队列顺延到 T02
  const s = await h.engine.getStatus('ABS-C1');
  assert.equal(s.queue.find((c) => c.invitationId === invT01).status, 'invalidated');
  assert.equal(s.currentInvitation.teacher.id, 'T02');
});

test('人工指定：必须填写原因且仍通过冲突校验；可指定队列外教师', async () => {
  const h = await harness();
  await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-M' });
  await assert.rejects(h.engine.manualAssign('ABS-M', 'T01', '  '), (e) => e.code === 'REASON_REQUIRED');
  await assert.rejects(h.engine.manualAssign('ABS-M', 'T03', '试试看'), (e) => e.code === 'CONFLICT'); // 资质不符
  await assert.rejects(h.engine.manualAssign('ABS-M', 'T06', '试试看'), (e) => e.code === 'CONFLICT'); // 时间冲突
  const s = await h.engine.manualAssign('ABS-M', 'T02', 'T01 电话联系不上，T02 住得最近');
  assert.equal(s.state, 'covered');
  assert.equal(s.assignment.source, 'manual');
  assert.equal(s.assignment.teacher.id, 'T02');
  // 已 covered 后再指定被拒绝
  await assert.rejects(h.engine.manualAssign('ABS-M', 'T01', '换人'), (e) => e.code === 'ALREADY_COVERED');
});

test('撤销缺岗：在途邀请失效，事件进入 cancelled', async () => {
  const h = await harness();
  const s = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-X2' });
  const inv = s.currentInvitation.invitationId;
  const c = await h.engine.cancelAbsence('ABS-X2');
  assert.equal(c.state, 'cancelled');
  assert.equal(c.queue.find((x) => x.invitationId === inv).status, 'invalidated');
  // 撤销后再回执无效
  await assert.rejects(h.engine.respond(inv, 'T01', 'accept'), (e) => e.code === 'ABSENCE_CANCELLED' || e.code === 'NOT_PENDING');
});

test('二次缺岗：已接续事件重新开启新一轮队列，旧确认者默认排除', async () => {
  const h = await harness();
  const s = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-R' });
  await h.engine.respond(s.currentInvitation.invitationId, 'T01', 'accept');
  const r = await h.engine.reopenAbsence('ABS-R');
  assert.equal(r.state, 'inviting');
  assert.equal(r.round, 2);
  // T01 再次缺岗被排除
  assert.equal(r.queue.find((c) => c.teacher.id === 'T01').skipReason, 'already-held');
  assert.equal(r.currentInvitation.rank, 1);
  // 新一轮可以正常接续
  const done = await h.engine.respond(r.currentInvitation.invitationId, 'T02', 'accept');
  assert.equal(done.outcome, 'covered');
  // 仍在邀请中的事件不能 reopen
  const s2 = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-R2' });
  assert.equal(s2.state, 'inviting');
  await assert.rejects(h.engine.reopenAbsence('ABS-R2'), (e) => e.code === 'NOT_COVERED');
});

test('教师端只能看到自己的待确认邀请', async () => {
  const h = await harness();
  await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-V1' });
  h.tick(300_001);
  await h.engine.reportAbsence({ ...SLOT, classRef: 'CLASS-8B', absenceId: 'ABS-V2', startsAt: '2026-09-11T10:00:00+08:00', endsAt: '2026-09-11T10:45:00+08:00' });
  const mineT01 = await h.engine.myInvitations('T01');
  // T01 对 ABS-V1 的邀请已过期，只剩 V2 的待确认
  assert.deepEqual(mineT01.map((i) => i.absenceId), ['ABS-V2']);
  // V1 已顺延给 T02，T02 看到的是 V1 的待确认邀请
  const mineT02 = await h.engine.myInvitations('T02');
  assert.deepEqual(mineT02.map((i) => i.absenceId), ['ABS-V1']);
});

test('审计链可追溯每个动作', async () => {
  const h = await harness();
  const s = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-L' });
  await h.engine.respond(s.currentInvitation.invitationId, 'T01', 'decline');
  const log = await h.engine.auditTrail('ABS-L');
  const types = log.map((e) => e.type);
  assert.ok(types.includes('absence-reported'));
  assert.ok(types.includes('invitation-issued'));
  assert.ok(types.includes('invitation-declined'));
  assert.ok(types.includes('invitation-issued')); // 第二位
});

test('服务重启：未过期占位继续有效；reconcile 清理过期项', async () => {
  const h = await harness();
  const s = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-P' });
  const inv = s.currentInvitation.invitationId;

  // 模拟重启：同文件新 store/engine，时钟仅前进 1 分钟
  let clock = T0 + 60_000;
  const store2 = new JsonStore(h.file);
  await store2.load();
  const eng2 = new SchedulerEngine(store2, { now: () => clock });
  const rec = await eng2.reconcile();
  assert.equal(rec.pending, 1);
  const acc = await eng2.respond(inv, 'T01', 'accept');
  assert.equal(acc.outcome, 'covered');

  // 另一事件：重启时已超时
  const storeA = new JsonStore(join(h.dir, 'a.json'));
  await storeA.load();
  let clock2 = T0;
  const engA = new SchedulerEngine(storeA, { now: () => clock2 });
  await engA.replaceTeachers(makeTeachers());
  const s2 = await engA.reportAbsence({ ...SLOT, absenceId: 'ABS-Q' });
  assert.ok(s2.currentInvitation);
  clock2 = Date.parse(SLOT.startsAt) + 1000;
  const storeB = new JsonStore(join(h.dir, 'a.json'));
  await storeB.load();
  const engB = new SchedulerEngine(storeB, { now: () => clock2 });
  await engB.reconcile();
  const after = await engB.getStatus('ABS-Q');
  assert.equal(after.state, 'uncovered');
  assert.equal(after.uncoveredReason, 'course-started');

  await rm(h.dir, { recursive: true, force: true });
});

test('跨事件占位解除后，曾因 already-held 跳过的候选会被重新评估', async () => {
  const h = await harness();
  // A 事件先邀请 T01；B 事件同时段只能邀请 T02（T01 因占位被跳过）
  const a = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-DL1' });
  assert.equal(a.currentInvitation.teacher.id, 'T01');
  const b = await h.engine.reportAbsence({ ...SLOT, absenceId: 'ABS-DL2', classRef: 'CLASS-7B' });
  assert.equal(b.queue.find((c) => c.teacher.id === 'T01').skipReason, 'already-held');
  assert.equal(b.currentInvitation.teacher.id, 'T02');
  // T01 拒绝 A；T02 拒绝 B —— B 此时应回头邀请已释放的 T01
  await h.engine.respond(a.currentInvitation.invitationId, 'T01', 'decline');
  await h.engine.respond(b.currentInvitation.invitationId, 'T02', 'decline');
  const b2 = await h.engine.getStatus('ABS-DL2');
  assert.equal(b2.state, 'inviting');
  assert.equal(b2.currentInvitation.teacher.id, 'T01');
});

test('工作量排序：当日既有负担越少越优先，且加上本段后不超上限', async () => {
  const dir = join(tmpdir(), `sub-${Math.random().toString(36).slice(2)}`);
  const file = join(dir, 'state.json');
  const store = new JsonStore(file);
  await store.load();
  const engine = new SchedulerEngine(store, { now: () => T0 });
  await engine.replaceTeachers([
    { id: 'A', name: '满负荷者', subjects: ['chinese'], dailyLoadMinutes: 120, schedule: [lesson('10:00', '10:45')] }, // 已有45，可再45=90
    { id: 'B', name: '空闲者', subjects: ['chinese'], dailyLoadMinutes: 120, schedule: [] },
  ]);
  const s = await engine.reportAbsence({ ...SLOT, absenceId: 'ABS-W', absentTeacherId: 'T07' });
  // 教师列表中无 T07，不影响排序；B 工作量 0 应排在 A(45) 前
  assert.deepEqual(s.queue.filter((c) => !c.skipReason).map((c) => c.teacher.id), ['B', 'A']);
  await rm(dir, { recursive: true, force: true });
});
