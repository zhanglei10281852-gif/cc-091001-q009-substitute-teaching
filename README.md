# 突发缺岗代课接续

教务值班场景：清晨教师突发缺岗时，值班员必须在学生到校前完成代课接续。本项目提供 Node.js 后端能力，在尊重**学科资质、当日工作量与连续授课限制**的前提下生成候选队列、发出限时邀请并以原子方式确认唯一人选，每次调整全程留痕。

`fixtures/absence-context.json` 是脱敏课表片段；`fixtures/teachers.sample.json` 是教师资料样例。邀请有效期按**绝对时间（epoch 毫秒）**判断，课程时间必须带明确时区偏移量（如 `+08:00`），“当日工作量”按学校所在地日历划分。

## 能力一览

- **候选队列**：缺岗登记后自动建队，按“当日已承诺工作量少 → 距本课时远（更从容）→ 工号”排序；不合格教师不进入队列，跳过原因（`unqualified` / `schedule-conflict` / `workload-limit` / `already-held`）对教务端逐条可见。
- **冲突校验**：学科资质、课表时间重叠、连续授课上限（课间短于 10 分钟视为连堂，阈值可配）、当日课时上限；**待确认占位同样视为临时承诺**，不会把尚未答复的人同时派给两个班。
- **限时占位与原子确认**：同一时刻只有队列首位持有有效邀请，有效期截断到上课时刻。接受在单个操作锁内同步完成状态变更并一次性落盘：唯一人选确认、其余邀请全部 `invalidated`、队列其余候选排除。
- **明确去向**：拒绝→顺位晋升；超时→`expired`→晋升；教务撤销→`invalidated`→晋升；候选走完仍无人确认→保持 `inviting` 等待人工指定；到上课时刻→`uncovered`；课程开始后拒绝应答、人工指定与重新发起。
- **人工指定**：值班员可直接指定教师，但**必须填写原因**，且仍要通过同一套冲突校验，来源记为 `manual`。
- **二次缺岗**：已 `covered`/`uncovered` 的事件可重新开启，历任中选者进入历史并被排除，轮次 +1 重新建队。
- **两个端**：教师端只能查询本人的待确认邀请；教务端查看当前接续状态、候选队列与跳过原因、完整审计轨迹。
- **幂等**：与最终结果一致的重复回执直接重放，矛盾回执驳回且不改写结果；支持客户端 `idempotencyKey`。
- **重启恢复**：状态以追加式 JSONL 持久化；重启后重放，未过期占位继续有效，停服期间到期的项在恢复时清理，恢复动作本身也入审计。

## 状态机

- 缺岗事件：`reported → inviting → covered`，旁支 `uncovered` / `cancelled`；`covered|uncovered` 可经二次缺岗回到 `inviting`。
- 邀请：`pending → accepted | declined | expired | invalidated`（终态不可逆）。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/absences` | 登记缺岗（默认自动建队并发出首邀，`autoInvite:false` 可仅登记） |
| GET | `/api/absences` | 教务端：全部事件及当前接续状态 |
| GET | `/api/absences/:id` | 事件详情：候选队列、跳过原因、当前邀请、最终安排 |
| GET | `/api/absences/:id/audit` | 该事件完整审计轨迹（按序号递增） |
| POST | `/api/absences/:id/rounds` | 对仅登记（reported）的事件开启首轮邀请 |
| POST | `/api/absences/:id/manual-assignment` | 人工指定（body 必填 `teacherId`、`reason`） |
| POST | `/api/absences/:id/cancel` | 撤销缺岗事件 |
| POST | `/api/absences/:id/reopen` | 二次缺岗后重新建队（body 可带 `reason`） |
| GET | `/api/teachers/:teacherId/invitations` | 教师端：本人的待确认邀请 |
| POST | `/api/invitations/:id/respond` | `{teacherId, action: "accept"|"decline", idempotencyKey?}` |
| POST | `/api/invitations/:id/revoke` | 教务撤销某份邀请 |
| POST | `/api/sweep` | 显式清理到期占位 |
| GET | `/health` | 健康检查 |

## 运行与测试

需要 Node.js 20+，无第三方运行时依赖。

```bash
# 测试
npm test

# 启动（真实课表与教师联系信息由运行环境提供）
SUBSTITUTE_TEACHERS_FILE=fixtures/teachers.sample.json \
SUBSTITUTE_DATA_FILE=data/substitute.jsonl \
PORT=3000 TZ_OFFSET_MINUTES=480 \
npm start
```

教师资料文件结构：

```json
[
  {
    "id": "t1001",
    "name": "张老师",
    "subjects": ["chinese"],
    "dailyMax": 4,
    "consecutiveMax": 4,
    "schedule": [
      { "classRef": "CLASS-9B", "startsAt": "2026-09-11T10:00:00+08:00", "endsAt": "2026-09-11T10:45:00+08:00" }
    ]
  }
]
```

## 代码结构

- `src/domain.js`：事件、邀请、队列处置、审计类型的统一枚举
- `src/engine.js`：核心领域引擎（建队、校验、占位、原子确认、过期结算、二次缺岗、恢复）
- `src/store.js`：追加式 JSONL 存储（重放恢复、定期压缩）
- `src/clock.js`：时钟抽象（生产真实时钟，测试可推进的假时钟）
- `src/http.js` / `src/server.js`：无依赖 HTTP 接口与启动入口
- `test/`：24 个测试，覆盖全部状态去向、幂等、并发、重启与端到端链路
