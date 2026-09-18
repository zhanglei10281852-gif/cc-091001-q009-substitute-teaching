// 领域状态名称：全项目（资料包、引擎、HTTP 接口）统一使用这里的枚举
export const absenceStates = ['reported', 'inviting', 'covered', 'uncovered', 'cancelled'];
export const invitationStates = ['pending', 'accepted', 'declined', 'expired', 'invalidated'];
export const skipReasons = ['unqualified', 'schedule-conflict', 'workload-limit', 'already-held'];
export const assignmentSources = ['ranked', 'manual'];

// 候选名单中每位教师的处置位置
export const rosterDispositions = ['queued', 'invited', 'assigned', 'skipped', 'excluded'];

// 审计事件类型：紧急调整的每一步都可追溯
export const auditTypes = [
  'reported',
  'round-opened',
  'roster-built',
  'invited',
  'candidate-skipped',
  'candidate-promoted',
  'accepted',
  'declined',
  'expired',
  'invalidated',
  'manual-assigned',
  'invitation-revoked',
  'absence-cancelled',
  'reopened',
  'covered',
  'uncovered',
  'restart-recovered',
];
