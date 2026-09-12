/**
 * @doiiarx/dsh-todo-continuation — browser side: the "Todo Gate" settings section
 * and the conversation status chip.
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
 *
 * The status chip ("Todo Gate" in the conversation input row) makes the reminder
 * loop visible to the user, not only to the model: it shows the standing list's
 * counts and idle span plus the last thing the plugin did (reminded / restored
 * after a compaction / restored after a resume / sent the turn back). It reads
 * the active session's tail through the public session.history wire and derives
 * everything with a DURABLE backscan — unlike the host's turn-local `todos`
 * projection, which empties at every turn/start (see UPSTREAM.md), so the chip
 * keeps showing the standing plan exactly when the panel does not.
 * All failure paths are fail-open: any error fetching or parsing hides the chip.
 */
window.__ModuleLoader__.load({
  id: "@doiiarx/dsh-todo-continuation",
  factory: (require) => {
    const React = require("react");
    const inject = ["slots", "settingsScope", "connection"];
    const h = React.createElement;

    const NAMESPACE = "todo-continuation";
    // The host clamps the veto cap to this (see MAX_GATE_STEERS in index.js); the
    // input is bounded to the same value so the UI never shows an edit the host
    // will silently ignore.
    const MAX_GATE_STEERS = 10;
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

    // The mirror of the host-side `DEFAULTS` export (index.js). The suite pins
    // the two copies together: a default changed on one side and not the other
    // is exactly the silent drift the settings page must never ship with.
    const DEFAULTS = {
      staleEvery: DEFAULT_STALE_EVERY,
      gateMaxSteers: DEFAULT_GATE_MAX_STEERS,
      maxGateSteers: MAX_GATE_STEERS,
      promptAfterCompaction: DEFAULT_PROMPT_AFTER_COMPACTION,
      logDecisions: DEFAULT_LOG_DECISIONS,
      gateSubagents: DEFAULT_GATE_SUBAGENTS,
      maxPromptsPerList: 0,
      staleTemplate: DEFAULT_STALE_TEMPLATE,
      compactionTemplate: DEFAULT_COMPACTION_TEMPLATE,
    };

    // ---------------------------------------------------------------- chip: pure status
    // These functions are exported from the factory so node tests can run them
    // without a browser: they never touch React, the DOM, or the connection.

    /** A session is idle long enough between two adjacent events to count as a restart/gap. */
    const RESUME_GAP_MS = 3 * 60 * 1000;

    function isPluginDelivery(event) {
      return event?.type === "user/message" && event?.data?.source?.plugin === NAMESPACE;
    }

    /** Classify a delivery by its one-line summary (the wording the host ships). */
    function deliveryKind(summary) {
      const text = typeof summary === "string" ? summary : "";
      if (/turn sent back/.test(text)) return "veto";
      if (/compaction/i.test(text)) return "compaction";
      if (/reminded of its todo list/.test(text)) return "stale";
      return null;
    }

    function eventTime(event) {
      const t = event?.time;
      return typeof t === "number" ? t : Number.isFinite(Date.parse(t)) ? Date.parse(t) : null;
    }

    /**
     * DURABLE standing-list backscan: the last `todo/write` over the whole log,
     * deliberately ignoring `turn/start` (that stop is what empties the host's
     * turn-local panel projection — see UPSTREAM.md).
     * @returns {{ todos: Array, index: number } | null}
     */
    function durableStandingTodos(events) {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.type === "todo/write" && Array.isArray(event?.data?.todos)) {
          return { todos: event.data.todos, index: i };
        }
      }
      return null;
    }

    /** `turn/start` records that happened after the given index (the idle span in turns). */
    function turnsAfter(events, index) {
      let count = 0;
      for (let i = index + 1; i < events.length; i++) {
        if (events[i]?.type === "turn/start") count += 1;
      }
      return count;
    }

    /**
     * Last plugin delivery with its kind, plus whether it acted as a restore.
     * A delivery restored the list to the model when it is a compaction hand-back
     * by wording, or when the turn it landed in opened after a long silence
     * (resume/shutdown): the model could not have had the list from its own context.
     * @returns {{ at: number|null, kind: string, restored: false | "compaction" | "resume" } | null}
     */
    function lastDelivery(events) {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (!isPluginDelivery(event)) continue;
        const kind = deliveryKind(event?.data?.source?.summary) ?? "stale";
        /** @type {false | "compaction" | "resume"} */
        let restored = false;
        if (kind === "compaction") {
          restored = "compaction";
        } else if (kind === "stale") {
          // Walk back to the turn/start that opened this delivery's turn; if the
          // silence before it is long, the delivery bridged a resume/shutdown.
          for (let j = i - 1; j >= 0; j--) {
            if (events[j]?.type === "turn/start") {
              const start = eventTime(events[j]);
              const before = j > 0 ? eventTime(events[j - 1]) : null;
              if (start !== null && before !== null && start - before >= RESUME_GAP_MS) restored = "resume";
              break;
            }
            if (events[j]?.type === "todo/write") break; // the model already had the list this turn
          }
        }
        return { at: eventTime(event), kind, restored };
      }
      return null;
    }

    function fmtTime(ms) {
      if (typeof ms !== "number") return "";
      const date = new Date(ms);
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }

    /**
     * The whole chip state from one page of session events.
     * @returns {null | { total: number, unfinished: number, idleTurns: number,
     *   lastDelivery: { at: number|null, kind: string, restored: false | "compaction" | "resume" } | null }}
     */
    function computeTodoGateStatus(events) {
      if (!Array.isArray(events)) return null;
      const standing = durableStandingTodos(events);
      if (standing === null) return null;
      const todos = standing.todos;
      const unfinished = todos.filter((item) => item?.status !== "completed").length;
      return {
        total: todos.length,
        unfinished,
        idleTurns: turnsAfter(events, standing.index),
        lastDelivery: lastDelivery(events),
      };
    }

    const DELIVERY_LABEL = {
      compaction: "restored after compaction",
      resume: "restored after resume",
      stale: "reminded",
      veto: "gate sent the turn back",
    };

    /** One-line chip text; `status` comes from computeTodoGateStatus. */
    function statusText(status) {
      if (status === null || status.total === 0) return null;
      const head = status.unfinished === 0
        ? `Todo Gate · ${status.total}/${status.total} done`
        : `Todo Gate · ${status.unfinished}/${status.total} unfinished · idle ${status.idleTurns}t`;
      const delivery = status.lastDelivery;
      const tail = delivery === null ? ""
        : ` · ${DELIVERY_LABEL[delivery.restored || delivery.kind] ?? DELIVERY_LABEL[delivery.kind]}${delivery.at === null ? "" : ` ${fmtTime(delivery.at)}`}`;
      return head + tail;
    }

    // ---------------------------------------------------------------- chip: component

    function TodoGateChip({ sessionId, connection, useProjection }) {
      const [status, setStatus] = React.useState(null);
      // The host's turn-local todos value changes exactly on todo/write and
      // turn/start — the two moments the durable picture can change; sessionStats
      // covers mid-turn deliveries (it advances with tool results). Both are only
      // change signals: the status itself is recomputed from the durable log tail.
      const todosValue = typeof useProjection === "function" ? useProjection("todos") : undefined;
      const statsValue = typeof useProjection === "function" ? useProjection("sessionStats") : undefined;
      React.useEffect(() => {
        if (typeof sessionId !== "string" || sessionId === "" || connection === undefined) return undefined;
        let alive = true;
        (async () => {
          try {
            // Bounded tail walk: the tail page usually holds the last write; a
            // long-idle list may sit deeper, so page back a few times at most.
            let collected = [];
            let beforeSeq;
            for (let page = 0; page < 4; page += 1) {
              const payload = { sessionId, maxMessages: 400, ...(beforeSeq !== undefined ? { beforeSeq } : {}) };
              const response = await connection.api.sessions.history(payload);
              const entries = Array.isArray(response?.events) ? response.events : [];
              const events = entries.map((entry) => entry?.event).filter(Boolean);
              collected = [...events, ...collected];
              const found = durableStandingTodos(collected) !== null || entries.some((entry) => entry?.event?.type === "todo/write");
              if (found || response?.hasMore !== true || entries.length === 0) break;
              beforeSeq = entries[0]?.event?.seq;
              if (typeof beforeSeq !== "number") break;
            }
            if (alive) setStatus(computeTodoGateStatus(collected));
          } catch {
            if (alive) setStatus(null); // fail open: no data, no chip
          }
        })();
        return () => { alive = false; };
      }, [sessionId, connection, todosValue, statsValue]);
      const text = statusText(status);
      if (text === null) return null;
      const delivery = status.lastDelivery;
      const title = "The todo-continuation plugin keeps the standing list with the model."
        + (status.unfinished > 0 ? ` ${status.unfinished} of ${status.total} items unfinished; the list has not been rewritten for ${status.idleTurns} turn(s).` : " Every item is completed.")
        + (delivery ? " Last action: " + (DELIVERY_LABEL[delivery.restored || delivery.kind] ?? "reminder") + "." : "");
      return h("span", {
        role: "status",
        title,
        style: {
          display: "inline-flex", alignItems: "center", gap: "4px",
          padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 500,
          lineHeight: "20px", cursor: "default", whiteSpace: "nowrap",
          color: status.unfinished > 0 ? "var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))"
            : "var(--dsw-alias-state-success-label, var(--dsw-alias-label-secondary))",
          background: status.unfinished > 0 ? "var(--dsw-alias-state-warn-tertiary, transparent)"
            : "var(--dsw-alias-state-success-tertiary, transparent)",
        },
      }, text);
    }

    // ---------------------------------------------------------------- settings page

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
      const unavailable = snapshot.status === "unavailable";
      const busy = unavailable || snapshot.status !== "ready" || value === undefined;
      const current = {
        stale: intervalValue(value?.staleTodoPromptEveryNTurns, DEFAULT_STALE_EVERY),
        // Clamped for display: the host caps the veto at MAX_GATE_STEERS, so a
        // stored out-of-range value (an old settings file) is really 10.
        gateMax: Math.min(MAX_GATE_STEERS, intervalValue(value?.gateMaxSteersPerTurn, DEFAULT_GATE_MAX_STEERS)),
        staleTemplate: templateValue(value?.staleTodoPromptTemplate, DEFAULT_STALE_TEMPLATE),
        afterCompaction: boolValue(value?.promptAfterCompaction, DEFAULT_PROMPT_AFTER_COMPACTION),
        compactionTemplate: plainTemplateValue(value?.compactionPromptTemplate, DEFAULT_COMPACTION_TEMPLATE),
        logDecisions: boolValue(value?.logDecisions, DEFAULT_LOG_DECISIONS),
        gateSubagents: boolValue(value?.gateSubagents, DEFAULT_GATE_SUBAGENTS),
        maxPrompts: intervalValue(value?.maxPromptsPerList, 0),
      };

      const numberField = (label, desc, field, currentValue, max) => h("label", {
        "data-settings-item": field,
        style: cardStyle,
      },
        h("strong", null, label),
        h("small", { style: hintStyle }, desc),
        h("input", {
          type: "number", min: 0, ...(max !== undefined ? { max } : {}), step: 1,
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
            if (!Number.isSafeInteger(parsed) || parsed < 0) return;
            void scope.set(field, max !== undefined ? Math.min(parsed, max) : parsed);
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
            "The turn cannot stop while the list this turn wrote still has unfinished todos, up to the veto cap below. The plugin never asks for a todo list: once the session has one with unfinished items, the interval below controls the reminder that hands the list back to the model and asks it to keep it current; set 0 to disable. The reminder text is an editable template with the required {n} placeholder. When the conversation gets condensed, the model loses its own copy of the plan, so the list comes back immediately — the switch below controls that. The list also reaches the model mid-turn, attached to a tool result, so a turn that never reaches a stop boundary still gets it. Every injection is a visible notice in the transcript with a one-line summary. Reminders repeat for as long as the list stands unchanged; set an optional per-list cap below if they ever get too noisy. A \"Todo Gate\" chip above the composer shows the same loop to you: the standing counts and the last thing the plugin did.")
        ),
        busy ? (unavailable
          ? h("p", { style: { color: "var(--dsw-alias-label-secondary)" } },
            "The host did not expose the \"todo-continuation\" settings namespace, so this section is read-only and "
            + "shows built-in defaults — check the host log for \"[todo-continuation]\" warnings to see why the "
            + "settings registration failed.")
          : h("p", { style: { color: "var(--dsw-alias-label-secondary)" } }, "Loading configuration…"))
          : h(React.Fragment, null,
            numberField("Stale-todo prompt interval", "When the standing todo list still has unfinished items and was not rewritten for this many consecutive turns, prompt the model to pick the list back up. 0 = disabled.", "staleTodoPromptEveryNTurns", current.stale),
            numberField("Stop-gate vetoes per turn", "How many times one turn may be sent back for unfinished todos before it is allowed to end (0 = the gate never vetoes). The host never accepts more than 10 — a value above that would loop one stop boundary.", "gateMaxSteersPerTurn", current.gateMax, MAX_GATE_STEERS),
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
      // The status chip: always-visible proof that the reminder loop works —
      // standing counts, last reminder, and restores after a compaction or a
      // resume, derived from the durable log tail (the host's own panel follows
      // the turn-local projection and empties at every turn/start — UPSTREAM.md).
      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register({
          name: "conversation.input.left",
          id: NAMESPACE,
          order: 40,
          label: "Todo gate",
          // Never hand back an explicit `sessionId: undefined`: the merge order of
          // injected props over the slot's standard props is the host's business, and
          // an undefined here would erase the sessionId the seat already provides.
          inject: (sessionId) => sessionId === undefined || sessionId === null || sessionId === ""
            ? { connection: ctx.connection }
            : { sessionId, connection: ctx.connection },
        }, TodoGateChip),
      );
      // No settings-search registration here: the installed host build has no
      // consumer for `__DSH_SETTINGS_SEARCH__` (verified against the host
      // checkout on 2026-09-09), so the block only created a global. Restore it
      // only if the host grows a real search consumer — see UPSTREAM.md.
    }

    return { inject, apply, computeTodoGateStatus, statusText, deliveryKind, durableStandingTodos, lastDelivery, DEFAULTS };
  },
});
