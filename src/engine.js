// 紧急代课接续领域引擎。
// 所有公开操作都在 store 的互斥临界区内完成“状态推进 + 落盘”，
// 因此接受邀请的确认与其余邀请的失效是原子的，重复回执不会二次改写。

import { absenceStates, invitationStates, skipReasons } from './domain.js';
import { toEpoch, overlap, describeOffset } from './time.js';

const DAY = 86_400_000;

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

let seq = 0;
function rid(prefix) {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export class SchedulerEngine {
  constructor(store, opts = {}) {
    this.store = store;
    this.now = opts.now ?? (() => Date.now());
    this.defaultResponseSeconds = opts.defaultResponseSeconds ?? 300;
    this.defaultOffsetMinutes = opts.defaultOffsetMinutes ?? 480; // 学校所在地默认东八区
    this.minBreakMinutes = opts.minBreakMinutes ?? 10; // 连续授课之间至少保留的课间间隔
  }

  // ---------- 数据维护 ----------

  async replaceTeachers(teachers, operator = 'system') {
    if (!Array.isArray(teachers)) throw new ApiError(400, 'BAD_TEACHERS', 'teachers 必须是数组');
    for (const t of teachers) this.#validateTeacher(t);
    return this.store.mutate((data) => {
      data.teachers = teachers.map((t) => structuredClone(t));
      this.#audit(data, { type: 'teachers-replaced', operator, detail: { count: teachers.length } });
      return data.teachers.map((t) => ({ id: t.id, name: t.name }));
    });
  }

  // ---------- 缺岗事件 ----------

  async reportAbsence(input, operator = 'duty-office') {
    return this.store.mutate((data) => {
      const now = this.now();
      const absence = this.#buildAbsence(input, data, now);
      data.absences.push(absence);
      this.#audit(data, {
        type: 'absence-reported',
        absenceId: absence.id,
        operator,
        detail: { classRef: absence.classRef, subject: absence.subject },
      });
      this.#sweep(data, now);
      return this.#statusView(data, absence.id, now);
    });
  }

  // 二次缺岗：已确定的代课教师又无法到岗，事件回到邀请阶段并开启新一轮候选队列，
  // 旧确认与旧邀请保留为审计痕迹，新队列默认排除再次缺岗者。
  async reopenAbsence(absenceId, opts = {}, operator = 'duty-office') {
    return this.store.mutate((data) => {
      const now = this.now();
      const absence = this.#getAbsence(data, absenceId);
      if (absence.state !== 'covered') {
        throw new ApiError(409, 'NOT_COVERED', '只有已接续的缺岗才能登记二次缺岗', { state: absence.state });
      }
      if (now >= absence.startsAt) throw new ApiError(409, 'COURSE_STARTED', '课程已经开始，不能重新发起接续');
      const prevWinner = absence.assignedTeacherId;
      for (const inv of data.invitations.filter((i) => i.absenceId === absenceId && i.round === absence.round)) {
        if (inv.state === 'pending' || inv.state === 'accepted') {
          inv.state = 'invalidated';
          inv.invalidReason = 'reopened';
          inv.finalizedAt = now;
        }
      }
      absence.round += 1;
      absence.assignedTeacherId = null;
      absence.assignedInvitationId = null;
      absence.assignmentSource = null;
      absence.state = 'inviting';
      absence.history.push({ at: now, from: 'covered', to: 'inviting', reason: 'reopened', operator });
      absence.excludeTeacherIds = [...new Set([...(absence.excludeTeacherIds ?? []), opts.excludeTeacherId ?? prevWinner].filter(Boolean))];
      absence.candidates = this.#rankCandidates(data, absence, now);
      this.#audit(data, {
        type: 'absence-reopened',
        absenceId,
        operator,
        detail: { round: absence.round, previousTeacherId: prevWinner, excludeTeacherIds: absence.excludeTeacherIds },
      });
      this.#sweep(data, now);
      return this.#statusView(data, absenceId, now);
    });
  }

  async cancelAbsence(absenceId, operator = 'duty-office') {
    return this.store.mutate((data) => {
      const now = this.now();
      const absence = this.#getAbsence(data, absenceId);
      if (absence.state === 'cancelled') return this.#statusView(data, absenceId, now);
      if (absence.state === 'covered') throw new ApiError(409, 'ALREADY_COVERED', '已接续的缺岗不能撤销，请改用二次缺岗登记');
      absence.state = 'cancelled';
      absence.history.push({ at: now, to: 'cancelled', reason: 'manual-cancel', operator });
      this.#invalidatePending(data, absence, 'absence-cancelled', now);
      this.#audit(data, { type: 'absence-cancelled', absenceId, operator });
      return this.#statusView(data, absenceId, now);
    });
  }

  // ---------- 邀请回执 ----------

  async respond(invitationId, teacherId, action, opts = {}) {
    if (!['accept', 'decline'].includes(action)) throw new ApiError(400, 'BAD_ACTION', 'action 只能是 accept 或 decline');
    return this.store.mutate((data) => {
      const now = this.now();
      this.#sweep(data, now);
      const inv = data.invitations.find((i) => i.id === invitationId);
      if (!inv) throw new ApiError(404, 'INVITATION_NOT_FOUND', '邀请不存在');
      if (teacherId !== inv.teacherId) throw new ApiError(403, 'NOT_OWNER', '只能处理发给本人的邀请');
      const absence = this.#getAbsence(data, inv.absenceId);

      // 事件层面的终态优先给出明确去向。
      if (absence.state === 'cancelled') throw new ApiError(409, 'ABSENCE_CANCELLED', '缺岗已撤销，邀请失效');
      if (now >= absence.startsAt || absence.state === 'uncovered') {
        throw new ApiError(409, 'COURSE_STARTED', '课程已经开始，回执不再有效');
      }

      // 重复回执：与邀请终态一致的同动作回执直接返回既有结果，绝不改写；
      // 相反动作或对过期/失效邀请的回执明确报错。
      if (inv.state !== 'pending') {
        const sameAction = (inv.state === 'accepted' && action === 'accept') || (inv.state === 'declined' && action === 'decline');
        if (sameAction) {
          return { ok: false, idempotent: true, invitation: this.#invView(data, inv, absence), outcome: absence.state };
        }
        throw new ApiError(409, 'INVITATION_FINALIZED', '邀请已终态，不能再回执', { invitationState: inv.state });
      }

      if (action === 'decline') {
        inv.state = 'declined';
        inv.declineReason = opts.reason || 'no-reason';
        inv.finalizedAt = now;
        this.#audit(data, { type: 'invitation-declined', absenceId: absence.id, invitationId: inv.id, operator: teacherId, detail: { reason: inv.declineReason } });
        this.#sweep(data, now);
        return { ok: true, invitation: this.#invView(data, inv, absence), outcome: absence.state };
      }

      // 接受前以当前最新数据重新做冲突校验（期间该教师可能已被另一事件占用）。
      const teacher = this.#getTeacher(data, teacherId);
      const conflict = this.#checkConflict(data, teacher, absence, now);
      if (conflict) {
        inv.state = 'invalidated';
        inv.invalidReason = `conflict:${conflict.reason}`;
        inv.finalizedAt = now;
        this.#audit(data, { type: 'invitation-conflict', absenceId: absence.id, invitationId: inv.id, operator: teacherId, detail: { reason: conflict.reason, detail: conflict.detail } });
        this.#sweep(data, now);
        throw new ApiError(409, 'CONFLICT', '接受时冲突校验未通过', { reason: conflict.reason, detail: conflict.detail });
      }

      inv.state = 'accepted';
      inv.finalizedAt = now;
      absence.state = 'covered';
      absence.assignedTeacherId = teacherId;
      absence.assignedInvitationId = inv.id;
      absence.assignmentSource = 'ranked';
      absence.coveredAt = now;
      absence.history.push({ at: now, to: 'covered', reason: 'accepted', operator: teacherId });
      this.#invalidatePending(data, absence, 'winner-confirmed', now, inv.id);
      this.#audit(data, { type: 'absence-covered', absenceId: absence.id, invitationId: inv.id, operator: teacherId, detail: { teacherId, source: 'ranked' } });
      return { ok: true, invitation: this.#invView(data, inv, absence), outcome: 'covered' };
    });
  }

  // ---------- 教务人工指定 ----------

  async manualAssign(absenceId, teacherId, reason, operator = 'duty-office') {
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new ApiError(400, 'REASON_REQUIRED', '人工指定必须填写原因');
    }
    return this.store.mutate((data) => {
      const now = this.now();
      this.#sweep(data, now);
      const absence = this.#getAbsence(data, absenceId);
      if (absence.state === 'cancelled') throw new ApiError(409, 'CANCELLED', '缺岗已撤销');
      if (absence.state === 'covered') throw new ApiError(409, 'ALREADY_COVERED', '该缺岗已有唯一确认人选');
      if (now >= absence.startsAt) throw new ApiError(409, 'COURSE_STARTED', '课程已经开始，不能再安排代课');
      const teacher = this.#getTeacher(data, teacherId);
      const conflict = this.#checkConflict(data, teacher, absence, now);
      if (conflict) throw new ApiError(409, 'CONFLICT', '人工指定未通过冲突校验', { reason: conflict.reason, detail: conflict.detail });

      const existing = data.invitations.find(
        (i) => i.absenceId === absenceId && i.round === absence.round && i.teacherId === teacherId,
      );
      let inv;
      if (existing && existing.state === 'pending') {
        inv = existing;
      } else {
        inv = {
          id: rid('INV'),
          absenceId,
          round: absence.round,
          teacherId,
          rank: absence.candidates.length + 1,
          state: 'pending',
          issuedAt: now,
          expiresAt: Math.min(now + absence.responseSeconds * 1000, absence.startsAt),
        };
        data.invitations.push(inv);
      }
      inv.state = 'accepted';
      inv.finalizedAt = now;
      inv.manual = true;
      inv.manualReason = reason.trim();
      absence.state = 'covered';
      absence.assignedTeacherId = teacherId;
      absence.assignedInvitationId = inv.id;
      absence.assignmentSource = 'manual';
      absence.coveredAt = now;
      absence.history.push({ at: now, to: 'covered', reason: 'manual-assign', operator, detail: { manualReason: inv.manualReason } });
      this.#invalidatePending(data, absence, 'winner-confirmed', now, inv.id);
      this.#audit(data, {
        type: 'absence-covered',
        absenceId,
        invitationId: inv.id,
        operator,
        detail: { teacherId, source: 'manual', manualReason: inv.manualReason },
      });
      return this.#statusView(data, absenceId, now);
    });
  }

  // ---------- 查询 ----------

  async getStatus(absenceId) {
    return this.store.mutate((data) => {
      const now = this.now();
      this.#sweep(data, now);
      return this.#statusView(data, absenceId, now);
    });
  }

  async listAbsences() {
    return this.store.mutate((data) => {
      const now = this.now();
      this.#sweep(data, now);
      return data.absences.map((a) => this.#statusView(data, a.id, now));
    });
  }

  // 教师端：只出现本人、当前仍可确认的邀请。
  async myInvitations(teacherId) {
    return this.store.mutate((data) => {
      const now = this.now();
      this.#sweep(data, now);
      this.#getTeacher(data, teacherId);
      return data.invitations
        .filter((i) => i.teacherId === teacherId && i.state === 'pending')
        .map((i) => {
          const a = this.#getAbsence(data, i.absenceId);
          return this.#invView(data, i, a);
        });
    });
  }

  async auditTrail(absenceId) {
    return this.store.mutate((data) => {
      if (absenceId) {
        this.#getAbsence(data, absenceId);
        return data.auditLog.filter((e) => e.absenceId === absenceId);
      }
      return data.auditLog;
    });
  }

  // 服务重启后调用一次：未过期占位原样保留，过期项在此统一清理。
  async reconcile() {
    return this.store.mutate((data) => {
      const now = this.now();
      this.#sweep(data, now);
      return { reconciledAt: now, absences: data.absences.length, pending: data.invitations.filter((i) => i.state === 'pending').length };
    });
  }

  // ================= 内部实现 =================

  #validateTeacher(t) {
    if (!t || typeof t.id !== 'string' || !t.id) throw new ApiError(400, 'BAD_TEACHER', '教师缺少 id');
    if (!Array.isArray(t.subjects) || t.subjects.length === 0) throw new ApiError(400, 'BAD_TEACHER', `教师 ${t.id} 缺少可代学科`);
    if (!Number.isFinite(t.dailyLoadMinutes) || t.dailyLoadMinutes <= 0) throw new ApiError(400, 'BAD_TEACHER', `教师 ${t.id} 缺少当日工作量上限`);
    for (const l of t.schedule ?? []) {
      toEpoch(l.startsAt, 'schedule.startsAt');
      toEpoch(l.endsAt, 'schedule.endsAt');
    }
  }

  #buildAbsence(input, data, now) {
    const startsAt = toEpoch(input.startsAt, 'startsAt');
    const endsAt = toEpoch(input.endsAt, 'endsAt');
    if (!(endsAt > startsAt)) throw new ApiError(400, 'BAD_SLOT', '课程结束时间必须晚于开始时间');
    const responseSeconds = Number(input.responseSeconds ?? this.defaultResponseSeconds);
    if (!Number.isFinite(responseSeconds) || responseSeconds <= 0) throw new ApiError(400, 'BAD_RESPONSE_WINDOW', '响应时限必须为正数');
    const offsetMinutes = Number(input.offsetMinutes ?? this.defaultOffsetMinutes);
    if (!input.classRef || !input.subject) throw new ApiError(400, 'BAD_ABSENCE', '缺少班级或学科');
    const id = input.absenceId ?? rid('ABS');
    if (data.absences.some((a) => a.id === id)) throw new ApiError(409, 'DUP_ABSENCE', `缺岗事件 ${id} 已存在`);
    const absence = {
      id,
      classRef: input.classRef,
      subject: input.subject,
      startsAt,
      endsAt,
      responseSeconds,
      offsetMinutes,
      absentTeacherId: input.absentTeacherId ?? null,
      state: 'reported',
      round: 1,
      excludeTeacherIds: input.absentTeacherId ? [input.absentTeacherId] : [],
      assignedTeacherId: null,
      assignedInvitationId: null,
      assignmentSource: null,
      coveredAt: null,
      uncoveredReason: null,
      reportedAt: now,
      candidates: [],
      history: [{ at: now, to: 'reported', reason: 'reported' }],
    };
    absence.candidates = this.#rankCandidates(data, absence, now);
    return absence;
  }

  // 有顺序的候选队列：过滤硬性冲突后，按当日已承担工作量升序（工作量相同按 id 稳定排序）。
  #rankCandidates(data, absence, now) {
    const ranked = [];
    const skipped = [];
    for (const teacher of data.teachers) {
      if ((absence.excludeTeacherIds ?? []).includes(teacher.id)) {
        skipped.push({ teacherId: teacher.id, status: 'skipped', reason: 'already-held', detail: 'absent-teacher' });
        continue;
      }
      const conflict = this.#checkConflict(data, teacher, absence, now);
      if (conflict) skipped.push({ teacherId: teacher.id, status: 'skipped', reason: conflict.reason, detail: conflict.detail });
      else ranked.push(teacher);
    }
    const { dayStart } = this.#dayBounds(absence.startsAt, absence.offsetMinutes);
    ranked.sort((x, y) => {
      const lx = this.#projectedMinutes(data, x, dayStart, absence) - this.#projectedMinutes(data, y, dayStart, absence);
      if (lx !== 0) return lx;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    return [
      ...ranked.map((t, idx) => ({ teacherId: t.id, rank: idx + 1, status: 'queued' })),
      ...skipped.map((c, idx) => ({ ...c, rank: ranked.length + idx + 1 })),
    ];
  }

  #checkConflict(data, teacher, absence, now) {
    const fail = (reason, detail = reason) => ({ reason, detail });
    const { startsAt, endsAt } = absence;
    if (!teacher.subjects.includes(absence.subject)) return fail('unqualified');

    for (const lesson of teacher.schedule ?? []) {
      const ls = toEpoch(lesson.startsAt);
      const le = toEpoch(lesson.endsAt);
      if (overlap(startsAt, endsAt, ls, le)) return fail('schedule-conflict', 'own-lesson');
      // 连续授课限制：相邻课程间隔小于最小课间，视为冲突。
      if (le <= startsAt && startsAt - le < this.minBreakMinutes * 60_000) {
        return fail('schedule-conflict', 'consecutive-limit');
      }
      if (ls >= endsAt && ls - endsAt < this.minBreakMinutes * 60_000) {
        return fail('schedule-conflict', 'consecutive-limit');
      }
    }

    // 尚未答复或已确认的其它占位：时间重叠即“同时派给两个班”，禁止；
    // 与占位课相邻但短于最小课间间隔，同样受连续授课限制。
    for (const hold of this.#activeHolds(data, teacher.id, now)) {
      if (hold.absenceId === absence.id && hold.round === absence.round) continue;
      if (overlap(startsAt, endsAt, hold.startsAt, hold.endsAt)) {
        return fail('already-held', `hold:${hold.id}`);
      }
      const gap = hold.endsAt <= startsAt ? startsAt - hold.endsAt : hold.startsAt - endsAt;
      if (gap >= 0 && gap < this.minBreakMinutes * 60_000) {
        return fail('schedule-conflict', `consecutive-hold:${hold.id}`);
      }
    }

    const { dayStart } = this.#dayBounds(startsAt, absence.offsetMinutes);
    const projected = this.#projectedMinutes(data, teacher, dayStart, absence) + (endsAt - startsAt) / 60_000;
    if (projected > teacher.dailyLoadMinutes + 1e-9) {
      return fail('workload-limit', `projected=${Math.round(projected)} limit=${teacher.dailyLoadMinutes}`);
    }
    return null;
  }

  #activeHolds(data, teacherId, now) {
    return data.invitations.filter(
      (i) => i.teacherId === teacherId && (i.state === 'pending' || i.state === 'accepted'),
    ).map((i) => {
      const a = data.absences.find((x) => x.id === i.absenceId);
      return { id: i.id, absenceId: i.absenceId, round: i.round, startsAt: a.startsAt, endsAt: a.endsAt };
    });
  }

  #projectedMinutes(data, teacher, dayStart, excludeAbsence = null) {
    const dayEnd = dayStart + DAY;
    let minutes = 0;
    const clamp = (s, e) => Math.max(0, (Math.min(e, dayEnd) - Math.max(s, dayStart)) / 60_000);
    for (const lesson of teacher.schedule ?? []) {
      minutes += clamp(toEpoch(lesson.startsAt), toEpoch(lesson.endsAt));
    }
    for (const i of data.invitations ?? []) {
      if (i.teacherId !== teacher.id) continue;
      if (i.state !== 'pending' && i.state !== 'accepted') continue;
      if (excludeAbsence && i.absenceId === excludeAbsence.id && i.round === excludeAbsence.round) continue;
      const a = data.absences.find((x) => x.id === i.absenceId);
      minutes += clamp(a.startsAt, a.endsAt);
    }
    return minutes;
  }

  #dayBounds(epoch, offsetMinutes) {
    const shifted = new Date(epoch + offsetMinutes * 60_000);
    shifted.setUTCHours(0, 0, 0, 0);
    const dayStart = shifted.getTime() - offsetMinutes * 60_000;
    return { dayStart, dayEnd: dayStart + DAY };
  }

  // 状态机推进：超时失效、开课兜底、顺序邀请下一位。
  #sweep(data, now) {
    for (const absence of data.absences) {
      if (!['reported', 'inviting'].includes(absence.state)) continue;
      const roundInvs = data.invitations.filter((i) => i.absenceId === absence.id && i.round === absence.round);

      for (const inv of roundInvs.filter((i) => i.state === 'pending' && i.expiresAt <= now)) {
        inv.state = 'expired';
        inv.invalidReason = now >= absence.startsAt ? 'course-started' : 'response-timeout';
        inv.finalizedAt = now;
        this.#audit(data, { type: 'invitation-expired', absenceId: absence.id, invitationId: inv.id, detail: { reason: inv.invalidReason } });
      }

      if (now >= absence.startsAt) {
        const stillPending = roundInvs.filter((i) => i.state === 'pending');
        if (stillPending.length) this.#invalidatePending(data, absence, 'course-started', now);
        absence.state = 'uncovered';
        absence.uncoveredReason = 'course-started';
        absence.history.push({ at: now, to: 'uncovered', reason: 'course-started' });
        this.#audit(data, { type: 'absence-uncovered', absenceId: absence.id, detail: { reason: 'course-started' } });
        continue;
      }

      if (roundInvs.some((i) => i.state === 'pending')) {
        absence.state = 'inviting';
        continue;
      }

      // 没有在途邀请：按候选队列顺序寻找下一位仍合格者。
      // 已收到过邀请（拒绝/超时）的本轮不再打扰；其余候选（含此前因他人占位、
      // 工作量等动态原因跳过者）在当前时刻重新校验，避免跨事件占位解除后被永久漏排。
      const candidates = absence.candidates
        .filter((c) => !roundInvs.some((i) => i.teacherId === c.teacherId))
        .sort((a, b) => a.rank - b.rank);
      let issued = false;
      for (const candidate of candidates) {
        // 缺岗本人、二次缺岗者等硬性排除者不参与重评估。
        if ((absence.excludeTeacherIds ?? []).includes(candidate.teacherId)) {
          candidate.status = 'skipped';
          candidate.reason = 'already-held';
          candidate.detail ??= 'excluded';
          continue;
        }
        const teacher = this.#getTeacher(data, candidate.teacherId, true);
        if (!teacher) {
          candidate.status = 'skipped';
          candidate.reason = 'unqualified';
          candidate.detail = 'teacher-removed';
          continue;
        }
        const conflict = this.#checkConflict(data, teacher, absence, now);
        if (conflict) {
          if (candidate.status !== 'skipped' || candidate.reason !== conflict.reason) {
            this.#audit(data, { type: 'candidate-skipped', absenceId: absence.id, detail: { teacherId: teacher.id, reason: conflict.reason } });
          }
          candidate.status = 'skipped';
          candidate.reason = conflict.reason;
          candidate.detail = conflict.detail;
          continue;
        }
        const inv = {
          id: rid('INV'),
          absenceId: absence.id,
          round: absence.round,
          teacherId: teacher.id,
          rank: candidate.rank,
          state: 'pending',
          issuedAt: now,
          expiresAt: Math.min(now + absence.responseSeconds * 1000, absence.startsAt),
        };
        data.invitations.push(inv);
        candidate.status = 'invited';
        candidate.invitationId = inv.id;
        absence.state = 'inviting';
        issued = true;
        this.#audit(data, {
          type: 'invitation-issued',
          absenceId: absence.id,
          invitationId: inv.id,
          detail: { teacherId: teacher.id, rank: candidate.rank, expiresAt: inv.expiresAt },
        });
        break; // 严格有顺序：同一时刻只有一位在途邀请
      }
      if (!issued) {
        absence.state = 'uncovered';
        const hadAny = roundInvs.length > 0;
        absence.uncoveredReason = hadAny ? 'exhausted' : 'no-candidate';
        absence.history.push({ at: now, to: 'uncovered', reason: absence.uncoveredReason });
        this.#audit(data, { type: 'absence-uncovered', absenceId: absence.id, detail: { reason: absence.uncoveredReason } });
      }
    }
  }

  #invalidatePending(data, absence, reason, now, exceptInvitationId = null) {
    for (const inv of data.invitations) {
      if (inv.absenceId !== absence.id || inv.round !== absence.round) continue;
      if (inv.id === exceptInvitationId || inv.state !== 'pending') continue;
      inv.state = 'invalidated';
      inv.invalidReason = reason;
      inv.finalizedAt = now;
      const candidate = absence.candidates.find((c) => c.invitationId === inv.id);
      if (candidate) {
        candidate.status = 'invalidated';
        candidate.invalidReason = reason;
      }
      this.#audit(data, { type: 'invitation-invalidated', absenceId: absence.id, invitationId: inv.id, detail: { reason } });
    }
  }

  #statusView(data, absenceId, now) {
    const a = this.#getAbsence(data, absenceId);
    const invs = data.invitations
      .filter((i) => i.absenceId === absenceId && i.round === a.round)
      .sort((x, y) => x.rank - y.rank);
    const teacherOf = (id) => {
      const t = data.teachers.find((x) => x.id === id);
      return t ? { id: t.id, name: t.name } : { id, name: null };
    };
    return {
      absenceId: a.id,
      classRef: a.classRef,
      subject: a.subject,
      slot: {
        startsAt: new Date(a.startsAt).toISOString(),
        endsAt: new Date(a.endsAt).toISOString(),
        localStartsAt: describeOffset(a.startsAt, a.offsetMinutes),
        started: now >= a.startsAt,
      },
      responseSeconds: a.responseSeconds,
      state: a.state,
      round: a.round,
      uncoveredReason: a.uncoveredReason,
      assignment: a.assignedTeacherId
        ? {
            teacher: teacherOf(a.assignedTeacherId),
            source: a.assignmentSource,
            invitationId: a.assignedInvitationId,
            coveredAt: new Date(a.coveredAt).toISOString(),
          }
        : null,
      currentInvitation: (() => {
        const p = invs.find((i) => i.state === 'pending');
        return p ? this.#invView(data, p, a) : null;
      })(),
      queue: a.candidates
        .slice()
        .sort((x, y) => x.rank - y.rank)
        .map((c) => {
          // 人工指定等情况下同一教师可能有多条邀请记录，取最新一条。
          const inv = invs.findLast((i) => i.teacherId === c.teacherId);
          return {
            rank: c.rank,
            teacher: teacherOf(c.teacherId),
            status: inv ? inv.state : c.status,
            skipReason: c.status === 'skipped' ? c.reason : null,
            skipDetail: c.detail ?? null,
            invitationId: inv?.id ?? null,
            expiresAt: inv ? new Date(inv.expiresAt).toISOString() : null,
          };
        }),
      history: a.history,
    };
  }

  #invView(data, inv, absence) {
    const teacher = data.teachers.find((t) => t.id === inv.teacherId);
    return {
      invitationId: inv.id,
      absenceId: inv.absenceId,
      round: inv.round,
      teacher: teacher ? { id: teacher.id, name: teacher.name } : { id: inv.teacherId, name: null },
      classRef: absence.classRef,
      subject: absence.subject,
      slot: {
        startsAt: new Date(absence.startsAt).toISOString(),
        endsAt: new Date(absence.endsAt).toISOString(),
        localStartsAt: describeOffset(absence.startsAt, absence.offsetMinutes),
      },
      state: inv.state,
      rank: inv.rank,
      issuedAt: new Date(inv.issuedAt).toISOString(),
      expiresAt: new Date(inv.expiresAt).toISOString(),
      invalidReason: inv.invalidReason ?? null,
      declineReason: inv.declineReason ?? null,
      manualReason: inv.manualReason ?? null,
    };
  }

  #audit(data, entry) {
    data.auditLog.push({
      id: rid('EVT'),
      at: this.now(),
      ...entry,
    });
  }

  #getAbsence(data, id) {
    const a = data.absences.find((x) => x.id === id);
    if (!a) throw new ApiError(404, 'ABSENCE_NOT_FOUND', `缺岗事件 ${id} 不存在`);
    return a;
  }

  #getTeacher(data, id, optional = false) {
    const t = data.teachers.find((x) => x.id === id);
    if (!t && !optional) throw new ApiError(404, 'TEACHER_NOT_FOUND', `教师 ${id} 不存在`);
    return t;
  }
}

export { absenceStates, invitationStates, skipReasons };
