/**
 * @doiiarx/dsh-todo-continuation — browser settings page (Todo Gate section).
 * Same loading pattern as the client.js of @doiiarx/dsh-user-language:
 * `window.__ModuleLoader__.load` registers the browser-side plugin, binds the
 * `todo-continuation` settings namespace, and renders one editable interval
 * field plus one editable advisory prompt template (`0` disables the advisory;
 * a template must contain the required `{n}` placeholder, so an invalid draft
 * is never written). The advisory pair is labeled "Stale-todo prompt …":
 * the reminder fires only after the model has created a todo list — the
 * plugin never asks for one.
 * After saving, the host side applies the new values on the
 * next turn-stopping, no restart needed.
 */
window.__ModuleLoader__.load({
  id: "@doiiarx/dsh-todo-continuation",
  factory: (require) => {
    const React = require("react");
    const inject = ["slots", "settingsScope", "connection", "remote"];
    const h = React.createElement;

    const NAMESPACE = "todo-continuation";
    const DEFAULT_STALE_EVERY = 20;
    // Client-side fallbacks mirror the host defaults; the host always sends the
    // schema-resolved values, so these only matter for defensive rendering.
    const DEFAULT_STALE_TEMPLATE = "Automated note: the todo list has not been updated for the last {n} turns.\n\nDon't create or start new work because of this note. Check the current todo list in your context and do exactly one of the following:\n\n1. No list, empty, or all completed: remove it (if present) and continue with the user's request. Do not invent new items.\n2. Unfinished items remain: update only statuses that no longer match the real state. Do not add items not requested.\n\nIf neither applies, ignore this note and continue with the user's actual request.";
    const PLACEHOLDER_HINT = "Available placeholder: {n} = the effective interval of this advisory. The required {n} cannot be removed (an invalid template is not saved); unknown placeholders are sent as-is. Write it exactly as {n}, without spaces inside the braces.";

    function intervalValue(value, fallback) {
      return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    }

    function templateValue(value, fallback) {
      return typeof value === "string" && value.includes("{n}") ? value : fallback;
    }

    const cardStyle = {
      display: "grid", gap: "8px", padding: "18px",
      border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px",
      background: "var(--dsw-alias-bg-layer-1)",
    };
    const hintStyle = { color: "var(--dsw-alias-label-tertiary)" };
    const errorStyle = { color: "#c62828" };

    /** Advisory template textarea: local draft, valid drafts save on blur, invalid drafts show an inline error and never write. */
    function TemplateField({ scope, writable, label, desc, field, savedValue, rows }) {
      const [draft, setDraft] = React.useState(savedValue);
      const [touched, setTouched] = React.useState(false);
      // Follow external value changes (e.g. the recovery read after a rejected
      // write), but never clobber a draft the user is currently editing.
      React.useEffect(() => {
        if (!touched) setDraft(savedValue);
      }, [savedValue, touched]);
      const valid = typeof draft === "string" && draft.includes("{n}");
      const modified = draft !== savedValue;
      return h("label", { "data-settings-item": field, style: cardStyle },
        h("strong", null, label),
        h("small", { style: hintStyle }, desc),
        h("textarea", {
          rows,
          value: draft,
          disabled: !writable,
          spellCheck: false,
          style: {
            width: "100%", padding: "10px 11px", resize: "vertical", lineHeight: "1.5",
            border: "1px solid " + (valid ? "var(--dsw-alias-border-l2)" : "#c62828"), borderRadius: "10px",
            color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)",
            font: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12.5px",
          },
          onChange: (event) => {
            setDraft(event.target.value);
            setTouched(true);
          },
          onBlur: () => {
            if (valid && draft !== savedValue) void scope.set(field, draft);
          },
        }),
        !valid
          ? h("small", { style: errorStyle }, "Template must contain the required placeholder {n} — it will not be saved until the placeholder is restored.")
          : (modified
            ? h("small", { style: hintStyle }, "Valid — saved when you leave the field.")
            : null),
        h("small", { style: hintStyle }, PLACEHOLDER_HINT),
      );
    }

    function TodoContinuationSettings({ scope }) {
      const snapshot = React.useSyncExternalStore(
        (fn) => scope.subscribe(fn),
        () => scope.getSnapshot(),
      );
      const value = snapshot.value;
      const busy = snapshot.status !== "ready" || value === undefined;
      const current = {
        stale: intervalValue(value?.staleTodoPromptEveryNTurns, DEFAULT_STALE_EVERY),
        staleTemplate: templateValue(value?.staleTodoPromptTemplate, DEFAULT_STALE_TEMPLATE),
      };

      const numberField = (label, desc, field, currentValue) => h("label", {
        "data-settings-item": field,
        style: cardStyle,
      },
        h("strong", null, label),
        h("small", { style: hintStyle }, desc),
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
            "The turn cannot stop while unfinished todos remain. The plugin never asks for a todo list: once the model creates one, the interval below controls the reminder to keep it updated; set 0 to disable. The reminder text is an editable template with the required {n} placeholder.")
        ),
        busy ? h("p", { style: { color: "var(--dsw-alias-label-secondary)" } }, "Loading configuration…")
          : h(React.Fragment, null,
            numberField("Stale-todo prompt interval", "When a todo list exists but is not updated for this many consecutive turns, prompt the model to keep the list current. 0 = disabled.", "staleTodoPromptEveryNTurns", current.stale),
            h(TemplateField, {
              scope, writable: snapshot.writable, rows: 10,
              label: "Stale-todo prompt text",
              desc: "Text of the advisory sent when an existing todo list is not updated for N consecutive turns.",
              field: "staleTodoPromptTemplate",
              savedValue: current.staleTemplate,
            }),
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
        keywords: "todo gate prompt stale update interval disable template",
        items: [
          { id: "staleTodoPromptEveryNTurns", label: "Stale-todo prompt interval", desc: "Prompt when the todo list is not updated; 0 = disabled", keywords: "todo gate stale update prompt interval disabled" },
          { id: "staleTodoPromptTemplate", label: "Stale-todo prompt text", desc: "Advisory text when an existing todo list is not updated; requires {n}", keywords: "todo gate stale update prompt template text message placeholder" },
        ],
      });
    }

    return { inject, apply };
  },
});
