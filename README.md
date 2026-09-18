# 突发缺岗代课接续

学校教务清晨遇到教师突发缺岗时，在学生到校前完成代课接续的 Node.js 后端能力：
依据**学科资质、当日工作量上限、课表冲突与连续授课限制**生成有顺序的候选队列，
按顺序发出**带有效期的临时占位邀请**，接受时原子确认唯一人选，其余邀请立即失效；
拒绝、超时、撤销、二次缺岗、课程已经开始都有明确状态去向，每次调整均留审计痕迹。

仅使用 Node.js 20+ 内置能力（`node:http`、`node:test`），无第三方依赖。
`src/domain.js` 定义状态枚举；`fixtures/absence-context.json` 是脱敏缺岗样例。

## 运行

```bash
npm test                 # 17 项领域 + HTTP 测试
PORT=3000 DATA_FILE=data/state.json node bin/serve.js
```

启动时自动执行一次 `reconcile`：**未过期的占位继续有效，过期项立即清理**。
课程时段携带学校所在地的明确时区偏移（默认 `+08:00`，可用 `SCHOOL_OFFSET_MINUTES` 调整），
邀请有效期一律按绝对时间（epoch）判断，与时区无关。

## 数据

教师名册（由真实运行环境提供，`POST /admin/teachers` 全量替换）：

```json
{
  "id": "T01",
  "name": "林老师",
  "subjects": ["chinese", "ethics"],
  "dailyLoadMinutes": 180,
  "schedule": [
    { "startsAt": "2026-09-19T09:00:00+08:00", "endsAt": "2026-09-19T09:45:00+08:00" }
  ]
}
```

缺岗事件字段：`classRef`、`subject`、`startsAt`、`endsAt`、`responseSeconds`、
`absentTeacherId`（可选；缺岗本人自动排除）。

## 接口

教师身份用 `X-Teacher-Id` 请求头声明（教师端只处理本人邀请，越权返回 403）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/admin/teachers` | 全量导入教师名册 |
| POST | `/absences` | 上报缺岗，立即返回候选队列与首位邀请（201） |
| GET | `/absences` | 教务端：全部接续状态 |
| GET | `/absences/:id` | 教务端：当前状态 + 候选队列（含每人**跳过原因**） |
| POST | `/absences/:id/cancel` | 撤销缺岗（在途邀请失效） |
| POST | `/absences/:id/reopen` | 二次缺岗：已接续事件开启新一轮队列，旧确认者默认排除 |
| POST | `/absences/:id/manual-assign` | 人工指定，`{teacherId, reason}`，**原因必填且仍过冲突校验** |
| GET | `/absences/:id/audit` | 该事件审计链 |
| GET | `/teachers/:id/invitations` | 教师端：**只返回本人待确认（pending）邀请** |
| POST | `/invitations/:id/respond` | `{action: "accept"|"decline"}`（头 `X-Teacher-Id`） |
| POST | `/reconcile` | 主动清理过期项 |
| GET | `/health` | 健康检查 |

### 状态机

```
reported ──► inviting ──接受/人工指定──► covered
                │  ├─ 撤销               │ 二次缺岗(reopen)
                │  └─► cancelled         ▼
                └─ 队列耗尽/开课 ─► uncovered   inviting(round+1)
pending 邀请：接受 accepted / 拒绝 declined / 超时 expired / 他人确认或撤销 → invalidated
```

- **顺序邀请**：同一时刻只有一位教师持有 pending 邀请；拒绝或超时后按队列顺延。
  此前因他人**占位占用、工作量**等动态原因被跳过的候选，在占位解除后会重新评估；
  缺岗本人、资质不符等硬性排除者永不被邀请。
- **原子确认**：接受与"其余 pending 邀请失效"在同一互斥临界区内落盘，
  不会出现两人同时确认。接受瞬间还会用最新数据**再做一次冲突校验**。
- **重复回执幂等**：与终态一致的同动作回执返回既有结果、不改写；相反动作返回 409。
- **开课兜底**：到达 `startsAt` 仍未确认，事件转 `uncovered(reason=course-started)`，
  在途邀请作废，之后任何回执返回 409。

### 冲突规则（`skipReason` / 拒绝原因）

| 原因 | 含义 |
|---|---|
| `unqualified` | 不在该教师可代学科内 |
| `schedule-conflict` | 与本人课程时间重叠，或相邻间隔不足最小课间（默认 10 分钟，即连续授课限制） |
| `already-held` | 本人在该时段持有其他 pending/accepted 占位（防止同时派给两个班），或缺岗本人 |
| `workload-limit` | 计入本人课表与既有占位后，当日分钟数超过 `dailyLoadMinutes` |

候选排序：通过全部硬性校验者，按**当日预计工作量升序**排列（负担少者优先），
工作量相同按教师 id 稳定排序；被跳过者附在队尾并标明原因，供教务端展示。

## 持久化与并发

- `src/store.js`：状态整体落单个 JSON 文件，写临时文件后 `rename` 原子替换；
  所有读改写经一条 Promise 互斥链串行化（单进程内原子性）。
- `src/engine.js`：纯领域逻辑，时钟可注入（测试用）；过期清理是惰性的，
  任何访问都会先跑 `sweep`，无需后台定时器，重启后行为一致。
- 审计日志只追加：`absence-reported/invitation-issued/invitation-declined/
  invitation-expired/invitation-invalidated/absence-covered/absence-reopened/…`，
  含操作人、时间与原因，可通过 `/absences/:id/audit` 追溯。

## 目录

```
src/domain.js   状态枚举（事件/邀请/跳过原因/指定来源）
src/time.js     绝对时间换算、时段重叠、带时区偏移的展示
src/store.js    JSON 原子持久化 + 互斥临界区
src/engine.js   候选排序、冲突校验、邀请状态机、人工指定、审计
src/server.js   HTTP 路由适配
bin/serve.js    启动入口（启动时 reconcile）
fixtures/       缺岗样例与示例教师名册
test/           node:test 测试（基线 1 项 + 领域 15 项 + HTTP 1 项）
```
