# dsh-todo-continuation

[English](README.md) | [Русский](README.ru.md) | [简体中文](README.zh.md)

DeepSeek Harness（DSH）的 Todo 门禁与提示插件：在 `agent/turn-stopping` 边界依据
当前 turn 的最新 `todo/write` 快照决定是否放行结束，并对「长期不用 Todo」和
「长期不更新 Todo」给出建议性提示。两个间隔和两条建议性提示的文本均可在 Web
设置页配置，保存后下一轮立即生效。

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，
> 完整的自研插件索引见该仓库。

## 功能

1. **硬停止门禁**：当前 turn 存在未完成 todo 时，turn 无法结束——每次被阻止的
   停止尝试都会注入一条继续消息，模型在同一 turn 内继续推进。自 v0.2.0 起
   **不再有任何标记例外**：以 `[WAITING_USER]`、`[INFO_NEEDED]` 或其他任何
   前缀开头的 todo 依然是未完成项，依然阻止结束。只有当当前 turn 快照中所有
   todo 都已完成时，才允许结束。
2. **无 Todo 提示**（建议性）：连续 `noTodoPromptEveryNTurns` 轮没有任何 todo
   快照时，发送无 Todo advisory 模板（`{n}` 替换为间隔值）。**默认 `0` = 关闭**
   ——该提示本身会推动模型创建 todo 列表，与「todo 仅用于多步工作」的策略相悖；
   需要时在设置页显式设置间隔。
3. **过期 Todo 提示**（建议性）：已有 todo 列表却连续
   `staleTodoPromptEveryNTurns`（默认 20）轮不更新时，发送过期 advisory 模板
   （`{n}` 替换为间隔值）。`0` 关闭该提示。

插件绝不创建、删除、完成或改写 Todo——列表的唯一作者仍是模型。两条提示都是
建议性的（本身不阻止结束），且各自每间隔最多触发一次，避免每轮催促。

## 停止门禁不变式

> 在每个 `agent/turn-stopping` 事件上，门禁要么在当前 turn 的 `todo/write`
> 快照中找到零个未完成 todo，要么注入一条继续 steer——绝不会促成带着未完成
> todo 结束 turn。门禁不抛异常、不越过用户取消（abort 按设计绕过停止边界），
> 且只读取自己会话的 todo。

门禁阻止停止时，模型被告知：完成 todo，或在需要用户输入时调用
`ask_user_question`——等待中的问题在当前 step *内部*暂停 turn，因此不会触发
门禁。runtime 拥有的子代理不能向用户提问（`DELEGATED_CALLER`）；被阻塞的
子代理必须把未决问题写入自己的最终结果。用户的取消仍是硬逃生口：取消永远不会
经过门禁。

## 组成

- `index.js`（宿主端）：注册 `todo-continuation` settings 命名空间，监听
  `agent/turn-stopping`，实现门禁与两条提示。零外部依赖，`schemastery` 在
  `apply()` 里动态 import，失败降级为诊断日志。
- `client.js`（浏览器端）：在设置页渲染「Todo 门禁」小节，编辑两个间隔字段和
  两个 advisory 提示模板。
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

在设置页「Todo 门禁」小节可编辑。界面中每条 advisory 是一组字段（间隔 + 提示
文本），按触发条件命名：**「If there is no todo list」**（键 `noTodoPrompt*`）
与 **「If the todo list is not updated」**（键 `staleTodoPrompt*`）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `noTodoPromptEveryNTurns` | 0 | 连续多少轮无 Todo 后提示开始使用；**0 = 关闭** |
| `staleTodoPromptEveryNTurns` | 20 | 已有 Todo 却连续多少轮不更新后提示保持最新；0 = 关闭 |
| `noTodoPromptTemplate` | 内置文本 | 无 Todo advisory 的文本；必须包含 `{n}` |
| `staleTodoPromptTemplate` | 内置文本 | 过期 Todo advisory 的文本；必须包含 `{n}` |

## 提示模板（占位符契约）

模板有**两个**，每个 advisory 一个——两个事件携带相反的指令（「开始使用
todo」vs「不要开始新工作，只刷新状态」），因此文本独立编辑。

| 模板 | 占位符 | 替换值 | 必需 |
| --- | --- | --- | --- |
| `noTodoPromptTemplate` | `{n}` | 生效的 `noTodoPromptEveryNTurns` 间隔 | 是 |
| `staleTodoPromptTemplate` | `{n}` | 生效的 `staleTodoPromptEveryNTurns` 间隔 | 是 |

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
