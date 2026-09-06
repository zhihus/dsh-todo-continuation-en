/**
 * @doiiarx/dsh-todo-continuation — browser settings page (Todo Gate section).
 * Same loading pattern as the client.js of @doiiarx/dsh-user-language:
 * `window.__ModuleLoader__.load` registers the browser-side plugin, binds the
 * `todo-continuation` settings namespace, and renders two editable interval
 * fields in the settings page (`0` disables the advisory). After saving, the
 * host side applies the new values on the next turn-stopping, no restart
 * needed.
 */
window.__ModuleLoader__.load({
  id: "@doiiarx/dsh-todo-continuation",
  factory: (require) => {
    const React = require("react");
    const inject = ["slots", "settingsScope", "connection", "remote"];
    const h = React.createElement;

    const NAMESPACE = "todo-continuation";
    const DEFAULT_NO_TODO_EVERY = 0;
    const DEFAULT_STALE_EVERY = 20;

    function intervalValue(value, fallback) {
      return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    }

    function TodoContinuationSettings({ scope }) {
      const snapshot = React.useSyncExternalStore(
        (fn) => scope.subscribe(fn),
        () => scope.getSnapshot(),
      );
      const value = snapshot.value;
      const busy = snapshot.status !== "ready" || value === undefined;
      const current = {
        noTodo: intervalValue(value?.noTodoPromptEveryNTurns, DEFAULT_NO_TODO_EVERY),
        stale: intervalValue(value?.staleTodoPromptEveryNTurns, DEFAULT_STALE_EVERY),
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
          type: "number", min: 0, step: 1,
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
            if (Number.isSafeInteger(parsed) && parsed >= 0) void scope.set(field, parsed);
          },
        }),
      );

      return h("div", { style: { display: "grid", gap: "18px", color: "var(--dsw-alias-label-primary)" } },
        h("div", null,
          h("h2", { style: { margin: "0 0 6px" } }, "Todo Gate"),
          h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } },
            "The turn cannot stop while unfinished todos remain. The two intervals below are advisory prompts; set 0 to disable one.")
        ),
        busy ? h("p", { style: { color: "var(--dsw-alias-label-secondary)" } }, "Loading configuration…")
          : h(React.Fragment, null,
            numberField("No-todo prompt interval", "After how many consecutive turns without any todo, prompt the model to start managing tasks with todos. 0 = disabled.", "noTodoPromptEveryNTurns", current.noTodo),
            numberField("Stale-todo prompt interval", "When a todo list exists but is not updated for this many consecutive turns, prompt the model to keep the list current. 0 = disabled.", "staleTodoPromptEveryNTurns", current.stale),
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
        keywords: "todo gate prompt stale update interval disable",
        items: [
          { id: "noTodoPromptEveryNTurns", label: "No-todo prompt interval", desc: "Prompt after turns without any todo; 0 = disabled", keywords: "todo gate no-todo prompt interval disabled" },
          { id: "staleTodoPromptEveryNTurns", label: "Stale-todo prompt interval", desc: "Prompt when the todo list is not updated; 0 = disabled", keywords: "todo gate stale update prompt interval disabled" },
        ],
      });
    }

    return { inject, apply };
  },
});
