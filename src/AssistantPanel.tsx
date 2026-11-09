import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowCounterClockwise,
  Check,
  GearSix,
  PaperPlaneRight,
  Plus,
  Sparkle,
  SpinnerGap,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  compactHistory,
  projectChanges,
  runAssistant,
  undoProjectChanges,
  validateBaseUrl,
  type AssistantHost,
  type AssistantProject,
  type AuthHeader,
  type ChatMessage,
  type FileChange,
  type ToolStatus,
} from "./assistant";

const SETTINGS_KEY = "latex-editor:assistant:v1";
const API_KEY_KEY = "latex-editor:assistant-key:v1";

type StoredSettings = {
  baseUrl: string;
  model: string;
  authHeader: AuthHeader;
  rememberKey: boolean;
  consentedHost: string;
  apiKey: string;
};

export type AccountSettings = Omit<StoredSettings, "rememberKey">;

const NVIDIA_HOST = "integrate.api.nvidia.com";
const NVIDIA_PROXY_PATH = "/proxy/nvidia/";
const NVIDIA_BASE_URL = `${window.location.origin}${NVIDIA_PROXY_PATH}v1`;

const PRESETS: {
  id: string;
  label: string;
  baseUrl: string;
  placeholder: string;
  authHeader: AuthHeader;
  model: string;
  note?: string;
}[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    placeholder: "https://api.openai.com/v1",
    authHeader: "bearer",
    model: "for example gpt-4.1-mini",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    placeholder: "https://openrouter.ai/api/v1",
    authHeader: "bearer",
    model: "for example openai/gpt-4.1-mini",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    placeholder: "https://generativelanguage.googleapis.com/v1beta/openai",
    authHeader: "bearer",
    model: "for example gemini-3.8-flash",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: NVIDIA_BASE_URL,
    placeholder: NVIDIA_BASE_URL,
    authHeader: "bearer",
    model: "for example nvidia/nemotron-3-super-120b-a12b",
    note: `NVIDIA does not accept requests straight from a browser, so this address forwards them to ${NVIDIA_HOST} through this app's own server. It works with npm run dev and npm run preview; a hosted copy needs the same forwarding rule.`,
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    baseUrl: "",
    placeholder: "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
    authHeader: "api-key",
    model: "your deployment name",
  },
  {
    id: "ollama",
    label: "Ollama on this computer",
    baseUrl: "http://localhost:11434/v1",
    placeholder: "http://localhost:11434/v1",
    authHeader: "bearer",
    model: "for example llama3.1",
  },
  {
    id: "custom",
    label: "Other OpenAI-compatible service",
    baseUrl: "",
    placeholder: "https://your-gateway.example.com/v1",
    authHeader: "bearer",
    model: "model name",
  },
];

const SUGGESTIONS = [
  "Fix the compile errors",
  "Proofread the introduction and fix typos",
  "Add a short conclusion section",
  "Explain what this document is about",
];

function hostOf(baseUrl: string) {
  try {
    const url = new URL(baseUrl.trim());
    if (url.origin === window.location.origin && url.pathname.startsWith(NVIDIA_PROXY_PATH)) {
      return NVIDIA_HOST;
    }
    return url.host;
  } catch {
    return "";
  }
}

function readStorage(storage: () => Storage, key: string) {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // Settings still apply for this page when storage is unavailable.
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

function loadSettings(): StoredSettings {
  let saved: Partial<StoredSettings> = {};
  try {
    saved = JSON.parse(readStorage(local, SETTINGS_KEY) ?? "{}") as Partial<StoredSettings>;
  } catch {
    saved = {};
  }
  const rememberKey = saved.rememberKey === true;
  return {
    baseUrl: typeof saved.baseUrl === "string" ? saved.baseUrl : "",
    model: typeof saved.model === "string" ? saved.model : "",
    authHeader: saved.authHeader === "api-key" ? "api-key" : "bearer",
    rememberKey,
    consentedHost: typeof saved.consentedHost === "string" ? saved.consentedHost : "",
    apiKey: readStorage(rememberKey ? local : session, API_KEY_KEY) ?? "",
  };
}

function saveSettings(settings: StoredSettings) {
  const { apiKey, ...rest } = settings;
  writeStorage(local, SETTINGS_KEY, JSON.stringify(rest));
  writeStorage(settings.rememberKey ? local : session, API_KEY_KEY, apiKey || null);
  writeStorage(settings.rememberKey ? session : local, API_KEY_KEY, null);
}

const isConfigured = (settings: StoredSettings) =>
  Boolean(settings.model.trim()) &&
  !validateBaseUrl(settings.baseUrl) &&
  settings.consentedHost === hostOf(settings.baseUrl);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Item =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "tool"; status: ToolStatus; summary: string }
  | {
      id: number;
      kind: "changes";
      changes: FileChange[];
      before: AssistantProject;
      after: AssistantProject;
      undone: string[] | null;
    }
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "notice"; text: string };

function renderInline(text: string): ReactNode[] {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return <code key={index}>{part.slice(1, -1)}</code>;
      }
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      return <Fragment key={index}>{part}</Fragment>;
    });
}

// A small Markdown subset: code fences, lists, paragraphs, `code` and **bold**.
function MessageText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  text.split("```").forEach((part, index) => {
    if (index % 2 === 1) {
      const newline = part.indexOf("\n");
      const hasLanguage = newline >= 0 && /^[\w+#.-]*$/.test(part.slice(0, newline).trim());
      blocks.push(
        <pre key={index}>
          <code>{(hasLanguage ? part.slice(newline + 1) : part).replace(/\n$/, "")}</code>
        </pre>,
      );
      return;
    }
    part.split(/\n{2,}/).forEach((paragraph, position) => {
      const lines = paragraph.split("\n").filter((line) => line.trim());
      if (lines.length === 0) return;
      const key = `${index}-${position}`;
      const marker = /^\s*([-*•]|\d+[.)])\s+/;
      if (lines.every((line) => marker.test(line))) {
        const entries = lines.map((line, item) => <li key={item}>{renderInline(line.replace(marker, ""))}</li>);
        blocks.push(/^\s*\d/.test(lines[0]) ? <ol key={key}>{entries}</ol> : <ul key={key}>{entries}</ul>);
        return;
      }
      blocks.push(
        <p key={key}>
          {lines.map((line, item) => {
            const heading = /^#{1,6}\s+/.test(line);
            const content = renderInline(line.replace(/^#{1,6}\s+/, ""));
            return (
              <Fragment key={item}>
                {item > 0 && <br />}
                {heading ? <strong>{content}</strong> : content}
              </Fragment>
            );
          })}
        </p>,
      );
    });
  });
  return <div className="assistant-text">{blocks}</div>;
}

function SettingsForm({
  initial,
  signedIn,
  onSave,
  onCancel,
}: {
  initial: StoredSettings;
  signedIn: boolean;
  onSave: (settings: StoredSettings) => void;
  onCancel: (() => void) | null;
}) {
  const [preset, setPreset] = useState(
    () => PRESETS.find((item) => item.baseUrl && item.baseUrl === initial.baseUrl)?.id ?? "custom",
  );
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [authHeader, setAuthHeader] = useState<AuthHeader>(initial.authHeader);
  const [rememberKey, setRememberKey] = useState(initial.rememberKey);
  const host = hostOf(baseUrl);
  const [consent, setConsent] = useState(Boolean(host) && initial.consentedHost === host);
  const [submitted, setSubmitted] = useState(false);
  const presetInfo = PRESETS.find((item) => item.id === preset) ?? PRESETS[PRESETS.length - 1];

  const urlError = validateBaseUrl(baseUrl);
  const modelError = model.trim() ? "" : "Enter the model name your service expects.";
  const consentNeeded = !consent;

  const choosePreset = (id: string) => {
    const next = PRESETS.find((item) => item.id === id);
    setPreset(id);
    if (!next) return;
    setBaseUrl(next.baseUrl);
    setAuthHeader(next.authHeader);
    setConsent(false);
  };

  return (
    <form
      className="assistant-settings"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (urlError || modelError || consentNeeded) return;
        onSave({
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiKey: apiKey.trim(),
          authHeader,
          rememberKey,
          consentedHost: host,
        });
      }}
    >
      <p className="assistant-settings-intro">
        Connect any service that offers the OpenAI chat completions API with tool calling.
        {signedIn && " These settings and your API key are also saved to your Google account."}
      </p>

      <label className="assistant-field">
        <span>Service</span>
        <select value={preset} onChange={(event) => choosePreset(event.target.value)}>
          {PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <label className="assistant-field">
        <span>Base URL</span>
        <input
          value={baseUrl}
          placeholder={presetInfo.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={submitted && Boolean(urlError)}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setConsent(hostOf(event.target.value) === initial.consentedHost && Boolean(initial.consentedHost));
          }}
        />
        {submitted && urlError && <em role="alert">{urlError}</em>}
        {presetInfo.note && <small className="assistant-field-note">{presetInfo.note}</small>}
      </label>

      <label className="assistant-field">
        <span>Model</span>
        <input
          value={model}
          placeholder={presetInfo.model}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={submitted && Boolean(modelError)}
          onChange={(event) => setModel(event.target.value)}
        />
        {submitted && modelError && <em role="alert">{modelError}</em>}
      </label>

      <label className="assistant-field">
        <span>API key</span>
        <input
          type="password"
          value={apiKey}
          placeholder={preset === "ollama" ? "Not needed for Ollama" : "Paste your API key"}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <label className="assistant-field">
        <span>Key header</span>
        <select value={authHeader} onChange={(event) => setAuthHeader(event.target.value as AuthHeader)}>
          <option value="bearer">Authorization: Bearer (most services)</option>
          <option value="api-key">api-key (Azure OpenAI)</option>
        </select>
      </label>

      <label className="assistant-check">
        <input
          type="checkbox"
          checked={rememberKey}
          onChange={(event) => setRememberKey(event.target.checked)}
        />
        <span>
          Remember the key on this browser. When off, the key is kept only until this tab closes.
        </span>
      </label>

      <div className={`assistant-consent${submitted && consentNeeded ? " invalid" : ""}`}>
        <p>
          Each time you send a message, your messages, the text of your project files and the compile
          log are sent to <strong>{host || "the service above"}</strong>. Your API key is sent only there.
          Nothing is sent until you send a message.
        </p>
        <label className="assistant-check">
          <input
            type="checkbox"
            checked={consent}
            disabled={!host}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>Send my project to {host || "this service"} when I use the assistant</span>
        </label>
        {submitted && consentNeeded && <em role="alert">Confirm before using the assistant.</em>}
      </div>

      <div className="assistant-settings-actions">
        {initial.apiKey && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setApiKey("");
              writeStorage(local, API_KEY_KEY, null);
              writeStorage(session, API_KEY_KEY, null);
            }}
          >
            Forget key
          </button>
        )}
        <span className="assistant-spacer" />
        {onCancel && (
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="assistant-primary">
          Save
        </button>
      </div>
    </form>
  );
}

function ChangesCard({ item, onUndo }: { item: Extract<Item, { kind: "changes" }>; onUndo: () => void }) {
  const count = item.changes.length;
  return (
    <div className="assistant-changes">
      <div className="assistant-changes-head">
        <strong>
          {count} {count === 1 ? "file" : "files"} changed
        </strong>
        {item.undone ? (
          <span className="assistant-undone">
            <Check aria-hidden="true" /> Undone
          </span>
        ) : (
          <button type="button" className="assistant-undo" onClick={onUndo}>
            <ArrowCounterClockwise aria-hidden="true" /> Undo AI changes
          </button>
        )}
      </div>
      <ul>
        {item.changes.map((change) => (
          <li key={change.path}>
            <details>
              <summary>
                <span className={`assistant-change-kind ${change.kind}`}>{change.kind}</span>
                <code>{change.path}</code>
                <span className="assistant-diffstat">
                  <span className="added">+{change.added}</span>
                  <span className="removed">−{change.removed}</span>
                </span>
              </summary>
              <pre className="assistant-diff">
                {change.lines.map((line, index) => (
                  <span key={index} className={`diff-${line.type}`}>
                    {line.type === "gap"
                      ? line.text || "⋯"
                      : `${line.type === "add" ? "+" : line.type === "remove" ? "−" : " "} ${line.text}`}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </details>
          </li>
        ))}
      </ul>
      {item.undone && item.undone.length > 0 && (
        <p className="assistant-kept">
          Kept {item.undone.join(", ")}, because you changed {item.undone.length === 1 ? "it" : "them"} afterwards.
        </p>
      )}
    </div>
  );
}

export default function AssistantPanel({
  host,
  hidden,
  onClose,
  accountSettings,
  onSaveAccountSettings,
}: {
  host: AssistantHost;
  hidden: boolean;
  onClose: () => void;
  accountSettings?: AccountSettings | null;
  onSaveAccountSettings?: (settings: AccountSettings) => Promise<void>;
}) {
  const [settings, setSettings] = useState(loadSettings);
  const configured = isConfigured(settings);
  const [view, setView] = useState<"chat" | "settings">(() => (isConfigured(loadSettings()) ? "chat" : "settings"));
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const historyRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const nextIdRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) list.scrollTop = list.scrollHeight;
  }, [items]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!accountSettings) return;
    const next = { ...accountSettings, rememberKey: loadSettings().rememberKey };
    saveSettings(next);
    setSettings(next);
    if (isConfigured(next)) setView("chat");
  }, [accountSettings]);

  const push = (item: DistributiveOmit<Item, "id">) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setItems((list) => [...list, { ...item, id } as Item]);
    return id;
  };

  const update = (id: number, patch: Partial<DistributiveOmit<Item, "id" | "kind">>) =>
    setItems((list) => list.map((item) => (item.id === id ? ({ ...item, ...patch } as Item) : item)));

  const send = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || running || !configured) return;
    const before = host.getProject();
    const controller = new AbortController();
    abortRef.current = controller;
    stickRef.current = true;
    setDraft("");
    setRunning(true);
    push({ kind: "user", text: prompt });

    let replyId: number | null = null;
    const toolItems = new Map<string, number>();
    try {
      historyRef.current = await runAssistant({
        settings: {
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          authHeader: settings.authHeader,
        },
        host,
        history: compactHistory(historyRef.current),
        prompt,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text") {
            if (replyId === null) replyId = push({ kind: "assistant", text: event.text });
            else update(replyId, { text: event.text });
          } else if (event.type === "message-end") {
            replyId = null;
          } else {
            const existing = toolItems.get(event.id);
            if (existing === undefined) {
              toolItems.set(event.id, push({ kind: "tool", status: event.status, summary: event.summary }));
            } else {
              update(existing, { status: event.status, summary: event.summary });
            }
          }
        },
      });
    } catch (error) {
      historyRef.current = [
        ...historyRef.current,
        { role: "user", content: prompt },
        { role: "assistant", content: "(This request stopped before it finished.)" },
      ];
      for (const id of toolItems.values()) {
        setItems((list) =>
          list.map((item) =>
            item.id === id && item.kind === "tool" && item.status === "running"
              ? { ...item, status: "error" as const }
              : item,
          ),
        );
      }
      if (controller.signal.aborted) push({ kind: "notice", text: "Stopped." });
      else push({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      abortRef.current = null;
      setRunning(false);
      const after = host.getProject();
      const changes = projectChanges(before, after);
      if (changes.length) push({ kind: "changes", changes, before, after, undone: null });
    }
  };

  const undo = (item: Extract<Item, { kind: "changes" }>) => {
    const { project, kept } = undoProjectChanges(host.getProject(), item.before, item.after);
    host.setProject(project);
    update(item.id, { undone: kept });
    historyRef.current = [
      ...historyRef.current,
      { role: "user", content: "Editor note: I undid the changes you made for my previous request." },
    ];
  };

  const newChat = () => {
    historyRef.current = [];
    setItems([]);
    inputRef.current?.focus();
  };

  return (
    <section
      className="pane assistant-pane"
      aria-labelledby="assistant-heading"
      hidden={hidden}
    >
      <header className="pane-header">
        <div className="pane-heading-group">
          <Sparkle size={16} aria-hidden="true" />
          <h2 id="assistant-heading">Assistant</h2>
          {configured && <span className="assistant-model">{settings.model}</span>}
        </div>
        <div className="assistant-header-actions">
          <button
            className="icon-button"
            type="button"
            onClick={newChat}
            disabled={running || items.length === 0}
            aria-label="New chat"
            title="New chat"
          >
            <Plus />
          </button>
          <button
            className={`icon-button${view === "settings" ? " active" : ""}`}
            type="button"
            onClick={() => setView(view === "settings" && configured ? "chat" : "settings")}
            aria-pressed={view === "settings"}
            aria-label="Assistant settings"
            title="Assistant settings"
          >
            <GearSix />
          </button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close assistant" title="Close">
            <X />
          </button>
        </div>
      </header>

      {view === "settings" ? (
        <div className="assistant-scroll">
          <SettingsForm
            key={`${settings.baseUrl}|${settings.model}|${settings.consentedHost}`}
            initial={settings}
            signedIn={Boolean(onSaveAccountSettings)}
            onCancel={configured ? () => setView("chat") : null}
            onSave={(next) => {
              saveSettings(next);
              setSettings(next);
              if (onSaveAccountSettings) {
                onSaveAccountSettings({
                  baseUrl: next.baseUrl,
                  model: next.model,
                  authHeader: next.authHeader,
                  consentedHost: next.consentedHost,
                  apiKey: next.apiKey,
                }).catch((error: unknown) =>
                  push({
                    kind: "error",
                    text: `Saved on this device, but not to your Google account: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  }),
                );
              }
              setView("chat");
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
          />
        </div>
      ) : (
        <>
          <div
            ref={listRef}
            className="assistant-scroll assistant-log"
            role="log"
            aria-live="polite"
            aria-busy={running}
            onScroll={(event) => {
              const list = event.currentTarget;
              stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
            }}
          >
            {items.length === 0 ? (
              <div className="assistant-empty">
                <p>
                  Ask in plain words. The assistant can read, create, edit, rename and delete project files,
                  and compile to check its work. Each request can be undone.
                </p>
                <div className="assistant-suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        setDraft(suggestion);
                        inputRef.current?.focus();
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              items.map((item) => {
                switch (item.kind) {
                  case "user":
                    return (
                      <div key={item.id} className="assistant-user">
                        {item.text}
                      </div>
                    );
                  case "assistant":
                    return <MessageText key={item.id} text={item.text} />;
                  case "tool":
                    return (
                      <div key={item.id} className={`assistant-tool ${item.status}`}>
                        {item.status === "running" ? (
                          <SpinnerGap className="spin" aria-hidden="true" />
                        ) : item.status === "done" ? (
                          <Check aria-hidden="true" />
                        ) : (
                          <WarningCircle aria-hidden="true" />
                        )}
                        <span>{item.summary}</span>
                      </div>
                    );
                  case "changes":
                    return <ChangesCard key={item.id} item={item} onUndo={() => undo(item)} />;
                  case "error":
                    return (
                      <div key={item.id} className="assistant-error" role="alert">
                        <WarningCircle weight="fill" aria-hidden="true" />
                        <span>{item.text}</span>
                      </div>
                    );
                  case "notice":
                    return (
                      <div key={item.id} className="assistant-notice">
                        {item.text}
                      </div>
                    );
                }
              })
            )}
          </div>

          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <textarea
              ref={inputRef}
              value={draft}
              rows={2}
              placeholder="Ask the assistant to edit, fix or explain your document"
              aria-label="Message the assistant"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
            />
            {running ? (
              <button
                type="button"
                className="assistant-stop"
                onClick={() => abortRef.current?.abort()}
              >
                <Stop weight="fill" aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="assistant-send"
                disabled={!draft.trim()}
                aria-label="Send message"
                title="Send (Enter)"
              >
                <PaperPlaneRight weight="fill" aria-hidden="true" />
              </button>
            )}
          </form>
        </>
      )}
    </section>
  );
}
