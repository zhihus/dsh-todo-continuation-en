# dsh-todo-continuation

[简体中文](README.zh.md) | [English](README.md)

DeepSeek Harness（DSH）的 Todo 门禁与提示插件：在 `agent/turn-stopping` 边界依据
当前 turn 的最新 `todo/write` 快照决定是否放行结束，并对「长期不用 Todo」和
「长期不更新 Todo」给出建议性提示。三个阈值均可在 Web 设置页配置，保存后下一轮
立即生效。

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，
> 完整的自研插件索引见该仓库。

## 功能

1. **停止门禁**：当前 turn 存在未完成、且不以「等待用户」前缀开头的 todo 时，
   注入一条继续消息，让模型在同一 turn 内继续推进，而不是带着未完成项结束。
2. **无 Todo 提示**：连续 `noTodoPromptEveryNTurns`（默认 5）轮没有任何 todo 快照时，
   提示模型用 `todo_write` 规划与跟踪工作。
3. **过期 Todo 提示**：已有 todo 列表却连续 `staleTodoPromptEveryNTurns`（默认 20）
   轮不更新时，提示模型保持列表最新。

插件绝不创建、删除、完成或改写 Todo——列表的唯一作者仍是模型。门禁只把关「能否
结束」，两条提示都是建议性的（不阻止结束），且各自每间隔最多触发一次，避免每轮
催促。

## 组成

- `index.js`（宿主端）：注册 `todo-continuation` settings 命名空间，监听
  `agent/turn-stopping`，实现门禁与两条提示。零外部依赖，`schemastery` 在
  `apply()` 里动态 import，失败降级为诊断日志。
- `client.js`（浏览器端）：在设置页渲染「Todo 门禁」小节，编辑三个字段。
- `cordis.patch.yml`：声明 `dsh-todo-continuation` 插件行。
- `package.json`：`@doiiarx/dsh-todo-continuation` 包清单，声明 `dsh.client` 注入与
  `schemastery` 依赖。

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

## 配置

在设置页「Todo 门禁」小节可编辑：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `waitingTodoPrefixes` | `[INFO_NEEDED]`、`[WAITING_USER]` | 未完成项以此开头时视为「等待用户」，允许结束 |
| `noTodoPromptEveryNTurns` | 5 | 连续多少轮无 Todo 后提示开始使用 |
| `staleTodoPromptEveryNTurns` | 20 | 已有 Todo 却连续多少轮不更新后提示保持最新 |

## 说明

- 门禁消息来源为 `{ kind: 'plugin', plugin: 'todo-continuation' }`，注入的
  `user/message` 可从会话日志重建。
- 用户的取消（`agent.cancel`）与终态 turn 错误在停止边界前中止，绝不会被门禁
  覆盖——取消仍是「模型永远不完成时结束该 turn」的唯一逃生口。
- 若同时以多行挂载本插件（如 base bundle + agent preset），会注册多个监听器并
  可能在一个停止边界入队多条消息；每个组合只挂载一次。