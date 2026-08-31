/**
 * @doiiarx/dsh-todo-continuation — browser settings page (Todo Gate section).
 * Same loading pattern as the client.js of @doiiarx/dsh-user-language:
 * `window.__ModuleLoader__.load` registers the browser-side plugin, binds the
 * `todo-continuation` settings namespace, and renders three editable fields in
 * the settings page. After saving, the host side applies the new values on the
 * next turn-stopping, no restart needed.
 */
window.__ModuleLoader__.load({
  id: "@doiiarx/dsh-todo-continuation",
  factory: (require) => {
    const React = require("react");
    const inject = ["slots", "settingsScope", "connection", "remote"];
    const h = React.createElement;

    const NAMESPACE = "todo-continuation";
    const DEFAULT_NO_TODO_EVERY = 5;
    const DEFAULT_STALE_EVERY = 20;

    function numberValue(value, fallback) {
      return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
    }

    function TodoContinuationSettings({ scope }) {
      const snapshot = React.useSyncExternalStore(
        (fn) => scope.subscribe(fn),
        () => scope.getSnapshot(),
      );
      const value = snapshot.value;
      const busy = snapshot.status !== "ready" || value === undefined;
      const current = {
        noTodo: numberValue(value?.noTodoPromptEveryNTurns, DEFAULT_NO_TODO_EVERY),
        stale: numberValue(value?.staleTodoPromptEveryNTurns, DEFAULT_STALE_EVERY),
        prefixes: Array.isArray(value?.waitingTodoPrefixes)
          ? value.waitingTodoPrefixes.join("\n")
          : "",
      };

      const numberField = (label, desc, field, currentValue) => h("label", {
        "data-settings-item": field,
        style: {
          display: "grid", gap: "8px", padding: "18px",
          border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px",
          background: "var(--dsw-alias-bg-layer-1)",
        },
      },
        h("strong", null, label),
        h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } }, desc),
        h("input", {
          type: "number", min: 1, step: 1,
          value: currentValue,
          disabled: !snapshot.writable,
          style: {
            height: "38px", padding: "0 11px", width: "140px",
            border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
            color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)",
            font: "inherit",
          },
          onChange: (event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (Number.isSafeInteger(parsed) && parsed >= 1) void scope.set(field, parsed);
          },
        }),
      );

      return h("div", { style: { display: "grid", gap: "18px", color: "var(--dsw-alias-label-primary)" } },
        h("div", null,
          h("h2", { style: { margin: "0 0 6px" } }, "Todo Gate"),
          h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } },
            "Controls how the model uses the todo list: unfinished work is not allowed to end, and advisory prompts fire when todos are unused or not updated for a while.")
        ),
        busy ? h("p", { style: { color: "var(--dsw-alias-label-secondary)" } }, "Loading configuration…")
          : h(React.Fragment, null,
            numberField("No-todo prompt interval", "After how many consecutive turns without any todo, prompt the model to start managing tasks with todos.", "noTodoPromptEveryNTurns", current.noTodo),
            numberField("Stale-todo prompt interval", "When a todo list exists but is not updated for this many consecutive turns, prompt the model to keep the list current.", "staleTodoPromptEveryNTurns", current.stale),
            h("label", {
              "data-settings-item": "waitingTodoPrefixes",
              style: {
                display: "grid", gap: "8px", padding: "18px",
                border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px",
                background: "var(--dsw-alias-bg-layer-1)",
              },
            },
              h("strong", null, "Waiting-for-user prefixes"),
              h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } },
                "One prefix per line. Unfinished items starting with these prefixes are treated as \"waiting for the user\" and are allowed to end."),
              h("textarea", {
                value: current.prefixes,
                disabled: !snapshot.writable,
                rows: 3,
                placeholder: "[INFO_NEEDED]\n[WAITING_USER]",
                style: {
                  padding: "11px",
                  border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
                  color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)",
                  font: "inherit", resize: "vertical",
                },
                onChange: (event) => {
                  const prefixes = event.target.value.split("\n").map(s => s.trim()).filter(Boolean);
                  void scope.set("waitingTodoPrefixes", prefixes.length > 0 ? prefixes : []);
                },
              }),
            ),
          ),
      );
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({
          name: "settings.section",
          id: NAMESPACE,
          order: 140,
          label: "Todo Gate",
          inject: () => ({ scope }),
        }, TodoContinuationSettings),
      );
      const search = (globalThis.__DSH_SETTINGS_SEARCH__ ??= {
        sections: new Map(),
        register(sectionId, spec) {
          this.sections.set(sectionId, spec);
          return () => { this.sections.delete(sectionId) };
        },
      });
      search.register(NAMESPACE, {
        label: "Todo Gate",
        keywords: "todo gate waiting prefix prompt stale update",
        items: [
          { id: "noTodoPromptEveryNTurns", label: "No-todo prompt interval", desc: "Prompt after turns without any todo", keywords: "todo gate no-todo prompt interval" },
          { id: "staleTodoPromptEveryNTurns", label: "Stale-todo prompt interval", desc: "Prompt when the todo list is not updated", keywords: "todo gate stale update prompt interval" },
          { id: "waitingTodoPrefixes", label: "Waiting-for-user prefixes", desc: "Prefixes treated as waiting for the user", keywords: "waiting user prefix confirm info" },
        ],
      });
    }

    return { inject, apply };
  },
});
