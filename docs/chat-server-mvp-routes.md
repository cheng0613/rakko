# chat-server 路由分级：MVP 必需 vs 可以后加

> **目的**：评估自建 chat-server 的最小实现清单。
>
> **依据**（铁律 0）：全部从客户端代码反推，因为服务端仓库
> `xindong/cindy-server` 未开源且接口契约文档不在本仓库。
>
> - 主文件：`apps/desktop/src/main/maker-ipc/chatServer.ts`（4,467 行）
> - 产品规则：`docs/product-rules/bot-group-chat.md`
> - 客户端接入方式：`config/README.md`（`endpoint.dev.json` 可指向本机服务）

---

## 0. 三个前提结论

**前提 1：客户端不用改。**

`config/README.md` 明确 dev 环境支持本机服务：

```json
{"baseUrl":"http://127.0.0.1:3018","auth":"cindy"}
```

这是自建方案成立的关键——只重建后端，不碰 1.8G 客户端。

**前提 2：所有写操作必须幂等。**

客户端有 **49 处**使用 `operationId`。服务端必须按 `operationId` 去重，
否则网络重试会产生重复消息/重复群。**这不是可选优化，是 MVP 必需。**

**前提 3：数据库是 PostgreSQL。**

`docs/dev-rules/chat-server-local-test.md` 明确要求
`pg_config` / `initdb` / `pg_ctl`，并需要对象存储。

---

## 1. 路由总表（按 MVP 分级）

图例：**M** = MVP 必需，**P1** = 第二期，**P2** = 可以不做

### 1.1 身份与资料

| 路由 | 方法 | 级别 | 用途 | 不做会怎样 |
|---|---|---|---|---|
| `/me` | GET | **M** | 当前用户身份 | 客户端无法确认登录态，全部功能不可用 |
| `/actors` | POST | **M** | 创建参与者（human/bot） | 无法把 Agent 拉进群 |
| `/profile/refresh` | POST | P1 | 刷新成员资料 | 头像/昵称不更新，不影响发言 |

**说明**：`/actors` 是 MVP 里容易被忽略但**必需**的——群成员是 actor，
不只人类，Agent 也是 actor。

### 1.2 群（conversation）

| 路由 | 方法 | 级别 | 用途 | 不做会怎样 |
|---|---|---|---|---|
| `POST /conversations` | POST | **M** | 建群 | 核心功能缺失 |
| `GET /conversations/:id/snapshot` | GET | **M** | 群完整快照（room + members + messages + cursor） | 打开群没数据 |
| `PATCH /conversations/:id` | PATCH | P1 | 改群名/群主/设置 | 群不能改名 |
| `POST /conversations/:id/dissolve` | POST | P1 | 解散群 | 无法删除群 |
| `POST /conversations/:id/nickname` | POST | P2 | 群内昵称/头像 | 成员用全局资料 |

**关键**：`/snapshot` 是**唯一的数据入口**。客户端几乎所有读取都走它
（`chatServer.ts:685`、`1377`、`1416`）。MVP 必须把它做对。

### 1.3 消息

| 路由 | 方法 | 级别 | 用途 | 不做会怎样 |
|---|---|---|---|---|
| `POST /conversations/:id/messages` | POST | **M** | 发消息（返回 `SavedChatSend`） | 核心功能缺失 |
| `GET /conversations/:id/messages` | GET | **M** | 分页拉历史 | 翻不到旧消息 |
| `GET /conversations/:id/messages/:msgId` | GET | P1 | 单条消息（引用/补读） | 引用功能失效 |
| `POST .../messages/:msgId/reactions` | POST | P2 | 表情回应 | 无表情 |
| `GET .../messages/:msgId/readers` | GET | P2 | 谁已读 | 无已读详情 |
| `POST /conversations/:id/read` | POST | P1 | 标记已读 | 红点不消（**体验硬伤**） |
| `POST /conversations/:id/mentions/read` | POST | P2 | @ 已读 | @ 红点不消 |

**MVP 的取舍**：`/read` 我认为应该从 P1 提到 **M**。
原因是「未读数不消失」是用户第一眼就发现的 bug，比「不能发表情」严重得多。

**修正后**：`POST /conversations/:id/read` → **M**。

### 1.4 成员与邀请（**这是你的核心需求**）

| 路由 | 方法 | 级别 | 用途 | 不做会怎样 |
|---|---|---|---|---|
| `GET /conversations/:id/members` | GET | **M** | 成员列表 | 看不到谁在群里 |
| `POST /conversations/:id/invite-links` | POST | **M** | 生成邀请链接 | **无法邀请同事** |
| `POST /invite-links/preview` | POST | **M** | 预览邀请（群名/邀请人） | 点链接看不到预览 |
| `POST /invite-links/accept` | POST | **M** | 接受邀请入群 | **无法入群** |
| `POST .../invite-links/revoke` | POST | P1 | 撤销邀请 | 链接不能作废 |

**这四条是你的需求命门**（「邀请同事、邀请团队内 Agent」）。
注意预览接口只返回群名和邀请人不开放历史——这是产品规则。

### 1.5 执行与计划（Agent 干活）

| 路由 | 方法 | 级别 | 用途 | 不做会怎样 |
|---|---|---|---|---|
| `POST /conversations/:id/executions` | POST | **M** | 创建执行（谁跑这次回复） | Agent 不能发言 |
| `POST .../executions/:id/control` | POST | P1 | 中断/继续执行 | 不能停 |
| `GET /conversations/:id/executions` | GET | P1 | 拉执行状态 | 状态不同步 |
| `POST .../executions/:id/mask` | POST | P2 | 隐私脱敏执行 | 无匿名总结 |
| `GET .../execution-failures` | GET | P2 | 失败批次查询 | 失败提示不全 |
| `POST /conversations/:id/plans` | POST | P1 | 分工计划 | 无分工能力 |
| `POST /conversations/:id/plans/:id` | POST | P1 | 计划操作（start/continue/retry） | 同上 |
| `POST .../messages/:id/continue` | POST | P1 | 继续讨论 | 不能「接着说」 |
| `POST .../messages/:id/cancel-planning` | POST | P2 | 取消计划中 | 规划不能取消 |
| `POST .../import/plan-source` | POST | P2 | 导入旧计划 | 迁移场景 |

**MVP 的关键判断**：`POST /executions` 是必需的——**没有它，Agent 不能在群里说话**。

但 `plans`（分工）可以后加。Cindy 的产品分期也是这样：
阶段 1 是「群聊基础」，阶段 2 才是「分工」。

### 1.6 媒体

| 路由 | 方法 | 级别 | 用途 |
|---|---|---|---|
| `GET /conversations/:id/media/:mediaId` | GET | P1 | 取群内图片/文件 |

需要对象存储。MVP 可以先只支持纯文本。

### 1.7 WebSocket

| 事件 | 级别 | 说明 |
|---|---|---|
| `message.created` / `message.updated` / `message.deleted` | **M** | 实时消息 |
| `member.joined` / `membership.changed` | **M** | 入群通知 |
| `read.changed` | P1 | 已读同步 |
| `execution.changed` | P1 | 执行状态 |
| `plan*` | P2 | 分工 |

**MVP 只需要前两类**。没有 WebSocket，用户要手动刷新才能看到新消息——
这个体验不可接受，所以 WS 是 M。

---

## 2. MVP 清单（汇总）

### 必须实现（13 条路由 + WS）

```
POST   /actors
GET    /me
POST   /conversations
GET    /conversations/:id/snapshot
GET    /conversations/:id/members
POST   /conversations/:id/messages
GET    /conversations/:id/messages
POST   /conversations/:id/read
POST   /conversations/:id/executions
POST   /conversations/:id/invite-links
POST   /invite-links/preview
POST   /invite-links/accept
WS     /v1/ws  → message.* / member.*

横切要求：
- operationId 幂等（49 处调用）
- Snapshot 结构完整（room/members/messages/cursor）
- seq 用十进制字符串，禁止经过 JS Number
```

### 第二期（P1，9 条）

```
GET    /conversations/:id/messages/:msgId
PATCH  /conversations/:id
POST   /conversations/:id/dissolve
POST   /conversations/:id/invite-links/revoke
POST   /conversations/:id/plans
POST   /conversations/:id/plans/:planId
POST   /conversations/:id/messages/:msgId/continue
POST   /conversations/:id/executions/:execId/control
GET    /conversations/:id/media/:mediaId
GET    /conversations/:id/executions
WS     read.changed / execution.changed
```

### 可以不做（P2，8 条）

```
POST /profile/refresh
POST /conversations/:id/nickname
POST /conversations/:id/messages/:msgId/reactions
GET  /conversations/:id/messages/:msgId/readers
POST /conversations/:id/mentions/read
POST /conversations/:id/mask
GET  /conversations/:id/execution-failures
POST /conversations/:id/messages/:msgId/cancel-planning
POST /conversations/:id/import/plan-source
WS   plan*
```

---

## 3. 但 MVP 真正的难点不在路由数量

13 条路由听起来不多。**难点在正确性**：

### 3.1 Snapshot 的 5 个字段都有陷阱

```ts
interface Snapshot {
  room: Room;
  members: Member[];
  messages: Message[];     // ← 分页 + 顺序
  cursor: string;          // ← 十进制字符串，不能转 Number
  mentionReadIds?: string[];
  reads?: Array<{ thread_key, read_seq, following, muted, notification_scope }>;
  othersRead?: Array<{ thread_key, read_seq }>;
}
```

**陷阱**：
- `cursor` 是十进制字符串。代码明确要求「计算不得经过不安全的 JS Number」。
  用 `Number(cursor)` 会在超过 2^53 后静默精度丢失 → 消息错乱。
- `messages` 的顺序不能靠 `created_at`（同毫秒会乱），必须用 `seq`。
- 这与我们之前踩过的坑一模一样（H-015：同毫秒排序用 rowid 不用 id）。

### 3.2 执行租约（execution lease）

```ts
interface Execution {
  epoch: number;           // ← 递增代次
  status: string;
  access_mode: 'owner' | 'chat' | 'tools';
  access_revision: number; // ← CAS 版本
  ...
}
```

**为什么需要**：群里有人 @ 一个 Agent，**这个 Agent 的主人可能有多台电脑在线**。
必须保证只有一台执行，否则同一句话被回答两遍。

MVP 可以简化：只允许**发起者自己的设备**执行（不做多设备竞争）。
但即使简化，`epoch` 字段也要存在——客户端会读它。

### 3.3 成员权限矩阵

```ts
Member.role: 'owner' | 'admin' | 'member' | 'guest'
Member.kind: 'human' | 'bot' | 'integration'
```

3 × 2 = 6 种组合，每种能做什么不同。MVP 可以先实现：
- `owner` 全权
- `member` 能发言、能邀请（或不能，看你的策略）
- `bot` 只能通过 execution 发言

但**数据结构必须完整**，否则后续加权限要改表。

---

## 4. 工作量重估（基于 MVP 清单）

| 阶段 | 内容 | 估时（1 人） |
|---|---|---|
| 地基 | PostgreSQL schema、auth（简化 JWT）、HTTP 框架 | 2 周 |
| 核心 | 13 条路由 + Snapshot + 幂等 | 3 周 |
| 实时 | WebSocket + 事件推送 + 重连 | 1.5 周 |
| Agent 接入 | `/actors` + `/executions` + owner 映射 | 1.5 周 |
| **联调** | 反向猜客户端契约、踩坑 | **3–4 周** |
| **合计** | | **约 11–12 周（3 个月）** |

比全量（4–7 个月）少一半，但**联调那 3–4 周省不掉**——那是逆向工程成本。

---

## 5. 三个降低风险的建议

### 建议 1：先做「只读客户端」，验证协议理解对不对

不要一上来写全部。先实现：

```
GET /me
POST /conversations
GET /conversations/:id/snapshot
```

然后让**官方客户端连上你的服务端**，看它能不能正常显示空群。

如果这一步走不通，说明你对协议的理解有根本性偏差，后面全部要返工。
**这一步大约 1 周，能省掉后面 2 个月的盲目开发。**

### 建议 2：`operationId` 幂等用一个表解决

```sql
CREATE TABLE operations (
  operation_id UUID PRIMARY KEY,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

所有写操作先查这张表，命中就直接返回上次结果。
49 处调用靠这一张表统一处理，不要每条路由各写一遍。

### 建议 3：`seq` 用数据库序列，绝不用时间戳

```sql
CREATE SEQUENCE message_seq;
-- 发消息时
SELECT nextval('message_seq');
```

用时间戳排序会在同毫秒并发时错乱——这是我们已经踩过的坑。

---

## 6. 待确认（问用户）

1. **多设备竞争**：MVP 是否允许同一个 Agent 的主人有多台设备在线？
   - 允许 → 需要执行租约（+1.5 周）
   - 不允许 → 只允许发起设备执行（省时，但体验受限）

2. **邀请权限**：`member` 能否邀请新人？
   Cindy 的规则是 owner/admin 才能发邀请链接。

3. **历史策略**：新成员入群能看到多少历史？
   Cindy 有 `history_from` 字段，可选「全部 / 入群后」。
   MVP 建议先做「全部」，简单。

4. **Agent 归属**：团队内 Agent 是绑定某个人的电脑，还是有个公共 Agent 池？
   这决定 `/actors` 的 `owner` 语义。

---

## 7. 【重要修正】服务端有能力声明机制，MVP 可以更小

写完上面的分级后，我在 `chatServer.ts:1042` 发现了**决定性机制**：
`GET /me` 返回的 `capabilities` 对象，**由服务端声明自己支持哪些能力，客户端逐项检查后降级**。

完整清单（13 项）：

```ts
capabilities: {
  messageReaders?: number;            // 已读回执（谁看了）
  groupDiscussionParity?: number;     // 群讨论对齐
  groupSingleSpeaker?: number;        // 单说话人模式
  companionHome?: boolean;            // 伙伴归属
  directRoomClaim?: boolean;          // 直聊房间认领
  groupLifecycleVersion?: number;     // 群生命周期（解散/退出/移除）
  conversationListStateVersion?: number; // 列表状态
  groupMemberAvatar?: number;         // 成员头像
  groupMentionAudiences?: number;     // @ 范围（@全体/@指定）
  groupNotificationSettings?: number; // 通知设置
  workAvailabilityVersion?: number;   // 工作可用性
  workNotificationsVersion?: number;  // 工作通知
  executionExecutor?: number;         // 服务端记录执行位置
}
```

### 这意味着什么

**不声明 = 客户端不调用 = 你不用实现。**

这不是「偷工减料」，是 Cindy 官方设计的兼容机制
（`_v2 增量(版本号不变 —— type 为开放集合, 老端收到未知类型丢帧不断连)`是同一思路）。

### 修正后的 MVP 清单（更小）

```ts
// MVP 服务端只声明这些能力
capabilities: {
  // 全部留空 / 不声明
}
```

**可以整个跳到 P2 的部分**：

| 之前标 P1 | 理由 |
|---|---|
| `GET .../messages/:msgId/readers` | 不声明 `messageReaders` 客户端就不展示已读详情 |
| `POST .../executions/:id/control` | 不声明 `executionExecutor` 就走本地执行 |
| 群生命周期三个路由 | 不声明 `groupLifecycleVersion` 则解散/退出只做本地隐藏 |
| @ 范围控制 | 不声明 `groupMentionAudiences` 则只有基础 @ |

### 那 Supabase 式的 MVP 到底要多少

**真正不可省的只有 9 条**：

```
POST   /actors                    ← Agent 入群的身份
GET    /me                        ← 返回 actor + 空的 capabilities
POST   /conversations             ← 建群
GET    /conversations/:id/snapshot ← 唯一数据入口
GET    /conversations/:id/members  ← 成员列表
POST   /conversations/:id/messages ← 发消息
GET    /conversations/:id/messages ← 拉历史
POST   /conversations/:id/read     ← 已读（否则红点不消）
POST   /conversations/:id/executions ← Agent 发言
POST   /conversations/:id/invite-links   ┐
POST   /invite-links/preview             ├ 邀请同事（你的核心需求）
POST   /invite-links/accept              ┘
WS     /v1/ws（message.* + member.*）
```

### 重估工作量

| 阶段 | 之前 | 现在 |
|---|---|---|
| 核心路由 | 3 周 | **2 周** |
| 实时 | 1.5 周 | 1 周 |
| Agent 接入 | 1.5 周 | 1 周 |
| 联调 | 3–4 周 | **2–3 周**（要实现的少了） |
| **合计** | 约 11–12 周 | **约 8–9 周（2 个月）** |

---

## 8. 修正后的实施顺序

**第 1 步（1 周，验证协议理解）**

```
GET /me          → 返回 { actor, capabilities: {} }
POST /conversations
GET  /conversations/:id/snapshot
```

用官方客户端连 `endpoint.dev.json` 指向你的服务，看能否建群并显示空群。
**这一步走不通就立刻停下重估，不要继续写。**

**第 2 步（2 周，能说话）**

```
POST /actors
POST /conversations/:id/messages
GET  /conversations/:id/messages
POST /conversations/:id/read
```

**第 3 步（1.5 周，实时）**

WS `/v1/ws`，至少推 `message.created`。

**第 4 步（1.5 周，Agent 入群）**

```
POST /actors (kind: 'bot')
POST /conversations/:id/executions
```

**第 5 步（1.5 周，邀请同事）**

邀请链接三件套。

**第 6 步（2–3 周，联调）**

对着真实客户端修。

---

## 9. 结论

- **路由层面**：9 条核心 + WS，2 个月可出可用的 MVP
- **真正的风险**：不是写代码，是**逆向猜客户端契约**
- **降低风险的关键**：第 1 步的一周验证，走不通就停
- **能力声明机制是关键发现**：它让你合法地少做，而不是做一个残缺品

---

## 10. 用户已裁决的四个问题（2026-11-16）

| # | 问题 | 用户决定 |
|---|---|---|
| 1 | 多设备竞争 | **允许**（同一个 Agent 的主人可以有多台电脑在线） |
| 2 | `member` 能否邀请新人 | **能** |
| 3 | 新成员能否看到入群前历史 | **能**（`history_from` = 全部） |
| 4 | Agent 归属模型 | **公共池**（不绑定某个人的电脑） |

### 10.1 决定 1「允许多设备」的代价与做法

**必须有执行租约**。数据模型（对照 Cindy `Execution`）：

```ts
interface Execution {
  id: string;
  conversation_id: string;
  source_message_id: string;   // 哪条消息触发的
  bot_id: string;              // 哪个 Agent 在回答
  requester_id: string;        // 谁 @ 的
  executor_id: string;         // 哪台设备领到了（新增：竞争结果）
  epoch: number;               // 递增代次，防旧设备覆盖
  status: 'pending' | 'running' | 'done' | 'failed';
  access_revision: number;     // CAS 版本
  context_seq: string;         // 上下文截止序号
}
```

**竞争规则（MVP 简化版）**：

```
1. 创建 execution 时 status='pending'，executor_id=NULL
2. 各设备轮询/推送收到 pending 的 execution
3. 第一个原子抢到者胜：
   UPDATE executions SET executor_id=$me, status='running', epoch=epoch+1
   WHERE id=$id AND executor_id IS NULL
   → 影响行数 1 = 抢到，0 = 别人抢了
4. 抢到的设备执行，完成后写 status='done'
5. 心跳超时（如 30s 无更新）允许其他设备接管，epoch+1
```

**为什么用 `WHERE executor_id IS NULL` 而不是先查后写**：
先 `SELECT` 再 `UPDATE` 会有竞态窗口，两台设备同时查到 null 都以为自己赢了。
必须靠**单条 SQL 的原子性**。

**`epoch` 的作用**：设备 A 抢到后卡住，设备 B 接管（epoch=1→2）。
A 恢复后想写结果，发现自己的 epoch=1 < 当前 2，**必须丢弃自己的结果**。
没有这个字段会出现「两条回复」。

### 10.2 决定 2「member 能邀请」的代价

Cindy 的规则是 `canInvite = owner|admin` 才能发邀请（`chatServer.ts:2005`）：

```ts
canInvite: !direct && !s.room.dissolved_at &&
  s.members.some(m => m.ownerActorId === selfId && m.state === 'joined' &&
                     ['owner', 'admin'].includes(m.role))
```

**你要放开成 member 也能邀请**，只需在服务端放宽：

```sql
-- 你的实现
can_invite = member.role IN ('owner', 'admin', 'member') AND member.state = 'joined'
```

⚠️ **注意客户端可能自带限制**：`canInvite` 是服务端返回的字段（在 snapshot 的 room 视图里），
所以只要服务端返回 `canInvite: true`，客户端就会显示邀请按钮。
**这条不需要改客户端。**

### 10.3 决定 3「能看全部历史」的代价

最简单，`history_from` 一律置为群的创建时间（或 0）。

```sql
-- 成员表不需要 history_from 字段，或统一填 NULL 表示"全部"
CREATE TABLE members (
  ...
  -- history_from_seq BIGINT NULL  -- NULL = 全部历史
);
```

过滤历史时：

```sql
SELECT * FROM messages
WHERE conversation_id = $1
  AND seq > COALESCE((SELECT history_from_seq FROM members WHERE ...), 0)
```

**代价**：几乎没有。但要注意——如果将来要加「入群后可见」，这个字段要提前留好。

### 10.4 决定 4「公共池」——这是最关键的设计

我查了 Cindy 的机制，它有两种 Agent 归属模式：

| 模式 | 字段 | 含义 |
|---|---|---|
| 伙伴（companion） | `Actor.homeDeviceId = <设备ID>` | 绑在某人的电脑上，只有那台能跑 |
| 群助手（assistant） | `Member.assistant = true` | **「不属于任何人的群伙伴」** |

Cindy 的原话（`member` 接口注释）：

```ts
/** The group's own Cindy (servers with `groupAssistant`), nobody's companion. */
assistant?: boolean
```

它还有执行规则：

> 执行的 `bot_id = groupAssistantActorId`、`requester_id` 是真人，
> **只有 requester 自己账号的执行器能**（领这次执行）

**这就是你要的「公共池」**，但注意它的语义：

```
公共 Agent + 谁 @ 它，就用谁的电脑执行
```

而不是「有一台公共服务器跑它」。

### 你的公共池建议实现

```sql
CREATE TABLE actors (
  id            UUID PRIMARY KEY,
  kind          TEXT NOT NULL,        -- 'human' | 'bot' | 'integration'
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  avatar        TEXT,
  -- 关键：公共池 Agent 这两个字段都是 NULL
  home_device_id UUID,                -- NULL = 不绑定设备
  owner_actor_id UUID,                -- NULL = 无主（公共池）
  pool_scope    TEXT,                 -- 'team:<团队ID>' | NULL
  disabled      BOOLEAN DEFAULT false
);
```

**执行路由规则**：

```ts
function pickExecutor(execution, requester) {
  const actor = getActor(execution.bot_id);
  if (actor.home_device_id) {
    // 绑定设备的伙伴：只有那台能跑
    return actor.home_device_id;
  }
  // 公共池：用 requester 自己的设备（Cindy 的 assistant 就是这么做的）
  return requester.primary_device_id;
}
```

**为什么这么设计是对的**：

1. **「公共」指的是「谁都能用」，不是「有一台公共服务器」**
   —— 如果要一台公共服务器跑 Agent，那就是云端 Agent 服务，成本模型完全不同
2. 用 requester 的设备执行意味着**工具权限、文件访问都是 requester 自己的**
   —— 符合安全直觉
3. 你不需要为「公共 Agent」单独准备算力

⚠️ **如果用户以为的「公共池」是「部署在服务器上、谁都能调用的 Agent」**，
那和上面是两件事，需要单独确认（见 §11）。

### 10.5 四个决定的合并影响

| 决定 | 增加的工作量 |
|---|---|
| 允许多设备 | 执行租约 +1.5 周 |
| member 能邀请 | 0（服务端放宽一行） |
| 能看全部历史 | 0（但要预留字段） |
| 公共池 | 0.5 周（执行路由 + actor schema） |
| **合计** | **+2 周** |

修订后总量：**约 10–11 周（2.5 个月）**

---

## 11. 一个需要向你确认的歧义

「公共池」有两种完全不同的含义，选错会导致架构方向相反：

### 含义 A：公共身份，各自执行（Cindy 的做法）

```
团队成员 A @ 「研究员」→ 用 A 自己的电脑跑，用 A 的模型和权限
团队成员 B @ 「研究员」→ 用 B 自己的电脑跑，用 B 的模型和权限

「研究员」只是一份统一的 角色定义 + 提示词 + 技能
```

- ✅ 成本：0（不占你的算力）
- ✅ 权限安全：每个请求者用自己的凭据
- ⚠️ 缺点：A 关电脑时 A 的请求跑不了

### 含义 B：公共执行，集中算力

```
任何人 @ 「研究员」→ 都在你的服务器上跑，用你的 API key
```

- ✅ 用户体验最好（永远在线）
- ❌ **成本由你承担**：所有 Agent 的 API 费用都是你的
- ❌ 需要处理：工具执行在哪台电脑？文件怎么访问？
  （如果 Agent 要读写文件，那还是在用户电脑上，又回到含义 A）

### 我的建议

**选含义 A**。理由：

1. Cindy 已经验证了这条路可行（`assistant` 机制）
2. 成本可控——你不会因为用户多而无上限烧 API 额度
3. 「Agent 要操作文件」的场景天然要求它在用户电脑上

**含义 B 只在「纯粹聊天/问答型 Agent」场景下成立**，
一旦涉及工具调用（读文件、跑命令），就必须回到 A。
