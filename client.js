/**
 * @doiiarx/dsh-todo-continuation — browser settings page (Todo Gate section).
 * Same loading pattern as the client.js of @doiiarx/dsh-user-language:
 * `window.__ModuleLoader__.load` registers the browser-side plugin, binds the
 * `todo-continuation` settings namespace, and renders the "Todo Gate" section: the
 * stale-todo interval, the per-turn stop-gate veto cap, an editable post-compaction
 * switch with its own editable prompt text, and the editable stale-todo advisory
 * template (`0` disables the respective behavior; a stale template must contain the
 * required `{n}` placeholder, so an invalid draft is never written — the
 * post-compaction text needs no placeholder and may not be empty). The advisory
 * pair is labeled "Stale-todo prompt …": the reminder fires only while the session
 * has a standing todo list with unfinished items — the plugin never asks for one.
 * Staleness is measured from the durable session log, so a session resumed after a
 * host restart is judged like one that stayed up, and so is a compaction that
 * already landed there.
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
    const DEFAULT_STALE_EVERY = 5;
    const DEFAULT_GATE_MAX_STEERS = 2;
    const DEFAULT_PROMPT_AFTER_COMPACTION = true;
    const DEFAULT_LOG_DECISIONS = false;
    const DEFAULT_GATE_SUBAGENTS = true;
    // Client-side fallbacks mirror the host defaults; the host always sends the
    // schema-resolved values, so these only matter for defensive rendering.
    const DEFAULT_STALE_TEMPLATE = "Automated note: the standing todo list has {unfinished} unfinished of {total} item(s) and has not been updated for the last {n} turn(s).\n\nThe list as recorded in this session (newest todo_write wins; it may have left your context after a compaction):\n{todos}\n\nDo exactly one of these, then continue with the user's request:\n1. The plan still stands: take one concrete step on the oldest unfinished item and record the new statuses with `todo_write` (send the ENTIRE list).\n2. The list no longer matches the work (done, abandoned, or superseded): rewrite it to the true state, or clear it with an empty list.\nDo not invent items nobody asked for.";
    const PLACEHOLDER_HINT = "Placeholders: {n} = turns the standing list actually went without an update (required), {todos} = the rendered list, {unfinished} = unfinished item count, {total} = item count. The required {n} cannot be removed (an invalid template is not saved); unknown placeholders are sent as-is. Write them exactly as shown, without spaces inside the braces.";
    const DEFAULT_COMPACTION_TEMPLATE = "Automated note: this session's context was just condensed, so the standing todo list may no longer be in view. {unfinished} of {total} item(s) are still unfinished.\n\n{todos}\n\nDo exactly one of these, then continue with the user's request:\n1. The plan still stands: take one concrete step on the oldest unfinished item and restore the list with `todo_write` (send the ENTIRE list with real statuses).\n2. The list no longer matches the work: rewrite it to the true state, or clear it with an empty list.\nDo not invent items nobody asked for.";
    const COMPACTION_PLACEHOLDER_HINT = "Placeholders, all optional: {todos} = the rendered list, {unfinished} = unfinished item count, {total} = item count, {n} = turns since the list was last written. If the text leaves {todos} out, the list is appended below it anyway.";

    function intervalValue(value, fallback) {
      return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    }

    function templateValue(value, fallback) {
      return typeof value === "string" && value.includes("{n}") ? value : fallback;
    }

    // The post-compaction template works without any placeholder, so it only has
    // to be non-empty to count as an override.
    function plainTemplateValue(value, fallback) {
      return typeof value === "string" && value.trim() !== "" ? value : fallback;
    }

    function boolValue(value, fallback) {
      return typeof value === "boolean" ? value : fallback;
    }

    const cardStyle = {
      display: "grid", gap: "8px", padding: "18px",
      border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px",
      background: "var(--dsw-alias-bg-layer-1)",
    };
    const hintStyle = { color: "var(--dsw-alias-label-tertiary)" };
    const errorStyle = { color: "#c62828" };

    /** Advisory template textarea: local draft, valid drafts save on blur, invalid drafts show an inline error and never write. */
    function TemplateField({ scope, writable, label, desc, field, savedValue, rows, requireN = true, hint = PLACEHOLDER_HINT }) {
      const [draft, setDraft] = React.useState(savedValue);
      const [touched, setTouched] = React.useState(false);
      // Follow external value changes (e.g. the recovery read after a rejected
      // write), but never clobber a draft the user is currently editing.
      React.useEffect(() => {
        if (!touched) setDraft(savedValue);
      }, [savedValue, touched]);
      const valid = typeof draft === "string" && (requireN ? draft.includes("{n}") : draft.trim() !== "");
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
          ? h("small", { style: errorStyle }, requireN
            ? "Template must contain the required placeholder {n} — it will not be saved until the placeholder is restored."
            : "The prompt text cannot be empty — it will not be saved until it has content.")
          : (modified
            ? h("small", { style: hintStyle }, "Valid — saved when you leave the field.")
            : null),
        h("small", { style: hintStyle }, hint),
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
        gateMax: intervalValue(value?.gateMaxSteersPerTurn, DEFAULT_GATE_MAX_STEERS),
        staleTemplate: templateValue(value?.staleTodoPromptTemplate, DEFAULT_STALE_TEMPLATE),
        afterCompaction: boolValue(value?.promptAfterCompaction, DEFAULT_PROMPT_AFTER_COMPACTION),
        compactionTemplate: plainTemplateValue(value?.compactionPromptTemplate, DEFAULT_COMPACTION_TEMPLATE),
        logDecisions: boolValue(value?.logDecisions, DEFAULT_LOG_DECISIONS),
        gateSubagents: boolValue(value?.gateSubagents, DEFAULT_GATE_SUBAGENTS),
        maxPrompts: intervalValue(value?.maxPromptsPerList, 0),
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

      const boolField = (label, desc, field, checked) => h("label", {
        "data-settings-item": field,
        style: { ...cardStyle, gridTemplateColumns: "1fr auto", alignItems: "center" },
      },
        h("div", { style: { display: "grid", gap: "8px" } },
          h("strong", null, label),
          h("small", { style: hintStyle }, desc),
        ),
        h("input", {
          type: "checkbox",
          checked,
          disabled: !snapshot.writable,
          style: { width: "18px", height: "18px" },
          onChange: (event) => void scope.set(field, event.target.checked),
        }),
      );

      return h("div", { style: { display: "grid", gap: "18px", color: "var(--dsw-alias-label-primary)" } },
        h("div", null,
          h("h2", { style: { margin: "0 0 6px" } }, "Todo Gate"),
          h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } },
            "The turn cannot stop while the list this turn wrote still has unfinished todos, up to the veto cap below. The plugin never asks for a todo list: once the session has one with unfinished items, the interval below controls the reminder that hands the list back to the model and asks it to keep it current; set 0 to disable. The reminder text is an editable template with the required {n} placeholder. When the conversation gets condensed, the model loses its own copy of the plan, so the list comes back immediately — the switch below controls that. The list also reaches the model mid-turn, attached to a tool result, so a turn that never reaches a stop boundary still gets it. Every injection is a visible notice in the transcript with a one-line summary. Reminders repeat for as long as the list stands unchanged; set an optional per-list cap below if they ever get too noisy.")
        ),
        busy ? h("p", { style: { color: "var(--dsw-alias-label-secondary)" } }, "Loading configuration…")
          : h(React.Fragment, null,
            numberField("Stale-todo prompt interval", "When the standing todo list still has unfinished items and was not rewritten for this many consecutive turns, prompt the model to pick the list back up. 0 = disabled.", "staleTodoPromptEveryNTurns", current.stale),
            numberField("Stop-gate vetoes per turn", "How many times one turn may be sent back for unfinished todos before it is allowed to end (0 = the gate never vetoes). Keeps a plan the model cannot finish from looping the turn.", "gateMaxSteersPerTurn", current.gateMax),
            boolField("Gate subagents too", "A delegated agent is blocked from stopping the same way as a top-level turn. With this off, subagents are never sent back for unfinished todos — they still get the list as context, which is usually what you want when a child should report \"good enough\" instead of tidying its plan.", "gateSubagents", current.gateSubagents),
            h(TemplateField, {
              scope, writable: snapshot.writable, rows: 12,
              label: "Stale-todo prompt text",
              desc: "Text of the advisory sent when a standing todo list with unfinished items goes un-updated. {n} = actual idle turns, {todos} = the list, {unfinished}/{total} = counts.",
              field: "staleTodoPromptTemplate",
              savedValue: current.staleTemplate,
            }),
            boolField("Hand the list back after a compaction", "A condensation replaces earlier turns with a summary, and the model's own copy of the plan usually goes with them. With this on, the standing list is re-injected right away instead of waiting for the interval above — one reminder per compaction.", "promptAfterCompaction", current.afterCompaction),
            h(TemplateField, {
              scope, writable: snapshot.writable, rows: 9,
              label: "Post-compaction prompt text",
              desc: "Text sent once the context was condensed, when the standing list still has unfinished items. Every placeholder is optional; the list is appended automatically if you leave {todos} out.",
              field: "compactionPromptTemplate",
              savedValue: current.compactionTemplate,
              requireN: false,
              hint: COMPACTION_PLACEHOLDER_HINT,
            }),
            boolField("Log every decision", "One host-log line per stop boundary and per tool result, saying what the plugin did or why it stayed silent (prompt:compaction, skip:idle 2<5, gate:block …). Diagnostic only, off by default.", "logDecisions", current.logDecisions),
            numberField("Per-list reminder cap", "After this many reminders for one unchanged list the plugin goes quiet about it until the list is rewritten or a new compaction lands. 0 (the default) = never go quiet: remind on every interval, like the original plugin.", "maxPromptsPerList", current.maxPrompts ?? 0),
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
        keywords: "todo gate prompt stale update interval disable template veto cap turn unfinished restore compaction compact condense context",
        items: [
          { id: "staleTodoPromptEveryNTurns", label: "Stale-todo prompt interval", desc: "Prompt when a standing todo list with unfinished items goes un-updated; 0 = disabled", keywords: "todo gate stale update prompt restore interval disabled" },
          { id: "gateMaxSteersPerTurn", label: "Stop-gate vetoes per turn", desc: "How often one turn is sent back for unfinished todos before it may end; 0 = gate off", keywords: "todo gate veto cap stop turn block" },
          { id: "gateSubagents", label: "Gate subagents too", desc: "Whether a delegated agent is also blocked from stopping with unfinished todos; context reminders are sent either way", keywords: "todo gate subagent delegate child veto stop policy" },
          { id: "maxPromptsPerList", label: "Per-list reminder cap", desc: "How many reminders one unchanged list gets before the plugin goes quiet about it; 0 = no cap", keywords: "todo reminder cap limit quiet backoff noise repeat" },
          { id: "staleTodoPromptTemplate", label: "Stale-todo prompt text", desc: "Advisory text with {n}, {todos}, {unfinished}, {total}; requires {n}", keywords: "todo gate stale update prompt template text message placeholder" },
          { id: "promptAfterCompaction", label: "Hand the list back after a compaction", desc: "Re-inject the standing todo list as soon as the context is condensed, instead of waiting for the stale interval", keywords: "todo gate compaction compact summary context lost restore prompt" },
          { id: "compactionPromptTemplate", label: "Post-compaction prompt text", desc: "Text sent right after a condensation; {todos} optional, the list is appended if missing", keywords: "todo gate compaction compact prompt template text message placeholder" },
          { id: "logDecisions", label: "Log every decision", desc: "Host-log line per boundary: what the plugin sent or why it stayed silent", keywords: "todo gate debug log decision why silent skip prompt diagnose" },
        ],
      });
    }

    return { inject, apply };
  },
});
