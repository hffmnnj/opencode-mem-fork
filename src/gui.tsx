import { Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Slot,
  Style,
  createKeyed,
  usePlugin,
  type MountedSession,
  type PanelProps,
  type PanelTab,
  type SlotMap,
} from "@opencode/plugin/gui";
import { MemoryInjections, type InjectionObservation } from "./v2/injection-rpc.js";
import { createInjectionState, type InjectionState } from "./gui/injection-state.js";
import memoryCss from "./gui/memory.css?inline";

type PanelPhase = "loading" | "ready" | "error" | "disconnected";

interface PanelView {
  phase: PanelPhase;
  snapshot: InjectionObservation | null;
  error: unknown;
}

interface SessionKey {
  serverID: string;
  sessionID: string;
  directory: string;
  connected: boolean;
  client: unknown;
}

function sessionKeyOf(session: MountedSession): SessionKey {
  return {
    serverID: session.server.id,
    sessionID: session.id,
    directory: session.directory,
    connected: session.server.connected,
    client: session.server.client,
  };
}

function sameSessionKey(previous: SessionKey, next: SessionKey): boolean {
  return (
    previous.serverID === next.serverID &&
    previous.sessionID === next.sessionID &&
    previous.directory === next.directory &&
    previous.connected === next.connected &&
    previous.client === next.client
  );
}

function MemoryPanel(input: { readonly props: PanelProps }) {
  const ctx = usePlugin();
  const ui = ctx.ui;
  const [view, setView] = createSignal<PanelView>({
    phase: "loading",
    snapshot: null,
    error: null,
  });
  let retryCurrent: () => void = () => {};

  createKeyed(
    () => sessionKeyOf(input.props.session),
    (key) => {
      let reader: InjectionState | null = null;
      const start = () => {
        reader?.dispose();
        reader = null;
        if (!key.connected) {
          setView({ phase: "disconnected", snapshot: null, error: null });
          return;
        }
        try {
          const client = input.props.session.server.client;
          const next = createInjectionState(
            {
              fetchLatest: (signal) =>
                client
                  .rpc(MemoryInjections)
                  .latest(
                    { sessionID: key.sessionID },
                    { location: { directory: key.directory }, signal }
                  ),
              subscribe: (onChanged) =>
                client.rpc(MemoryInjections).events.on("changed", (event) => {
                  if (event.data.sessionID === key.sessionID) onChanged();
                }),
            },
            (status) =>
              setView({ phase: status.status, snapshot: status.snapshot, error: status.error })
          );
          reader = next;
        } catch (failure) {
          setView({ phase: "error", snapshot: null, error: failure });
        }
      };
      retryCurrent = start;
      onCleanup(() => reader?.dispose());
      start();
    },
    { equals: sameSessionKey }
  );

  const snapshot = () => view().snapshot;
  const statusLabel = () => {
    const current = snapshot();
    if (!current) return "";
    switch (current.status) {
      case "injected":
        return ctx.t("view.attached");
      case "suppressed":
        return ctx.t("view.suppressed");
      case "disabled":
        return ctx.t("view.disabled");
      case "empty":
        return ctx.t("view.empty");
    }
  };
  const timestamp = () => {
    const current = snapshot();
    if (!current) return null;
    const date = new Date(current.timestamp);
    return { iso: date.toISOString(), label: date.toLocaleString() };
  };
  const copyText = () => {
    const text = snapshot()?.text;
    if (text) void ctx.system.copy(text);
  };

  return (
    <section aria-label={ctx.t("panel.title")} class="opencode-mem-panel">
      <Switch>
        <Match when={view().phase === "disconnected"}>
          <p class="opencode-mem-secondary">{ctx.t("view.disconnected")}</p>
        </Match>
        <Match when={view().phase === "loading" && !snapshot()}>
          <ui.Loader size="normal" />
        </Match>
        <Match when={view().phase === "error" && !snapshot()}>
          <p>{ctx.t("view.error")}</p>
          <ui.Button variant="neutral" size="small" icon="refresh" onClick={() => retryCurrent()}>
            {ctx.t("action.retry")}
          </ui.Button>
        </Match>
        <Match when={true}>
          <Show
            when={snapshot()}
            fallback={
              <>
                <p class="opencode-mem-secondary">{ctx.t("view.empty")}</p>
                <p class="opencode-mem-secondary">{ctx.t("view.note")}</p>
              </>
            }
          >
            {(current) => (
              <>
                <div class="opencode-mem-meta">
                  <span>{statusLabel()}</span>
                  <Show when={timestamp()}>
                    {(stamp) => <time dateTime={stamp().iso}>{stamp().label}</time>}
                  </Show>
                  <span class="opencode-mem-spacer" />
                  <Show when={current().text}>
                    <ui.Tooltip value={ctx.t("action.copy")}>
                      <ui.IconButton icon="copy" label={ctx.t("action.copy")} onClick={copyText} />
                    </ui.Tooltip>
                  </Show>
                </div>
                <Show when={view().phase === "error"}>
                  <div class="opencode-mem-error">
                    <span>{ctx.t("view.error")}</span>
                    <ui.Button
                      variant="neutral"
                      size="small"
                      icon="refresh"
                      onClick={() => retryCurrent()}
                    >
                      {ctx.t("action.retry")}
                    </ui.Button>
                  </div>
                </Show>
                <Show
                  when={current().text}
                  fallback={<p class="opencode-mem-secondary">{ctx.t("view.empty")}</p>}
                >
                  {(text) => (
                    <pre
                      class="opencode-mem-text"
                      style={{ "font-family": ctx.appearance.font("mono") }}
                    >
                      {text()}
                    </pre>
                  )}
                </Show>
                <p class="opencode-mem-secondary">{ctx.t("view.note")}</p>
              </>
            )}
          </Show>
        </Match>
      </Switch>
    </section>
  );
}

function HeaderMemoryAction(input: { readonly slot: SlotMap["session.header"] }) {
  const ctx = usePlugin();
  const ui = ctx.ui;
  const key = () => `${ctx.id}:memory`;
  const opened = () => ctx.layout.state(key(), input.slot.session) !== "closed";
  return (
    <ui.Tooltip value={ctx.t("header.open")}>
      <ui.IconButton
        icon="brain"
        label={ctx.t("header.open")}
        pressed={opened()}
        onClick={() => ctx.layout.toggle(key(), input.slot.session)}
      />
    </ui.Tooltip>
  );
}

export default Plugin.define({
  i18n: {
    en: {
      "panel.title": "Memory",
      "command.open": "Show memory panel",
      "menu.memory": "Memory",
      "header.open": "Show memory panel",
      "view.attached": "Memory attached to the latest request",
      "view.suppressed": "Memory suppressed for the latest request",
      "view.disabled": "Memory is disabled",
      "view.empty": "No memory context attached",
      "view.note":
        "Shows the latest memory attached to this session's request. Not full history, and not proof the provider received it.",
      "view.error": "Couldn't load the latest memory.",
      "view.disconnected": "Not connected to the session's server.",
      "action.retry": "Retry",
      "action.copy": "Copy memory text",
    },
  },
  setup(ctx) {
    ctx.add(Style, memoryCss);

    const memoryTab: PanelTab = {
      id: "memory",
      get title() {
        return ctx.t("panel.title");
      },
    };

    ctx.add(Panel, {
      id: "memory",
      region: "side",
      mobile: {
        get title() {
          return ctx.t("panel.title");
        },
        order: 40,
        kind: "menu",
        icon: "brain",
      },
      list: (input) => (input.open.includes("memory") ? [memoryTab] : []),
      render: (props) => <MemoryPanel props={props} />,
    });

    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current();
      return {
        menu: "session.panel",
        id: "memory",
        title: ctx.t("menu.memory"),
        icon: "brain",
        opened: !!session && ctx.layout.state(`${ctx.id}:memory`, session) !== "closed",
        run: () => {
          const current = ctx.sessions.current();
          if (current) ctx.layout.open(`${ctx.id}:memory`, current);
        },
      };
    });

    ctx.add(Slot, {
      at: "session.header",
      order: 10,
      render: (input) => <HeaderMemoryAction slot={input} />,
    });

    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("command.open"),
      section: "session",
      run: () => {
        const session = ctx.sessions.current();
        if (session) ctx.layout.open(`${ctx.id}:memory`, session);
      },
    }));
  },
});
