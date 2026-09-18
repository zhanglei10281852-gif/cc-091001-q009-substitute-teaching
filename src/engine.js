import { auditTypes } from './domain.js';
import { ValidationError, NotFoundError, ConflictError } from './errors.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;

// mutate 抛出它表示：已做的状态变更先落盘，再把 cause 抛给调用方
class CommitThenThrow extends Error {
  constructor(cause) {
    super(cause.message);
    this.cause = cause;
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} 必须是非空字符串`, { field });
  }
  return value.trim();
}

// 解析带明确时区偏移量的时间，如 2026-09-11T08:00:00+08:00
export function parseOffsetTime(value, field = 'time') {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 必须是带时区偏移量的 ISO 时间字符串`, { field });
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  const ms = Date.parse(value);
  if (!match || !Number.isFinite(ms)) {
    throw new ValidationError(`${field} 必须是带时区偏移量的 ISO 时间`, { field });
  }
  let offsetMinutes = 0;
  if (match[7] !== 'Z') {
    const sign = match[7][0] === '-' ? -1 : 1;
    const digits = match[7].slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  return { ms, offsetMinutes };
}

// 按学校所在地偏移量划分“当日”
function dayKey(epochMs, offsetMinutes) {
  const shifted = new Date(epochMs + offsetMinutes * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// 突发缺岗代课接续引擎。
// 有效期一律按绝对时间（epoch 毫秒）判断；所有状态变更都经过同一把操作锁，
// 在同一个同步阶段完成内存变更后一次性落盘，接受因此能原子确认唯一人选。
export class SubstituteEngine {
  constructor({ store, clock, teachers = [], tzOffsetMinutes = 8 * 60, options = {} }) {
    this.store = store;
    this.clock = clock;
    this.teacherLoader = typeof teachers === 'function' ? teachers : null;
    this.teacherInput = this.teacherLoader ? null : teachers;
    this.defaultOffsetMinutes = tzOffsetMinutes;
    this.teachers = new Map();
    this.maxConsecutiveLessons = options.maxConsecutiveLessons ?? 4;
    this.shortBreakMs = options.shortBreakMs ?? TEN_MINUTES_MS;
    this._timers = new Map(); // invitationId -> 定时器句柄
    this._timer = null; // 最近一个到期点的统一兜底定时器
    this._auditSeq = 1;
    this._auditWatermark = 0;
    this._commitsSinceCompact = 0;
    this._lock = Promise.resolve();
  }

  async start() {
    await this.store.load();
    const list = this.teacherLoader ? await this.teacherLoader() : this.teacherInput;
    for (const t of list) this._indexTeacher(t);
    this._auditSeq = this.store.audit.reduce((m, a) => Math.max(m, a.seq + 1), 1);
    this._auditWatermark = this.store.audit.length;

    // 重启恢复：先按绝对时间清理过期项（未过期占位继续有效），再重建定时器
    const hadData = this.store.absences.size > 0 || this.store.invitations.size > 0;
    await this._commit(() => {
      if (hadData) {
        this._settle();
        const recoveredAt = this.clock.now();
        for (const id of this.store.absences.keys()) {
          this._audit('restart-recovered', { absenceId: id, detail: { recoveredAt } });
        }
      }
    });
  }

  _indexTeacher(t) {
    if (!t || typeof t.id !== 'string' || t.id.trim() === '') {
      throw new ValidationError('教师资料缺少 id');
    }
    const schedule = Array.isArray(t.schedule)
      ? t.schedule.map((s) => {
          const start = parseOffsetTime(s.startsAt, 'schedule.startsAt');
          const end = parseOffsetTime(s.endsAt, 'schedule.endsAt');
          if (end.ms <= start.ms) throw new ValidationError('schedule.endsAt 必须晚于 startsAt');
          return {
            startsAt: start.ms,
            endsAt: end.ms,
            offsetMinutes: start.offsetMinutes,
            classRef: s.classRef ?? null,
          };
        })
      : [];
    const dailyMax = t.dailyMax === undefined || t.dailyMax === null ? null : Number(t.dailyMax);
    if (dailyMax !== null && (!Number.isFinite(dailyMax) || dailyMax <= 0)) {
      throw new ValidationError('dailyMax 必须是正数或 null');
    }
    this.teachers.set(t.id, {
      id: t.id,
      name: t.name ?? t.id,
      subjects: Array.isArray(t.subjects) ? [...new Set(t.subjects)] : [],
      dailyMax,
      consecutiveMax: Number.isFinite(t.consecutiveMax) ? Number(t.consecutiveMax) : this.maxConsecutiveLessons,
      schedule,
    });
  }

  // ---------- 操作串行化 ----------

  // 全部读写操作都排队执行：互斥 + 落盘等待在锁内完成
  _exclusive(fn) {
    const run = this._lock.then(() => fn());
    // 锁在本操作（含落盘）结束后才释放；单个操作失败不影响后续操作拿锁
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // mutate 必须同步完成全部状态变更；随后一次性落盘并重建定时器。
  // mutate 抛出 CommitThenThrow 时，已做的状态变更照常落盘，再把原因抛给调用方。
  _commit(mutate) {
    return this._exclusive(() => {
      const before = this._snapshot();
      let result;
      let commitThenThrow = null;
      try {
        result = mutate();
      } catch (err) {
        if (err instanceof CommitThenThrow) {
          commitThenThrow = err.cause;
        } else {
          this._restore(before);
          throw err;
        }
      }
      const records = this._collectRecords();
      return this.store.commit(records).then(
        () => {
          this._armTimers();
          // 全量快照式追加会让日志随操作数增长，定期压缩为最新快照 + 全量审计
          this._commitsSinceCompact += 1;
          if (this._commitsSinceCompact >= 200) {
            this._commitsSinceCompact = 0;
            return this.store.compact().then(() => {
              if (commitThenThrow) throw commitThenThrow;
              return result;
            });
          }
          if (commitThenThrow) throw commitThenThrow;
          return result;
        },
        (err) => {
          this._restore(before);
          throw err;
        },
      );
    });
  }

  _collectRecords() {
    const records = [];
    for (const a of this.store.absences.values()) records.push({ t: 'absence', data: a });
    for (const inv of this.store.invitations.values()) records.push({ t: 'invitation', data: inv });
    for (const [key, data] of this.store.keys.entries()) records.push({ t: 'key', key, data });
    for (let i = this._auditWatermark; i < this.store.audit.length; i++) {
      records.push({ t: 'audit', data: this.store.audit[i] });
    }
    this._auditWatermark = this.store.audit.length;
    return records;
  }

  _snapshot() {
    return {
      absences: [...this.store.absences.values()].map((a) => structuredClone(a)),
      invitations: [...this.store.invitations.values()].map((i) => structuredClone(i)),
      keys: [...this.store.keys.values()].map((k) => structuredClone(k)),
      auditLen: this._auditWatermark,
      seq: this._auditSeq,
    };
  }

  _restore(snap) {
    this.store.absences = new Map(snap.absences.map((a) => [a.id, a]));
    this.store.invitations = new Map(snap.invitations.map((i) => [i.id, i]));
    this.store.keys = new Map(snap.keys.map((k) => [k.key, k]));
    this.store.audit.length = snap.auditLen;
    this._auditWatermark = snap.auditLen;
    this._auditSeq = snap.seq;
  }

  // ---------- 查询视图（读路径同样先做惰性结算） ----------

  listAbsences() {
    return this._exclusive(() => {
      this._settle();
      return this._flushRead().then(() => [...this.store.absences.values()].map((a) => this._absenceView(a)));
    });
  }

  getAbsence(id) {
    return this._exclusive(() => {
      this._settle();
      return this._flushRead().then(() => {
        const a = this.store.absences.get(id);
        if (!a) throw new NotFoundError('缺岗事件');
        return this._absenceView(a);
      });
    });
  }

  getAudit(id) {
    return this._exclusive(() => {
      if (!this.store.absences.has(id)) throw new NotFoundError('缺岗事件');
      return this.store.audit
        .filter((x) => x.absenceId === id)
        .sort((x, y) => x.seq - y.seq)
        .map((x) => ({ ...x, at: iso(x.at) }));
    });
  }

  // 教师端：只能查到自己的待确认邀请
  listPendingForTeacher(teacherId) {
    return this._exclusive(() => {
      if (!this.teachers.has(teacherId)) throw new NotFoundError('教师');
      this._settle();
      return this._flushRead().then(() =>
        [...this.store.invitations.values()]
          .filter((inv) => inv.teacherId === teacherId && inv.state === 'pending')
          .map((inv) => this._teacherInvitationView(inv)),
      );
    });
  }

  // 惰性结算可能产生状态变化，读路径也要把它落盘（在锁内等待完成）
  _flushRead() {
    const records = this._collectRecords();
    if (records.length === 0) return Promise.resolve();
    return this.store.commit(records).then(() => this._armTimers());
  }

  _absenceView(a) {
    const current = a.currentInvitationId ? this.store.invitations.get(a.currentInvitationId) : null;
    return {
      id: a.id,
      classRef: a.classRef,
      subject: a.subject,
      startsAt: iso(a.startsAt),
      endsAt: iso(a.endsAt),
      responseSeconds: a.responseSeconds,
      state: a.state,
      round: a.round,
      awaitingManual: a.state === 'inviting' && !current,
      roster: a.roster.map((e) => ({
        rank: e.rank,
        teacherId: e.teacherId,
        teacherName: this.teachers.get(e.teacherId)?.name ?? e.teacherId,
        disposition: e.disposition,
        reason: e.reason ?? null,
        detail: e.detail ?? null,
        invitationId: e.invitationId ?? null,
      })),
      currentInvitation: current
        ? {
            id: current.id,
            teacherId: current.teacherId,
            teacherName: this.teachers.get(current.teacherId)?.name ?? current.teacherId,
            state: current.state,
            expiresAt: iso(current.expiresAt),
            remainingSeconds: Math.max(0, Math.ceil((current.expiresAt - this.clock.now()) / 1000)),
          }
        : null,
      assignment: a.assignment
        ? {
            teacherId: a.assignment.teacherId,
            teacherName: this.teachers.get(a.assignment.teacherId)?.name ?? a.assignment.teacherId,
            source: a.assignment.source,
            reason: a.assignment.reason ?? null,
            at: iso(a.assignment.at),
          }
        : null,
      history: (a.history ?? []).map((h) => ({
        teacherId: h.teacherId,
        teacherName: this.teachers.get(h.teacherId)?.name ?? h.teacherId,
        source: h.source,
        reason: h.reason ?? null,
        at: iso(h.at),
      })),
      createdAt: iso(a.createdAt),
      closedAt: a.closedAt ? iso(a.closedAt) : null,
    };
  }

  _teacherInvitationView(inv) {
    const a = this.store.absences.get(inv.absenceId);
    return {
      invitationId: inv.id,
      absenceId: inv.absenceId,
      classRef: a.classRef,
      subject: a.subject,
      startsAt: iso(a.startsAt),
      endsAt: iso(a.endsAt),
      expiresAt: iso(inv.expiresAt),
      remainingSeconds: Math.max(0, Math.ceil((inv.expiresAt - this.clock.now()) / 1000)),
    };
  }

  // ---------- 缺岗事件 ----------

  async reportAbsence(input = {}, actor = null) {
    const parsedStart = parseOffsetTime(input.startsAt, 'startsAt');
    const parsedEnd = parseOffsetTime(input.endsAt, 'endsAt');
    const classRef = requireString(input.classRef, 'classRef');
    const subject = requireString(input.subject, 'subject');
    if (parsedEnd.ms <= parsedStart.ms) throw new ValidationError('endsAt 必须晚于 startsAt');
    const responseSeconds = Number(input.responseSeconds);
    if (!Number.isInteger(responseSeconds) || responseSeconds <= 0) {
      throw new ValidationError('responseSeconds 必须是正整数秒');
    }
    const id = input.id ? requireString(input.id, 'id') : `ABS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    return this._commit(() => {
      if (this.store.absences.has(id)) throw new ConflictError('absence-exists', `缺岗事件 ${id} 已存在`);
      const now = this.clock.now();
      if (now >= parsedStart.ms) throw new ConflictError('lesson-started', '缺岗课程已经开始或已结束');
      const offsetMinutes = Number.isFinite(input.tzOffsetMinutes)
        ? Number(input.tzOffsetMinutes)
        : parsedStart.offsetMinutes;
      const absence = {
        id,
        classRef,
        subject,
        startsAt: parsedStart.ms,
        endsAt: parsedEnd.ms,
        offsetMinutes,
        responseSeconds,
        state: 'reported',
        round: 0,
        roster: [],
        currentInvitationId: null,
        assignment: null,
        history: [],
        dayKey: dayKey(parsedStart.ms, offsetMinutes),
        createdAt: now,
        closedAt: null,
      };
      this.store.absences.set(id, absence);
      this._audit('reported', { absenceId: id, actor, detail: { classRef, subject } });
      if (input.autoInvite !== false) this._openRound(absence);
      return this._absenceView(absence);
    });
  }

  // 开启首轮邀请：生成有顺序的候选队列并发出首位邀请
  openRound(absenceId, actor = null) {
    return this._commit(() => {
      const a = this.store.absences.get(absenceId);
      if (!a) throw new NotFoundError('缺岗事件');
      if (a.state !== 'reported') {
        throw new ConflictError('invalid-state', `缺岗事件当前状态为 ${a.state}，不能开启候选队列`, { state: a.state });
      }
      this._openRound(a);
      return this._absenceView(a);
    });
  }

  cancelAbsence(absenceId, actor = null) {
    return this._commit(() => {
      const a = this.store.absences.get(absenceId);
      if (!a) throw new NotFoundError('缺岗事件');
      if (!['reported', 'inviting'].includes(a.state)) {
        throw new ConflictError('invalid-state', `状态为 ${a.state} 的缺岗事件不能撤销`, { state: a.state });
      }
      if (this.clock.now() >= a.startsAt) throw new ConflictError('lesson-started', '课程已经开始，不能撤销');
      a.state = 'cancelled';
      a.closedAt = this.clock.now();
      this._invalidatePending(a, { rosterReason: 'cancelled', reason: 'absence-cancelled' });
      for (const e of a.roster) {
        if (e.disposition === 'queued') {
          e.disposition = 'excluded';
          e.reason = 'cancelled';
        }
      }
      this._audit('absence-cancelled', { absenceId: a.id, actor });
      return this._absenceView(a);
    });
  }

  // 二次缺岗：既有安排进入历史，排除历任人选后重新建队邀请
  reopen(absenceId, { reason } = {}, actor = null) {
    return this._commit(() => {
      const a = this.store.absences.get(absenceId);
      if (!a) throw new NotFoundError('缺岗事件');
      if (this.clock.now() >= a.startsAt) throw new ConflictError('lesson-started', '课程已经开始，不能重新发起邀请');
      if (!['covered', 'uncovered'].includes(a.state)) {
        throw new ConflictError('invalid-state', `状态为 ${a.state} 时不能重新开启接续`, { state: a.state });
      }
      const note = reason ? requireString(reason, 'reason') : '二次缺岗';
      const exclude = new Set(a.history.map((h) => h.teacherId));
      if (a.assignment) {
        a.history.push(a.assignment);
        exclude.add(a.assignment.teacherId);
      }
      a.assignment = null;
      a.closedAt = null;
      this._openRound(a, { excludeTeacherIds: exclude, excludeReason: 'recurrent-absence', reopenNote: note });
      return this._absenceView(a);
    });
  }

  // ---------- 邀请应答 ----------

  async respondInvitation({ invitationId, teacherId, action, idempotencyKey } = {}, actor = null) {
    requireString(invitationId, 'invitationId');
    requireString(teacherId, 'teacherId');
    if (action !== 'accept' && action !== 'decline') {
      throw new ValidationError("action 只能是 'accept' 或 'decline'");
    }
    return this._commit(() => {
      const inv = this.store.invitations.get(invitationId);
      if (!inv) throw new NotFoundError('邀请');
      if (inv.teacherId !== teacherId) throw new ConflictError('not-invitee', '该邀请不属于当前教师');

      // 幂等键：同一键的重复回执直接重放首次结果
      if (idempotencyKey) {
        const hit = this.store.keys.get(`respond:${idempotencyKey}`);
        if (hit) {
          if (hit.refId !== inv.id || hit.detail.action !== action) {
            throw new ConflictError('idempotency-key-mismatch', '幂等键已用于其他回执');
          }
          return { idempotent: true, ...this._respondResult(inv) };
        }
      }

      // 与最终结果一致的重复回执：始终幂等重放（即使课程已开始）
      const sameFinal =
        (action === 'accept' && inv.state === 'accepted') ||
        (action === 'decline' && inv.state === 'declined');
      if (sameFinal) return { idempotent: true, ...this._respondResult(inv) };

      const absenceAtStart = this.store.absences.get(inv.absenceId);
      // 课程已经开始且无人接续：先结算到应有状态，再给出明确去向
      if (this.clock.now() >= absenceAtStart.startsAt && absenceAtStart.state !== 'covered') {
        this._settle();
        throw new CommitThenThrow(new ConflictError('lesson-started', '课程已经开始，不能再应答邀请'));
      }
      this._settleInvitation(inv);

      if (inv.state !== 'pending') {
        // 惰性结算可能改写了状态；终态后的矛盾回执驳回但保留结算结果
        throw new CommitThenThrow(
          new ConflictError('already-decided', '邀请已有最终结果，重复回执不会改写', { state: inv.state }),
        );
      }

      const a = this.store.absences.get(inv.absenceId);
      if (a.state !== 'inviting' || a.currentInvitationId !== inv.id) {
        throw new ConflictError('not-current', '该邀请已不是当前待确认邀请', { absenceState: a.state });
      }
      const now = this.clock.now();
      if (now >= a.startsAt) {
        this._settle();
        throw new ConflictError('lesson-started', '课程已经开始，不能再应答邀请');
      }

      if (action === 'decline') {
        inv.state = 'declined';
        inv.respondedAt = now;
        this._markRoster(a, inv.teacherId, { disposition: 'skipped', reason: 'declined' });
        a.currentInvitationId = null;
        this._audit('declined', { absenceId: a.id, invitationId: inv.id, teacherId: inv.teacherId, actor });
        this._promoteNext(a);
        if (idempotencyKey) this.store.keys.set(`respond:${idempotencyKey}`, { refId: inv.id, detail: { action } });
        return { idempotent: false, ...this._respondResult(inv) };
      }

      // 接受：以占位时刻的最新状态重新做冲突校验
      const violation = this._evaluate(this.teachers.get(inv.teacherId), a, { excludeInvitationId: inv.id });
      if (violation) {
        inv.state = 'invalidated';
        inv.respondedAt = now;
        inv.invalidateReason = violation.reason;
        this._markRoster(a, inv.teacherId, { disposition: 'skipped', reason: violation.reason, detail: violation.detail ?? null });
        a.currentInvitationId = null;
        this._audit('invalidated', {
          absenceId: a.id, invitationId: inv.id, teacherId: inv.teacherId, actor, detail: violation,
        });
        this._promoteNext(a);
        throw new CommitThenThrow(
          new ConflictError('teacher-no-longer-eligible', '接受时冲突校验未通过，邀请已失效', violation),
        );
      }

      // 原子确认唯一人选
      inv.state = 'accepted';
      inv.respondedAt = now;
      this._markRoster(a, inv.teacherId, { disposition: 'assigned', reason: 'accepted' });
      a.state = 'covered';
      a.coveredAt = now;
      a.closedAt = null;
      a.assignment = { teacherId: inv.teacherId, source: 'ranked', reason: null, at: now, invitationId: inv.id };
      for (const e of a.roster) {
        if (e.disposition === 'queued') {
          e.disposition = 'excluded';
          e.reason = 'covered';
        }
      }
      this._invalidatePending(a, { rosterReason: 'covered', reason: 'superseded-by-accept', exceptInvitationId: inv.id });
      a.currentInvitationId = null;
      this._audit('accepted', { absenceId: a.id, invitationId: inv.id, teacherId: inv.teacherId, actor });
      this._audit('covered', { absenceId: a.id, teacherId: inv.teacherId, actor, detail: { source: 'ranked' } });
      if (idempotencyKey) this.store.keys.set(`respond:${idempotencyKey}`, { refId: inv.id, detail: { action } });
      return { idempotent: false, ...this._respondResult(inv) };
    });
  }

  // 值班员人工指定：必须写明原因，且同样要通过冲突校验
  async manualAssign(absenceId, { teacherId, reason } = {}, actor = null) {
    requireString(teacherId, 'teacherId');
    const note = requireString(reason, 'reason');
    return this._commit(() => {
      const a = this.store.absences.get(absenceId);
      if (!a) throw new NotFoundError('缺岗事件');
      const teacher = this.teachers.get(teacherId);
      if (!teacher) throw new NotFoundError('教师');
      if (this.clock.now() >= a.startsAt) throw new ConflictError('lesson-started', '课程已经开始，不能再人工指定');
      if (!['reported', 'inviting'].includes(a.state)) {
        throw new ConflictError('invalid-state', `状态为 ${a.state}，不能人工指定`, { state: a.state });
      }
      // 本事件名下的占位会随指定一并失效，因此该教师对本事件的占位不计入冲突
      const violation = this._evaluate(teacher, a, { excludeAbsenceId: a.id });
      if (violation) throw new ConflictError('manual-conflict', '人工指定未通过冲突校验', violation);

      if (a.state === 'reported') this._openRound(a, { silent: true });
      const now = this.clock.now();
      this._invalidatePending(a, { rosterReason: 'manual-assigned', reason: 'manual-assigned' });

      let entry = a.roster.find((e) => e.teacherId === teacherId);
      if (!entry) {
        entry = { rank: a.roster.length + 1, teacherId, disposition: 'assigned', reason: 'manual' };
        a.roster.push(entry);
      }
      for (const e of a.roster) {
        if (e === entry) continue;
        if (e.disposition === 'queued' || e.disposition === 'invited') {
          e.disposition = 'excluded';
          e.reason = 'manual-assigned';
        }
      }
      entry.disposition = 'assigned';
      entry.reason = 'manual';
      entry.detail = null;
      a.state = 'covered';
      a.coveredAt = now;
      a.currentInvitationId = null;
      a.assignment = { teacherId, source: 'manual', reason: note, at: now };
      this._audit('manual-assigned', { absenceId: a.id, teacherId, actor, detail: { reason: note } });
      this._audit('covered', { absenceId: a.id, teacherId, actor, detail: { source: 'manual' } });
      return this._absenceView(a);
    });
  }

  // 教务撤销邀请：该候选按不可用处理，队列继续向后晋升
  revokeInvitation(invitationId, actor = null) {
    return this._commit(() => {
      const inv = this.store.invitations.get(invitationId);
      if (!inv) throw new NotFoundError('邀请');
      if (inv.state !== 'pending') {
        throw new ConflictError('already-decided', `邀请已处于 ${inv.state}，不能撤销`, { state: inv.state });
      }
      const a = this.store.absences.get(inv.absenceId);
      const now = this.clock.now();
      inv.state = 'invalidated';
      inv.respondedAt = now;
      inv.invalidateReason = 'revoked';
      this._markRoster(a, inv.teacherId, { disposition: 'skipped', reason: 'revoked' });
      if (a.currentInvitationId === inv.id) a.currentInvitationId = null;
      this._audit('invitation-revoked', { absenceId: a.id, invitationId: inv.id, teacherId: inv.teacherId, actor });
      if (a.state === 'inviting') this._promoteNext(a);
      return this._absenceView(a);
    });
  }

  // ---------- 过期结算 ----------

  // 显式清理：过期占位转终态；已到上课时间仍未接续的事件转 uncovered
  sweep() {
    return this._commit(() => {
      this._settle();
      return { sweptAt: iso(this.clock.now()) };
    });
  }

  // 同步结算当前时钟下所有应有结果（调用方必须持锁）
  _settle() {
    for (const inv of [...this.store.invitations.values()]) {
      if (inv.state === 'pending') this._settleInvitation(inv);
    }
    const now = this.clock.now();
    for (const a of this.store.absences.values()) {
      if (['reported', 'inviting'].includes(a.state) && now >= a.startsAt) {
        this._markUncovered(a, 'lesson-started');
      }
    }
  }

  _settleInvitation(inv) {
    if (inv.state !== 'pending') return;
    const a = this.store.absences.get(inv.absenceId);
    const now = this.clock.now();
    if (now < inv.expiresAt && !(a && now >= a.startsAt)) return;
    const reason = a && now >= a.startsAt ? 'lesson-started' : 'expired';
    inv.state = 'expired';
    inv.respondedAt = now;
    inv.invalidateReason = reason;
    if (a) {
      this._markRoster(a, inv.teacherId, { disposition: 'skipped', reason });
      if (a.currentInvitationId === inv.id) {
        a.currentInvitationId = null;
        if (now >= a.startsAt) this._markUncovered(a, reason);
        else this._promoteNext(a);
      }
    }
    this._audit('expired', { absenceId: a?.id ?? null, invitationId: inv.id, teacherId: inv.teacherId, detail: { reason } });
  }

  _markUncovered(a, reason) {
    if (!['reported', 'inviting'].includes(a.state)) return;
    this._invalidatePending(a, { rosterReason: 'uncovered', reason });
    for (const e of a.roster) {
      if (e.disposition === 'queued') {
        e.disposition = 'excluded';
        e.reason = 'uncovered';
      }
    }
    a.state = 'uncovered';
    a.closedAt = this.clock.now();
    a.currentInvitationId = null;
    this._audit('uncovered', { absenceId: a.id, detail: { reason } });
  }

  // ---------- 候选队列与冲突校验 ----------

  _openRound(a, { excludeTeacherIds = new Set(), excludeReason = null, reopenNote = null, silent = false } = {}) {
    if (this.clock.now() >= a.startsAt) {
      throw new ConflictError('lesson-started', '课程已经开始，不能再发起邀请');
    }
    a.round += 1;
    a.state = 'inviting';
    a.currentInvitationId = null;
    this._audit('round-opened', { absenceId: a.id, detail: { round: a.round, reopened: reopenNote } });
    this._buildRoster(a, excludeTeacherIds, excludeReason);
    if (!silent) this._promoteNext(a);
  }

  _buildRoster(a, excludeTeacherIds, excludeReason) {
    const evaluated = [];
    this._audit('roster-built', { absenceId: a.id });
    for (const teacher of this.teachers.values()) {
      if (excludeTeacherIds.has(teacher.id)) {
        evaluated.push({ teacherId: teacher.id, disposition: 'excluded', reason: excludeReason, detail: null });
        this._audit('candidate-skipped', { absenceId: a.id, teacherId: teacher.id, detail: { reason: excludeReason } });
        continue;
      }
      const violation = this._evaluate(teacher, a, {});
      if (violation) {
        evaluated.push({ teacherId: teacher.id, disposition: 'skipped', reason: violation.reason, detail: violation.detail ?? null });
        this._audit('candidate-skipped', { absenceId: a.id, teacherId: teacher.id, detail: violation });
      } else {
        const commitments = this._commitments(teacher, a, {});
        evaluated.push({
          teacherId: teacher.id,
          disposition: 'queued',
          reason: null,
          detail: null,
          load: this._daySchedule(teacher, a).length + commitments.length,
          distance: this._distanceToSlot(teacher, commitments, a),
        });
      }
    }
    // 排序：当日工作量越少越优先；同量级时距本课时越远（越从容）越优先；再按工号稳定排序
    const queued = evaluated
      .filter((e) => e.disposition === 'queued')
      .sort((x, y) => x.load - y.load || y.distance - x.distance || (x.teacherId < y.teacherId ? -1 : x.teacherId > y.teacherId ? 1 : 0));
    const others = evaluated.filter((e) => e.disposition !== 'queued');
    a.roster = [...queued, ...others].map((e, i) => ({ rank: i + 1, ...e }));
  }

  // 返回 null 表示合格；否则 { reason, detail }，reason 取领域 skipReasons
  _evaluate(teacher, a, opts) {
    if (!teacher.subjects.includes(a.subject)) {
      return { reason: 'unqualified', detail: { required: a.subject, qualified: teacher.subjects } };
    }
    const commitments = this._commitments(teacher, a, opts);
    const overlappingHold = commitments.find((c) => this._overlap(c, a));
    if (overlappingHold) {
      return {
        reason: 'already-held',
        detail: { absenceId: overlappingHold.absenceId, invitationId: overlappingHold.invitationId ?? null },
      };
    }
    const daySchedule = this._daySchedule(teacher, a);
    const overlappingClass = daySchedule.find((s) => this._overlap(s, a));
    if (overlappingClass) {
      return { reason: 'schedule-conflict', detail: { kind: 'overlap', classRef: overlappingClass.classRef } };
    }
    // 连续授课限制：待确认占位也算临时承诺，防止两个班都确认后连堂超限
    const intervals = [
      ...daySchedule.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, kind: 'schedule' })),
      ...commitments.map((c) => ({ startsAt: c.startsAt, endsAt: c.endsAt, kind: 'hold' })),
      { startsAt: a.startsAt, endsAt: a.endsAt, kind: 'candidate' },
    ].sort((x, y) => x.startsAt - y.startsAt);
    const idx = intervals.findIndex((x) => x.kind === 'candidate');
    let chain = 1;
    for (let j = idx - 1; j >= 0; j--) {
      if (intervals[j + 1].startsAt - intervals[j].endsAt > this.shortBreakMs) break;
      chain++;
    }
    for (let j = idx + 1; j < intervals.length; j++) {
      if (intervals[j].startsAt - intervals[j - 1].endsAt > this.shortBreakMs) break;
      chain++;
    }
    if (chain > teacher.consecutiveMax) {
      return { reason: 'schedule-conflict', detail: { kind: 'consecutive-limit', consecutive: chain, max: teacher.consecutiveMax } };
    }
    // 当日工作量：原课表 + 已接受/待确认代课占位 + 本次
    const projected = daySchedule.length + commitments.length + 1;
    if (teacher.dailyMax !== null && projected > teacher.dailyMax) {
      return { reason: 'workload-limit', detail: { projected, dailyMax: teacher.dailyMax } };
    }
    return null;
  }

  // 教师当日与本次缺岗冲突计算有关的既有承诺（已接受安排 + 其他事件的待确认占位）
  _commitments(teacher, a, { excludeInvitationId = null, excludeAbsenceId = null }) {
    const now = this.clock.now();
    const out = [];
    for (const inv of this.store.invitations.values()) {
      if (inv.teacherId !== teacher.id) continue;
      if (inv.id === excludeInvitationId) continue;
      if (inv.state !== 'pending' && inv.state !== 'accepted') continue;
      const other = this.store.absences.get(inv.absenceId);
      if (!other || other.id === excludeAbsenceId) continue;
      if (other.dayKey !== a.dayKey) continue;
      if (inv.state === 'pending' && now >= other.startsAt) continue;
      out.push({
        startsAt: other.startsAt,
        endsAt: other.endsAt,
        absenceId: other.id,
        invitationId: inv.id,
      });
    }
    return out;
  }

  // “当日”统一按缺岗事件所在地（学校）偏移量划分日历日
  _daySchedule(teacher, a) {
    return teacher.schedule.filter((s) => dayKey(s.startsAt, a.offsetMinutes) === a.dayKey);
  }

  _overlap(x, y) {
    return x.startsAt < y.endsAt && x.endsAt > y.startsAt;
  }

  _distanceToSlot(teacher, commitments, a) {
    const intervals = [...this._daySchedule(teacher, a), ...commitments];
    if (intervals.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(
      ...intervals.map((s) =>
        s.endsAt <= a.startsAt ? a.startsAt - s.endsAt : s.startsAt >= a.endsAt ? s.startsAt - a.endsAt : 0,
      ),
    );
  }

  // 发出队列中的下一份有效邀请；发出前重新校验，不合格者当场跳过
  _promoteNext(a) {
    const now = this.clock.now();
    if (now >= a.startsAt) {
      this._markUncovered(a, 'lesson-started');
      return null;
    }
    for (const entry of a.roster) {
      if (entry.disposition !== 'queued') continue;
      const teacher = this.teachers.get(entry.teacherId);
      const violation = teacher ? this._evaluate(teacher, a, {}) : { reason: 'schedule-conflict', detail: { kind: 'teacher-missing' } };
      if (violation) {
        entry.disposition = 'skipped';
        entry.reason = violation.reason;
        entry.detail = violation.detail ?? null;
        this._audit('candidate-skipped', { absenceId: a.id, teacherId: entry.teacherId, detail: { at: 'promotion', ...violation } });
        continue;
      }
      // 有效期截断到上课时刻：课程一开始，占位就不再有效
      const expiresAt = Math.min(now + a.responseSeconds * 1000, a.startsAt);
      if (expiresAt <= now) {
        this._markUncovered(a, 'lesson-started');
        return null;
      }
      const inv = {
        id: `INV-${a.id}-r${a.round}-${entry.rank}-${Math.random().toString(36).slice(2, 6)}`,
        absenceId: a.id,
        teacherId: entry.teacherId,
        rank: entry.rank,
        round: a.round,
        state: 'pending',
        issuedAt: now,
        expiresAt,
        respondedAt: null,
        invalidateReason: null,
      };
      this.store.invitations.set(inv.id, inv);
      entry.disposition = 'invited';
      entry.invitationId = inv.id;
      a.currentInvitationId = inv.id;
      this._audit('candidate-promoted', {
        absenceId: a.id, invitationId: inv.id, teacherId: inv.teacherId,
        detail: { rank: entry.rank, round: a.round, expiresAt },
      });
      this._audit('invited', {
        absenceId: a.id, invitationId: inv.id, teacherId: inv.teacherId,
        detail: { rank: entry.rank, expiresAt },
      });
      return inv;
    }
    // 候选全部走完仍无人确认：保持 inviting 等待人工指定，直到上课时刻转 uncovered
    a.currentInvitationId = null;
    return null;
  }

  // 使事件名下仍待确认的邀请全部失效
  _invalidatePending(a, { rosterReason, reason, exceptInvitationId = null }) {
    const now = this.clock.now();
    for (const inv of this.store.invitations.values()) {
      if (inv.absenceId !== a.id || inv.state !== 'pending' || inv.id === exceptInvitationId) continue;
      inv.state = 'invalidated';
      inv.respondedAt = now;
      inv.invalidateReason = reason;
      this._markRoster(a, inv.teacherId, { disposition: 'excluded', reason: rosterReason });
      this._audit('invalidated', { absenceId: a.id, invitationId: inv.id, teacherId: inv.teacherId, detail: { reason } });
    }
    a.currentInvitationId = exceptInvitationId ?? null;
  }

  _markRoster(a, teacherId, patch) {
    const entry = a.roster.find((e) => e.teacherId === teacherId);
    if (entry) Object.assign(entry, patch);
  }

  // ---------- 审计与定时器 ----------

  _audit(type, { absenceId = null, invitationId = null, teacherId = null, actor = null, detail = null } = {}) {
    if (!auditTypes.includes(type)) throw new Error(`未知审计类型 ${type}`);
    const rec = {
      seq: this._auditSeq++,
      at: this.clock.now(),
      type,
      absenceId,
      invitationId,
      teacherId,
      actor: actor ?? null,
      detail: detail ?? null,
    };
    this.store.audit.push(rec);
    return rec;
  }

  _respondResult(inv) {
    const a = this.store.absences.get(inv.absenceId);
    return {
      invitation: {
        id: inv.id,
        absenceId: inv.absenceId,
        teacherId: inv.teacherId,
        state: inv.state,
        expiresAt: iso(inv.expiresAt),
        respondedAt: inv.respondedAt ? iso(inv.respondedAt) : null,
      },
      absence: a ? this._absenceView(a) : null,
    };
  }

  // 只为最近一个到期点排一个兜底定时器；即使丢失也有读时惰性结算与显式 sweep
  _armTimers() {
    if (this._timer !== null) {
      this.clock.cancel(this._timer);
      this._timer = null;
    }
    const now = this.clock.now();
    let nextAt = Infinity;
    for (const inv of this.store.invitations.values()) {
      if (inv.state === 'pending') nextAt = Math.min(nextAt, inv.expiresAt);
    }
    for (const a of this.store.absences.values()) {
      if (['reported', 'inviting'].includes(a.state)) nextAt = Math.min(nextAt, a.startsAt);
    }
    if (!Number.isFinite(nextAt) || nextAt <= now) return;
    this._timer = this.clock.scheduleAt(nextAt, () => {
      this._timer = null;
      this.sweep().catch((err) => {
        console.error('到期清理失败:', err);
      });
    });
  }
}

export { absenceStates, invitationStates, skipReasons, assignmentSources, auditTypes } from './domain.js';
