# dsh-todo-continuation

[English](README.md) | [Русский](README.ru.md) | [简体中文](README.zh.md)

DeepSeek Harness（DSH）的 Todo 门禁与提示插件：在 `agent/turn-stopping` 边界依据
当前 turn 的最新 `todo/write` 快照决定是否放行结束，并在已有 Todo 列表长期
未更新时提醒模型刷新它。是否创建 Todo 列表由模型自行决定——插件不会推动它
规划；但列表一旦存在，插件就不会让模型把它晾在一边。间隔与提示文本均可在
Web 设置页配置，保存后下一轮立即生效。

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，
> 完整的自研插件索引见该仓库。

## 两分钟验证

1. 重启 DSH——运行中的进程持有旧代码，不重启就什么都不会变。
2. 打开 **设置 → Todo Gate**，打开 **Log every decision**（其他不用动）。
3. 在聊天里说：「为任务 X 建一个三项目的 todo 清单。只把第一项标成已完成，
   别的什么都别做。」
4. 应该看到的现象与含义：
   - 模型无法结束回合，会收到关于未完成项的消息——这是**停止门禁**；
   - 当上下文被压缩（或清单连续几回合没被更新）时，模型会收到带清单本体的
     “Automated note: …”——这是**提醒**；
   - 宿主日志里每个决策一行：`[todo-continuation] … at=stop-boundary …`，带原因
     `prompt:…` / `skip:…` / `gate:…`。没有行 = 插件没挂载；有行 = 为什么沉默一目了然。
5. 不想再被管：把 **Stale-todo prompt interval** 设为 0、**Stop-gate vetoes per
   turn** 设为 0，两者都会消失。

对着真实会话日志的自动检查（不需要模型和聊天）：

    node test/verify-live.mjs --since "2026-09-09T11:05:00"

读取 `~/.dsh/sessions`，统计已投递的提醒、否决与压缩，并对该时刻之后的事件强制
执行契约；`--explain` 逐回合打印决策，`--id <id片段>` 只看一个会话。

## 全部设置（设置 → Todo Gate）

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| Stale-todo prompt interval | 5 | 清单这么多回合没更新就提醒；0 = 关 |
| Stop-gate vetoes per turn | 2 | 一个回合因未完成项被打回多少次；0 = 关；上限 10 |
| Gate subagents too | 开 | 对委派会话同样否决 |
| Hand the list back after a compaction | 开 | 压缩后立即交回清单 |
| Post-compaction prompt text | 内置 | 压缩后交回的文本 |
| Stale-todo prompt text | 内置 | 提醒文本（必须含 `{n}`） |
| Log every decision | 关 | 插件每个决策往日志写一行 |
| Per-list reminder cap | 0 | 对同一份未变更清单提醒 N 次后就安静，直到清单被改写；0 = 一直提醒 |

## 功能

1. **停止门禁（带上限）**：当前 turn 存在未完成 todo 时，turn 无法结束——被阻止的
   停止尝试会收到一条继续消息，模型在同一 turn 内继续推进。自 v0.2.0 起
   **不再有任何标记例外**：以 `[WAITING_USER]`、`[INFO_NEEDED]` 或其他任何
   前缀开头的 todo 依然是未完成项，依然阻止结束。当且仅当当前 turn 快照中所有
   todo 都已完成，或者该 turn 已用完 `gateMaxSteersPerTurn` 次否决额度（v0.5.0），
   才允许结束。上限正是防止模型收不了的清单把 turn 无限拖下去：没有它，一次
   停止边界可能在同一 turn 内被否决上百次。
2. **过期 Todo 提示**（建议性）：当会话的**现行** Todo 清单——durable 会话日志里
   最后一条 `todo/write`——仍含未完成项且已连续
   `staleTodoPromptEveryNTurns`（默认 5）轮没有被重写时，插件注入 advisory
   **并把清单本身渲染进去**，让模型在 compaction、恢复会话或宿主重启之后仍能
   把它接回去。`{n}` 是实际空闲轮数。`0` 关闭该提示。
3. **压缩后交回清单**（v0.6.0）：会话日志里出现 `compaction/summary` 记录，意味着模型
   刚刚丢掉它正在执行的那份计划副本。只要常驻清单还有未完成项，就立即把它交回去，
   不再等空闲间隔；每个 `compactionId` 只提醒一次。压缩失败（从未写出 summary）不算
   触发条件。
4. **回合中投递**（v0.6.0）：同一条提示还会作为附加上下文挂到下一个工具结果上，因此
   不再依赖回合走到 stop 边界。因供应商报错（429）、被取消、或在回合仍打开时又发来新
   消息而死掉的回合根本到不了那条边界——这正是「只在边界提醒」会整段沉默的原因。
   回合中通道只添加上下文：它从不否决，自身出错时把已定的工具决策原样放行。
5. **可见通知**（v0.6.0）：每次注入都声明为 `notice` 并带一行摘要，Web 客户端会在
   转录中把它显示为一行折叠通知（“todo-continuation: …”）——插件的工作不仅模型
   看得到，你也看得到。
6. **单清单上限为可选**（v0.6.0）：默认情况下，只要清单未变更，提醒就会按间隔不断
   重复——与原版插件一致。嫌吵就设置“Per-list reminder cap”：对同一清单提醒 N 次后
   插件会安静下来，直到清单被改写或发生新的压缩（进入安静模式会在宿主日志中以
   `info` 级别记录一次，而非 `debug`）。

空闲程度在检查时从会话日志读出，而不是从本进程碰巧看到了什么推断：重启后恢复的
会话与从未中断的会话判断方式完全一致。（v0.5.0 之前，「有没有清单」来自内存里的
计数器，每次重启归零，所以真实会话里这条提示几乎从不触发。）内存里只保留提示
冷却与当前 turn 的否决计数，它们丢失的代价至多是一条多余提醒。

插件绝不创建、删除、完成或改写 Todo——列表的唯一作者仍是模型，插件也不推动
模型去规划：从未有过 `todo/write` 的会话不会收到任何提示（无 Todo 提示已于
v0.4.0 移除），全部条目已完成的清单同样不会——没有可恢复的东西。该提示是
建议性的（本身不阻止结束），且每间隔最多触发一次，避免每轮催促。

## 停止门禁不变式

> 在每个 `agent/turn-stopping` 事件上，门禁要么在当前 turn 的 `todo/write`
> 快照中找到零个未完成 todo，要么注入一条继续 steer——直到该 turn 的否决额度
> （`gateMaxSteersPerTurn`，0 = 永不否决）用完才放行结束，触顶会记入日志。
> 门禁不抛异常、不越过用户取消（abort 按设计绕过停止边界），
> 且只读取自己会话的 todo。

门禁阻止停止时，模型被告知：完成 todo，或在需要用户输入时调用
`ask_user_question`——等待中的问题在当前 step *内部*暂停 turn，因此不会触发
门禁。runtime 拥有的子代理不能向用户提问（`DELEGATED_CALLER`）；被阻塞的
子代理必须把未决问题写入自己的最终结果。用户的取消仍是硬逃生口：取消永远不会
经过门禁。

## 组成

- `index.js`（宿主端）：注册 `todo-continuation` 设置命名空间，实现带上限的
  stop 门禁，以及从会话日志推导出的常驻清单提示；投递走 `agent/turn-stopping`
  **和**回合中的 `tools/post-execute` 附加上下文。无外部依赖；`schemastery` 在
  `apply()` 内动态导入，任何失败都退回内置默认值——并且大声报告，因为静默降级的间隔
  与一个什么都不做的插件无法区分。
- `client.js`（浏览器端）：渲染设置页里的 “Todo Gate” 区块——间隔、每回合否决上限、
  压缩后交回开关及其文本、过期提示文本，以及决策日志开关——外加对话输入行里
  常驻可见的状态芯片（见「状态芯片」）。
- `cordis.patch.yml`：声明 `dsh-todo-continuation` 插件行。
- `package.json`：`@doiiarx/dsh-todo-continuation` 包清单，声明 `dsh.client`
  注入与 `schemastery` 依赖。

## 安装接线

插件目录需要装依赖（宿主端在 `index.js` 里 `import('schemastery')`）：

```sh
cd <本插件目录>
pnpm install
```

### 1. 挂进 web profile

在 `$HOME/.dsh/profiles/web/package.json`：

```json
{
  "dependencies": {
    "@doiiarx/dsh-todo-continuation": "github:zhihus/dsh-todo-continuation-en"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@doiiarx/dsh-todo-continuation"
      ]
    }
  }
}
```

然后在 profile 目录 `pnpm install`。

### 2. 把命名空间暴露给浏览器设置页

浏览器的设置页要读到 `todo-continuation` 命名空间，必须把它加进宿主 apiproxy 的
设置白名单 `WEB_SETTINGS_NAMESPACES`（`packages/host/apiproxy/src/api-proxy.ts`）：
否则设置页会一直显示「正在读取配置…」（命名空间未暴露给客户端）。

```ts
const WEB_SETTINGS_NAMESPACES = [
  'agent-loop', 'shell', 'locale', 'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek',
  // ...本地插件命名单...
  'todo-continuation',
] as const
```

改完重 build apiproxy（`pnpm run build:lib:host`）并重启 web 进程。

> **注**：已安装的 DSH v0.1.1-rc.2（npm）的 apiproxy 没有硬编码白名单——它通过
> `settings.describe()` 动态暴露所有已注册的命名空间。步骤 2 可能不需要。

## 配置

在设置页「Todo 门禁」小节可编辑：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `staleTodoPromptEveryNTurns` | 5 | 常驻清单连续多少个回合没有被重写后把清单交还给模型；0 = 关闭。清单被闲置超过间隔的 20 倍就是被放弃的工作：间隔提醒会自行停止（`skip:too-old`），而压缩仍会交回清单 |
| `gateMaxSteersPerTurn` | 2 | 一个回合因未完成 todo 被打回多少次后才放行停止；0 = 门禁永不否决；上限 10 |
| `gateSubagents` | true | 是否对委派的（subagent）会话同样否决；设为 `false` 就不再打回子代理，但仍会把清单作为上下文交给它 |
| `maxPromptsPerList` | 0（不设上限） | 对同一个未变化的清单提示这么多次后，插件就对其安静下来，直到清单被重写或新的压缩落地；进入安静态会在日志记一次 `info` |
| `promptAfterCompaction` | true | 压缩一落地就把清单交回去，不等间隔 |
| `compactionPromptTemplate` | 内置默认 | 压缩后交回的文本；不要求任何占位符 |
| `staleTodoPromptTemplate` | 内置默认 | 过期提示文本；必须包含 `{n}` |
| `logDecisions` | false | 每个边界和每个工具结果往宿主日志写一行：做了什么，或为什么沉默 |

设置页的八个字段名为 **“Stale-todo prompt interval”**、
**“Stop-gate vetoes per turn”**、**“Gate subagents too”**、**“Hand the list back after
a compaction”**、**“Post-compaction prompt text”**、**“Stale-todo prompt text”**、
**“Per-list reminder cap”** 和 **“Log every decision”**。

所有阈值都在用时从 settings 文档读取，所以在设置页保存后下一个边界就生效，无需重启。

## 决策日志写什么

打开 `logDecisions` 后，每个边界和每个工具结果各产生一行：

```
[todo-continuation] session "…" turn 12 at=stop-boundary skip:idle 2<5
[todo-continuation] session "…" turn 12 at=mid-tool-result prompt:compaction id=9458… idle=1
[todo-continuation] session "…" turn 12 at=stop-boundary gate:block unfinished=1/3 vetoes=1/2
[todo-continuation] session "…" turn 12 at=stop-boundary gate:cap-reached unfinished=1 vetoes=2/2 allow-stop
```

你会看到的原因：`prompt:compaction`、`prompt:stale`、`gate:block`、
`gate:cap-reached`、`gate:off`、`gate:allow`、`gate:skipped subagent`，以及跳过原因
`no-list`、`no-unfinished`、`interval-off`、`no-write-turn`、`idle N<cfg`、
`cooldown N<cfg`、`too-old idle N`（被放弃工作的地平线）、`quiet`（上面的单清单
上限）。这就是
「插件死了」与「还没到点」之间的区别——否则只能去翻压缩过的会话日志。

## 状态芯片

宿主的 todo 面板跟随 turn-local 的 `todos` 投影，在每个 `turn/start` 都会清空
（应用重启后也会一直为空，直到模型下一次 `todo_write`——为什么这是宿主侧的缺口，
见 `UPSTREAM.md`）。插件自带的常驻答案是：对话输入行里、紧挨 composer 的
**「Todo Gate」芯片**。

芯片对当前会话显示：

- 常驻清单计数——`2/3 unfinished`（未完成）或全部完成时的 `3/3 done`；
- 闲置回合数（`idle 1t`）——距清单上次被重写经过了多少个回合边界；
- 插件的最后一个动作——`reminded 10:38`（已提醒）、`restored after compaction
  11:03`（压缩后已恢复）、`restored after resume 09:32`（重新打开后已恢复）或
  `gate sent the turn back 10:37`（门禁打回了回合）。

「Restored」就是恢复环路的可见证明：压缩后交回按签名文案判定；提醒若落在一个
长时间静默（关机/重新打开的间隔 ≥ 3 分钟）之后打开的回合里，则判定为 resume 后
恢复。芯片通过公开的 `session.history` 通道从会话日志的持久尾部推导这一切——
一个刻意忽略 `turn/start` 的持久 backscan，与面板不同。它只读且 fail-open：
任何读取或解析错误只是隐藏芯片，绝不会阻塞对话。面板本身的定点修复见
`UPSTREAM.md`。

## 提示模板（占位符契约）

过期 advisory 有一个可编辑模板。其默认文本要求模型对最旧的未完成项迈出具体一步，
或者重写/清空已经与工作实际不符的清单——并且把清单本身带进消息，因为 DSH 在每个
`turn/start` 都会清掉现行计划，compaction 之后的上下文里可能根本没有它的副本。

| 模板 | 占位符 | 替换值 | 必需 |
| --- | --- | --- | --- |
| `staleTodoPromptTemplate` | `{n}` | 现行清单**实际**多少轮没有被重写 | 是 |
| `staleTodoPromptTemplate` | `{todos}` | 现行清单，每项一行 `- [status] content`（最多 30 项，每项 200 字符） | 否 |
| `staleTodoPromptTemplate` | `{total}` | 现行清单的条目数 | 否 |
| `staleTodoPromptTemplate` | `{unfinished}` | 状态不是 `completed` 的条目数 | 否 |

契约：

- 替换是字面替换：`{n}` 的每一次出现都替换为间隔值（重复的 `{n}` 全部替换）。
  不使用模板引擎。
- **缺少 `{n}` 的模板无法保存。** 设置 schema 强制执行
  （`Schema.string().pattern(/\{n\}/)`）：设置页预校验草稿，只写入有效的模板；
  任何通过设置基础设施的写入都会在持久化之前经过 schema 校验。未知占位符
  （如 `{foo}`）是允许的，会原样发送。
- 占位符必须写作 `{n}`——`{ n }`（带空格）不匹配并被拒绝；`{{n}}` 通过 schema，
  经普通字面替换处理、无特殊逻辑（如 `{{n}}` 渲染为 `{5}`）。
- 间隔为 `0`（advisory 关闭）时完全不使用模板。
- 默认值逐字节复现 v0.3.0 之前的硬编码文本；只要不编辑模板，发送的消息不变。
- 如果手动编辑的 `settings.yaml` 中包含无效模板，命名空间注册会失败，插件降级
  到全部内置默认值（包括间隔）并输出诊断日志——修复或删除该行以恢复用户覆盖。

### 压缩后模板

`compactionPromptTemplate` 接受与过期模板相同的占位符——`{todos}`、`{total}`、
`{unfinished}` 和 `{n}`（自清单最后一次写入起的回合数）——但**不强制任何一个**。
两个模板共享同一条保证：文本里没有 `{todos}` 时，渲染出的清单照样追加在下方，因为
看不到计划的提醒算不上提醒。

### 升级说明（0.1.0 → 0.2.0）

- 标记等待协议（`waitingTodoPrefixes`、`[INFO_NEEDED]`、`[WAITING_USER]`）
  已**移除**。字段已从 schema 和 UI 中删除；用户设置文件中残留的旧值在运行时
  会被直接忽略（未知键会透传 schemastery 解析），可随意删除。
- 无 Todo 提示的默认值从 5 改为 **0（关闭）**。如果用户设置文件固定了
  `noTodoPromptEveryNTurns`，用户层会覆盖新默认值——请显式设为 `0`（或删除
  该行）以采用新行为。
- 门禁不再识别等待前缀：只要存在未完成 todo，模型唯一的出路是完成它们，或
  通过 `ask_user_question` 提问。

### 升级说明（0.2.0 → 0.3.0）

- advisory 提示文本成为可编辑设置（`noTodoPromptTemplate`、
  `staleTodoPromptTemplate`）。**无需迁移**：没有新键的配置会获得默认值，
  这些默认值与 v0.2.0 的文本完全一致。

### 升级说明（0.3.0 → 0.3.1）

- 设置页标签改为按触发条件命名：「No-todo prompt interval/template」→
  「If there is no todo list: interval (turns) / prompt text」；
  「Stale-todo prompt interval/template」→「If the todo list is not updated:
  interval (turns) / prompt text」。**仅界面变更**：配置键、默认值与 schema
  均未改动——无需迁移。

### 升级说明（0.3.1 → 0.4.0）

- **无 Todo 提示已整体移除**，连同其设置（`noTodoPromptEveryNTurns`、
  `noTodoPromptTemplate`）与界面字段。插件不再催促模型创建 todo 列表：完全没有
  `todo_write` 的会话不会收到任何提示。**无需迁移**：用户 settings.yaml 中残留
  的键会在运行时被直接忽略（同 0.2.0 移除的 `waitingTodoPrefixes`），可随意删除——
  自 0.6.0 起它们还会在挂载时于宿主日志中被点名一次。
- 过期 Todo 提示保持不变——触发条件、计数器、`todo_write` 重置、turn 去重、
  冷却与默认文本。设置页字段现名为 **「Stale-todo prompt interval」** /
  **「Stale-todo prompt text」**。

### 升级说明（0.4.0 → 0.5.0）

- **过期提示现在熬得过重启。**「会话是否有现行清单、它空闲了多久」改为从
  `turn/start` / `todo/write` 历史回答，而不是内存计数器，因此恢复会话或重启宿主
  不再把插件重置成“这里从未规划过”——这正是真实会话里提示几乎不触发的原因。
- **提示会带上清单**（新的 `{todos}` / `{total}` / `{unfinished}`），且 `{n}`
  渲染真实空闲轮数而不是配置的间隔。你自己保存过的模板照常工作——只是不含清单；
  清空该字段即可换回新的默认文本。
- **全部完成的清单不再被唠叨。**提示至少需要一个非 `completed` 条目；用空的
  `todo_write` 清空清单同样终止提醒。
- **门禁有了上限**：新的 `gateMaxSteersPerTurn`（默认 2，0 = 关闭门禁）。想要
  过去那种无限否决循环就调高它——真实会话日志说明了它的结局（单个 turn 约 150
  次否决，一个多小时的 token）。
- `DEFAULT_STALE_EVERY` 从 20 降到 5，settings 注册失败改为大声报告。
- 无需迁移：设置文件里残留的 `noTodoPromptEveryNTurns` 会被忽略（随时可删）。

### 升级说明（0.5.0 → 0.6.0）

- **常驻清单多了两个触发器。**落地的压缩立即交回清单（`promptAfterCompaction`，默认
  开启，独立可编辑文本），提示现在也会作为工具结果的附加上下文在回合中送达，不再
  需要 stop 边界。
- **`logDecisions`**（默认关闭）为每个边界和每个工具结果打印一行原因——见「决策日志
  写什么」。在报告「它不响」之前先打开它。
- **`gateMaxSteersPerTurn` 上限收紧为 10**；早期版本删掉的设置键
  （`noTodoPromptEveryNTurns`、`noTodoPromptTemplate`、`waitingTodoPrefixes`）现在会
  在日志里点名一次，而不再被静默忽略。
- **模板漏写 `{todos}` 时清单会被自动追加**，编辑过的提醒不可能弄丢计划。
- **提醒不再自动安静**：「两次提醒后沉默」改为可选设置“Per-list reminder cap”（默认 0 = 永不安静）。
- **每次注入都是转录里的可见通知**（`notice` + 一行摘要）。
- **`gateSubagents`**（默认 `true`）决定是否否决委派的会话。委派身份读 durable 会话头
  （`origin`、`delegationDepth`），兜底是日志里的 `subagent/descriptor` 事件；认不出的形态
  按顶层会话处理，所以字段缺失不会让门禁失效。
- **`UPSTREAM.md`** 是给 DSH 内核的提案：宿主在每个 `turn/start` 清空 `todos` 投影，
  而最后一份快照就在日志里。门禁只作用于当前回合、`readStandingTodos` 要遍历日志，
  都是因为这道缝隙。
- **开发流程**：`npm run verify` = 两侧语法检查 + 全量测试。插件可以在 profile 的
  `cordis.patch.yml` 里以 `link:<路径>` 挂载，而不是往 `node_modules` 拷文件，这样
  「我同步了没有」这个问题根本不会出现。
- 无需迁移：现有配置继续有效，并获得新的默认值。

### 升级说明（0.6.0 → 0.7.0）

- **`maxPromptsPerList` 已补进文档，提醒不再无界。** 单清单上限随 0.6.0 发布，
  但三份 README 都没写它，默认还是 `0`（永不安静——每个间隔都提醒）。现在它已进
  设置表。**被放弃工作的地平线**在不拿走旋钮的前提下约束默认行为：清单被模型
  连续闲置超过 20 × `staleTodoPromptEveryNTurns` 个回合后，间隔通道不再交回
  （`skip:too-old idle N`）；压缩后的交回刻意不受地平线限制。地平线是常量，
  不是设置。
- **重复注册 namespace 不再降级。** 如果插件已被另一处挂载（热重载、bundle 双
  条目）注册过同一命名空间，第二处挂载会通过 `settings.get(ns)` 读取现役注册，
  而不是退回内置默认。
- **停止边界 fail-open。** 插件在停止边界的 bug 现在与回合中段一样被隔离：
  错误进宿主日志，回合不加否决地结束，而不是变成 `turn/end` 错误、毁掉用户的
  回合。重放日志里畸形的 `todo/write` 记录会被忽略，而不是击溃读取。
- **模板替换改为单遍**：todo 内容（模型自己写的文本）里的 `{placeholder}` 不会再
  被后续键的替换改写；自定义模板把 `{todos}` 放在其他占位符前面时，列表也不再
  重复。
- **schema 依赖换到宿主的 fork**（`@deepseek-ai/schemastery`）——解析设置 schema
  的正是宿主运行的代码，profile 里不再有两份分叉的 schemastery。
- **声明 `engines: node >=22.3`**（实时审计用到 `zlib.zstdDecompressSync`）；
  `crypto.randomUUID` 改为从 `node:crypto` 导入。
- **设置页**：否决输入框的上限与宿主钳制一致（10），存储的超限值按钳制值显示；
  namespace 不可用时显示明确的只读状态，而不是永远的「Loading configuration…」；
  删除了宿主构建中没有消费方的 `__DSH_SETTINGS_SEARCH__` 注册与未使用的
  `connection`/`remote` 注入。
- **长会话更快**：站立清单对会话日志的折叠改为增量式（每次检查只扫新事件），
  不再是每个工具结果都完整遍历日志。
- **CI 与类型**：`pnpm run types`（对两端与测试跑 tsc checkJs），以及 GitHub
  Actions workflow 在 Node 22 上跑 `verify` + `types` + 审计自测。
- **实时审计（`npm run verify:live`）默认强制契约**：提示携带清单（A）、单清单
  上限（B）、否决上限（C）、压缩后交回（D）——每项检查从其特性确实存在的地平线
  开始（B/C/D 看交付文案），按一行 `source.summary` 分类交付、消息形状兜底，
  并提供无需实时日志的 `--selftest`。
- 无需迁移：现有配置继续工作；想要 schema 一直支持的最严格退避，设
  `maxPromptsPerList: 2` 即可。

## 发布策略

从**下一个**版本起，每个发布都会打标签：

1. 提升 `package.json` 的 `version`（semver：仅界面/文档变更 → patch，新增
   设置或行为变更 → minor）。
2. 以 `release:` 前缀提交，并附简短说明。
3. 在发布提交上打附注标签并显式推送：`git tag -a vX.Y.Z -m "vX.Y.Z: summary"`，
   然后 `git push en vX.Y.Z`——单独的 `git push` 不会推送标签。
4. 标签将发布固定为可安装的 ref
   （`github:zhihus/dsh-todo-continuation-en#vX.Y.Z`），并显示在 GitHub
   Releases 页面。

v0.3.1 及更早的版本只在 `package.json` 中记录版本，没有标签。

## 说明

- 门禁消息来源为 `{ kind: 'plugin', plugin: 'todo-continuation' }`，注入的
  `user/message` 可从会话日志重建。
- 用户的取消（`agent.cancel`）与终态 turn 错误在停止边界前中止，绝不会被门禁
  覆盖——取消仍是「模型永远不完成时结束该 turn」的唯一逃生口。
- Plan mode 可以合法地在 todo 未完成时结束 turn；`exit_plan_mode` 在工具调用
  内部阻塞（等待用户），计划评审不会触发门禁。门禁只读取执行代理自己的会话
  ——子代理的 todo 列表对它不可见。
- 若同时以多行挂载本插件（如 base bundle + agent preset），会注册多个监听器并
  可能在一个停止边界入队多条消息；每个组合只挂载一次。
