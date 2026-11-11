import { Suspense, lazy, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowRight,
  ArrowsInSimple,
  ArrowsOutSimple,
  ArrowUp,
  At,
  Brain,
  CaretDown,
  Check,
  Cpu,
  GearSix,
  NotePencil,
  Paperclip,
  PencilSimple,
  Plus,
  Sparkle,
  SpinnerGap,
  Stop,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  AssistantError,
  compactHistory,
  projectChanges,
  reportError,
  runAssistant,
  undoProjectChanges,
  validateBaseUrl,
  type AssistantHost,
  type AssistantProject,
  type AuthHeader,
  type ChatMessage,
  type FileChange,
  type ThinkingLevel,
  type ToolStatus,
} from "./assistant";

const CONFIG_KEY = "latex-editor:assistant:v2";
const KEYS_KEY = "latex-editor:assistant-keys:v2";
const LEGACY_SETTINGS_KEY = "latex-editor:assistant:v1";
const LEGACY_API_KEY_KEY = "latex-editor:assistant-key:v1";

type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  authHeader: AuthHeader;
  apiKey: string;
  models: string[];
  consentedHost: string;
};

type Choice = { providerId: string; model: string; thinking: ThinkingLevel };

export type AccountSettings = { providers: Provider[]; choice: Choice | null };

type StoredConfig = AccountSettings & { rememberKeys: boolean };

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

const THINKING_LEVELS: { value: ThinkingLevel; label: string; short: string }[] = [
  { value: "default", label: "Default thinking", short: "Default" },
  { value: "low", label: "Low thinking", short: "Low" },
  { value: "medium", label: "Medium thinking", short: "Medium" },
  { value: "high", label: "High thinking", short: "High" },
];

const SUGGESTIONS = [
  "Summarize the PDF, section by section",
  "Fix the compile errors",
  "Proofread the introduction and fix typos",
  "Add a short conclusion section",
];

function hostOf(baseUrl: string) {
  try {
    const url = new URL(baseUrl.trim());
    if (url.pathname.startsWith(NVIDIA_PROXY_PATH)) {
      return NVIDIA_HOST;
    }
    return url.host;
  } catch {
    return "";
  }
}

function isLocalUrl(baseUrl: string) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl.trim()).hostname);
  } catch {
    return false;
  }
}

function presetFor(baseUrl: string) {
  if (baseUrl.includes(NVIDIA_PROXY_PATH)) {
    return PRESETS.find((item) => item.id === "nvidia") ?? PRESETS[PRESETS.length - 1];
  }
  return PRESETS.find((item) => item.baseUrl && item.baseUrl === baseUrl) ?? PRESETS[PRESETS.length - 1];
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

function readJson(value: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const isThinking = (value: unknown): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level.value === value);

function readProvider(value: unknown, fallbackId: string): Provider | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  let baseUrl = text(raw.baseUrl).trim();
  if (!baseUrl) return null;
  if (baseUrl.includes(NVIDIA_PROXY_PATH)) {
    baseUrl = `${window.location.origin}${NVIDIA_PROXY_PATH}v1`;
  }
  const models = Array.isArray(raw.models)
    ? [...new Set(raw.models.map((model) => text(model).trim()).filter(Boolean))]
    : [];
  return {
    id: text(raw.id) || fallbackId,
    name: text(raw.name).trim() || presetFor(baseUrl).label,
    baseUrl,
    authHeader: raw.authHeader === "api-key" ? "api-key" : "bearer",
    apiKey: text(raw.apiKey),
    models,
    consentedHost: text(raw.consentedHost),
  };
}

// Also reads the single-service settings that earlier versions saved.
export function readAccountSettings(value: unknown): AccountSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (!Array.isArray(raw.providers)) {
    const provider = readProvider({ ...raw, models: [raw.model] }, "provider-1");
    return {
      providers: provider ? [provider] : [],
      choice: provider?.models[0]
        ? { providerId: provider.id, model: provider.models[0], thinking: "default" }
        : null,
    };
  }
  const seen = new Set<string>();
  const providers: Provider[] = [];
  raw.providers.forEach((item, index) => {
    const provider = readProvider(item, `provider-${index + 1}`);
    if (!provider) return;
    if (seen.has(provider.id)) provider.id = `${provider.id}-${index + 1}`;
    seen.add(provider.id);
    providers.push(provider);
  });
  const choice = raw.choice && typeof raw.choice === "object" ? (raw.choice as Record<string, unknown>) : null;
  return {
    providers,
    choice: choice
      ? {
          providerId: text(choice.providerId),
          model: text(choice.model),
          thinking: isThinking(choice.thinking) ? choice.thinking : "default",
        }
      : null,
  };
}

function loadConfig(): StoredConfig {
  const saved = readJson(readStorage(local, CONFIG_KEY));
  if (Array.isArray(saved.providers)) {
    const rememberKeys = saved.rememberKeys === true;
    const keys = readJson(readStorage(rememberKeys ? local : session, KEYS_KEY));
    const settings = readAccountSettings(saved);
    return {
      ...settings,
      providers: settings.providers.map((provider) => ({ ...provider, apiKey: text(keys[provider.id]) })),
      rememberKeys,
    };
  }
  const legacy = readJson(readStorage(local, LEGACY_SETTINGS_KEY));
  const rememberKeys = legacy.rememberKey === true;
  const apiKey = readStorage(rememberKeys ? local : session, LEGACY_API_KEY_KEY) ?? "";
  return { ...readAccountSettings({ ...legacy, apiKey }), rememberKeys };
}

// API keys live apart from the settings so "remember" can keep them only for this tab.
function saveConfig(config: StoredConfig) {
  const keys = Object.fromEntries(
    config.providers.filter((provider) => provider.apiKey).map((provider) => [provider.id, provider.apiKey]),
  );
  writeStorage(
    local,
    CONFIG_KEY,
    JSON.stringify({
      providers: config.providers.map((provider) => ({ ...provider, apiKey: "" })),
      choice: config.choice,
      rememberKeys: config.rememberKeys,
    }),
  );
  writeStorage(config.rememberKeys ? local : session, KEYS_KEY, JSON.stringify(keys));
  writeStorage(config.rememberKeys ? session : local, KEYS_KEY, null);
}

const isUsable = (provider: Provider) =>
  provider.models.length > 0 &&
  !validateBaseUrl(provider.baseUrl) &&
  provider.consentedHost === hostOf(provider.baseUrl);

// Falls back to the first usable model when the saved choice was removed.
function activeChoice(config: AccountSettings) {
  const usable = config.providers.filter(isUsable);
  const chosen = usable.find((provider) => provider.id === config.choice?.providerId);
  const thinking = config.choice?.thinking ?? "default";
  if (chosen && config.choice && chosen.models.includes(config.choice.model)) {
    return { provider: chosen, model: config.choice.model, thinking };
  }
  const provider = chosen ?? usable[0];
  return provider ? { provider, model: provider.models[0], thinking } : null;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Retry = { prompt: string; tags: string[]; historyLength: number };

type Item =
  | { id: number; kind: "user"; text: string; meta: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "thinking"; text: string; startedAt: number; endedAt: number | null }
  | { id: number; kind: "tool"; status: ToolStatus; summary: string }
  | { id: number; kind: "context"; text: string }
  | {
      id: number;
      kind: "changes";
      changes: FileChange[];
      // null when a saved chat could not keep the files needed to undo.
      before: AssistantProject | null;
      after: AssistantProject | null;
      undone: string[] | null;
    }
  // `retry` is set on the latest failed request, so it can be sent again.
  | { id: number; kind: "error"; text: string; retry?: Retry }
  | { id: number; kind: "notice"; text: string };

// Chats are saved per project in this browser's local storage, never on a server.
const CHAT_PREFIX = "latex-editor:chat:v1:";
const CHAT_INDEX_KEY = "latex-editor:chats:v1";
const MAX_SAVED_CHATS = 20;
const MAX_SAVED_ITEMS = 300;
const MAX_UNDO_SNAPSHOT_CHARS = 300_000;

type SavedChat = { items: Item[]; history: ChatMessage[] };

const ITEM_KINDS = new Set(["user", "assistant", "thinking", "tool", "context", "changes", "error", "notice"]);

function isItem(value: unknown): value is Item {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "number" || !ITEM_KINDS.has(String(item.kind))) return false;
  if (item.kind === "tool") return typeof item.summary === "string" && typeof item.status === "string";
  if (item.kind === "changes") return Array.isArray(item.changes);
  if (item.kind === "thinking") return typeof item.text === "string" && typeof item.startedAt === "number";
  return typeof item.text === "string";
}

function readChatIndex(): { key: string; savedAt: number }[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(local, CHAT_INDEX_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry) => typeof entry?.key === "string" && typeof entry?.savedAt === "number")
      : [];
  } catch {
    return [];
  }
}

// Only the files a change touched are kept, which is all undo needs.
function changedFiles(project: AssistantProject, paths: string[]): AssistantProject | null {
  const files: AssistantProject["files"] = {};
  for (const path of paths) {
    const file = project.files[path];
    if (!file) continue;
    if (file.kind !== "text") return null;
    files[path] = file;
  }
  return { files, mainFile: project.mainFile, activeFile: project.activeFile };
}

function storableItem(item: Item): Item {
  if (item.kind === "thinking" && item.endedAt === null) return { ...item, endedAt: Date.now() };
  if (item.kind !== "changes" || !item.before || !item.after) return item;
  const paths = item.changes.map((change) => change.path);
  const before = changedFiles(item.before, paths);
  const after = changedFiles(item.after, paths);
  const size = before && after ? JSON.stringify([before.files, after.files]).length : Infinity;
  return size <= MAX_UNDO_SNAPSHOT_CHARS ? { ...item, before, after } : { ...item, before: null, after: null };
}

function loadChat(key: string): SavedChat {
  const saved = readJson(readStorage(local, CHAT_PREFIX + key));
  const items = (Array.isArray(saved.items) ? saved.items : []).filter(isItem).map((item) =>
    // A step that was running when the page closed did not finish.
    item.kind === "tool" && item.status === "running" ? { ...item, status: "error" as const } : item,
  );
  const history = Array.isArray(saved.history) ? (saved.history as ChatMessage[]) : [];
  return { items, history };
}

function saveChat(key: string, items: Item[], history: ChatMessage[]) {
  const index = readChatIndex().filter((entry) => entry.key !== key);
  if (items.length === 0) {
    writeStorage(local, CHAT_PREFIX + key, null);
    writeStorage(local, CHAT_INDEX_KEY, JSON.stringify(index));
    return;
  }
  const value = JSON.stringify({
    items: items.slice(-MAX_SAVED_ITEMS).map(storableItem),
    history: compactHistory(history),
  });
  index.unshift({ key, savedAt: Date.now() });
  const drop = () => writeStorage(local, CHAT_PREFIX + index.pop()!.key, null);
  while (index.length > MAX_SAVED_CHATS) drop();
  for (;;) {
    try {
      window.localStorage.setItem(CHAT_PREFIX + key, value);
      break;
    } catch (error) {
      // When storage is full, the oldest chats make room. Any other failure means
      // storage is unavailable, and the chat lasts only until the page closes.
      const full = error instanceof DOMException && (error.name === "QuotaExceededError" || error.code === 22);
      if (!full || index.length <= 1) return;
      drop();
    }
  }
  writeStorage(local, CHAT_INDEX_KEY, JSON.stringify(index));
}

// Removes the saved chat of a project that no longer exists.
export function forgetChat(key: string) {
  writeStorage(local, CHAT_PREFIX + key, null);
  writeStorage(local, CHAT_INDEX_KEY, JSON.stringify(readChatIndex().filter((entry) => entry.key !== key)));
}

const Markdown = lazy(() => import("./Markdown"));

// Model text as Markdown, with math. It shows as plain text until the renderer has loaded.
function MessageText({
  text,
  className = "assistant-text",
  copy = true,
}: {
  text: string;
  className?: string;
  copy?: boolean;
}) {
  return (
    <Suspense fallback={<div className={`${className} assistant-text-plain`}>{text}</div>}>
      <Markdown text={text} className={className} copy={copy} />
    </Suspense>
  );
}

// The live preview shows the end of the thinking. It starts at a line break when
// one is near, otherwise between words, and never inside a code block.
function recentThinking(text: string, length = 600) {
  if (text.length <= length) return text;
  const cut = text.length - length;
  const lineBreak = text.lastIndexOf("\n", cut);
  let start = lineBreak >= 0 && cut - lineBreak <= 300 ? lineBreak : Math.max(text.lastIndexOf(" ", cut), 0);
  if (text.slice(0, start).split("```").length % 2 === 0) start = text.lastIndexOf("```", start);
  return text.slice(start).trimStart();
}

function ProviderForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Provider | null;
  onSave: (provider: Provider) => void;
  onCancel: (() => void) | null;
}) {
  const [preset, setPreset] = useState(() => (initial ? presetFor(initial.baseUrl).id : PRESETS[0].id));
  const presetInfo = PRESETS.find((item) => item.id === preset) ?? PRESETS[PRESETS.length - 1];
  const [name, setName] = useState(initial?.name ?? PRESETS[0].label);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [authHeader, setAuthHeader] = useState<AuthHeader>(initial?.authHeader ?? PRESETS[0].authHeader);
  const [models, setModels] = useState(initial?.models ?? []);
  const [modelDraft, setModelDraft] = useState("");
  const host = hostOf(baseUrl);
  const [consent, setConsent] = useState(Boolean(initial && host && initial.consentedHost === host));
  const [submitted, setSubmitted] = useState(false);

  const urlError = validateBaseUrl(baseUrl);
  const keyError = apiKey.trim() || isLocalUrl(baseUrl) ? "" : "Paste the API key for this service.";
  // Model names are asked for only once the service can be reached with a key.
  const connected = !urlError && !keyError;
  const draftModel = modelDraft.trim();
  const finalModels = draftModel && !models.includes(draftModel) ? [...models, draftModel] : models;
  const modelsError = finalModels.length ? "" : "Add at least one model name.";

  const choosePreset = (id: string) => {
    const next = PRESETS.find((item) => item.id === id);
    if (!next) return;
    if (!name.trim() || name === presetInfo.label) setName(next.label);
    setPreset(id);
    setBaseUrl(next.baseUrl);
    setAuthHeader(next.authHeader);
    setConsent(false);
  };

  const addModel = () => {
    if (!draftModel) return;
    setModels(finalModels);
    setModelDraft("");
  };

  return (
    <form
      className="assistant-settings"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (!connected || modelsError || !consent) return;
        onSave({
          id: initial?.id ?? crypto.randomUUID(),
          name: name.trim() || presetInfo.label,
          baseUrl: baseUrl.trim(),
          authHeader,
          apiKey: apiKey.trim(),
          models: finalModels,
          consentedHost: host,
        });
      }}
    >
      <header className="assistant-title">
        <h3>
          {initial ? "Edit " : "Add a "}
          <span className="accent">{initial ? initial.name : "service"}</span>
        </h3>
        <p>Any service with the OpenAI chat completions API and tool calling</p>
      </header>

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
        <span>Name</span>
        <input
          value={name}
          placeholder={presetInfo.label}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
        <small className="assistant-field-note">Shown above this service's models in the chat.</small>
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
            setConsent(
              Boolean(initial?.consentedHost) && hostOf(event.target.value) === initial?.consentedHost,
            );
          }}
        />
        {submitted && urlError && <em role="alert">{urlError}</em>}
        {presetInfo.note && <small className="assistant-field-note">{presetInfo.note}</small>}
      </label>

      <label className="assistant-field">
        <span>API key</span>
        <input
          type="password"
          value={apiKey}
          placeholder={isLocalUrl(baseUrl) ? "Not needed for a service on this computer" : "Paste your API key"}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={submitted && Boolean(keyError)}
          onChange={(event) => setApiKey(event.target.value)}
        />
        {submitted && keyError && <em role="alert">{keyError}</em>}
      </label>

      <label className="assistant-field">
        <span>Key header</span>
        <select value={authHeader} onChange={(event) => setAuthHeader(event.target.value as AuthHeader)}>
          <option value="bearer">Authorization: Bearer (most services)</option>
          <option value="api-key">api-key (Azure OpenAI)</option>
        </select>
      </label>

      {connected && (
        <div className="assistant-field">
          <span id="assistant-models-label">Your models</span>
          <small className="assistant-field-note">
            Enter the model names you want to choose from in the chat, exactly as the service spells them. The first
            one is used by default.
          </small>
          {models.length > 0 && (
            <ul className="assistant-models" aria-labelledby="assistant-models-label">
              {models.map((model) => (
                <li key={model}>
                  <code>{model}</code>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${model}`}
                    title="Remove"
                    onClick={() => setModels(models.filter((item) => item !== model))}
                  >
                    <X />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="assistant-model-add">
            <input
              value={modelDraft}
              placeholder={presetInfo.model}
              spellCheck={false}
              autoComplete="off"
              aria-label="Model name"
              aria-invalid={submitted && Boolean(modelsError)}
              onChange={(event) => setModelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                addModel();
              }}
            />
            <button type="button" className="assistant-pill" onClick={addModel} disabled={!draftModel}>
              <Plus aria-hidden="true" />
              Add
            </button>
          </div>
          {submitted && modelsError && <em role="alert">{modelsError}</em>}
        </div>
      )}

      <div className={`assistant-consent${submitted && !consent ? " invalid" : ""}`}>
        <p>
          Each time you send a message with this service, your messages, the text of your project files and
          compiled PDF, and the compile log are sent to <strong>{host || "the service above"}</strong>. Its API key
          is sent only there.
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
        {submitted && !consent && <em role="alert">Confirm before using the assistant.</em>}
      </div>

      <div className="assistant-settings-actions">
        <span className="assistant-spacer" />
        {onCancel && (
          <button type="button" className="assistant-pill" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="assistant-primary">
          {connected ? "Save" : "Continue"}
        </button>
      </div>
    </form>
  );
}

function ServiceList({
  config,
  signedIn,
  onAdd,
  onEdit,
  onDelete,
  onRememberKeys,
  onDone,
}: {
  config: StoredConfig;
  signedIn: boolean;
  onAdd: () => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRememberKeys: (remember: boolean) => void;
  onDone: (() => void) | null;
}) {
  const [confirmId, setConfirmId] = useState("");

  return (
    <div className="assistant-settings">
      <header className="assistant-title">
        <h3>
          Your <span className="accent">services</span>
        </h3>
        <p>
          Each with its API key and your models. Pick the model and thinking level for each message in the chat.
          {signedIn && " Saved to your Google Drive."}
        </p>
      </header>

      <ul className="assistant-services">
        {config.providers.map((provider) => (
          <li key={provider.id} className="assistant-service">
            <div>
              <strong>{provider.name}</strong>
              <small>
                {isUsable(provider)
                  ? provider.models.join(", ")
                  : "Not ready yet. Edit it to add models and confirm sending."}
              </small>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={`Edit ${provider.name}`}
              title="Edit"
              onClick={() => onEdit(provider)}
            >
              <PencilSimple />
            </button>
            {confirmId === provider.id ? (
              <button
                type="button"
                className="assistant-pill assistant-delete-confirm"
                autoFocus
                onClick={() => {
                  setConfirmId("");
                  onDelete(provider);
                }}
                onBlur={() => setConfirmId("")}
              >
                Delete
              </button>
            ) : (
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${provider.name}`}
                title="Delete"
                onClick={() => setConfirmId(provider.id)}
              >
                <Trash />
              </button>
            )}
          </li>
        ))}
      </ul>

      <button type="button" className="assistant-pill assistant-add-service" onClick={onAdd}>
        <Plus aria-hidden="true" />
        Add a service
      </button>

      <label className="assistant-check">
        <input
          type="checkbox"
          checked={config.rememberKeys}
          onChange={(event) => onRememberKeys(event.target.checked)}
        />
        <span>Remember the API keys on this browser. When off, they are kept only until this tab closes.</span>
      </label>

      {onDone && (
        <div className="assistant-settings-actions">
          <span className="assistant-spacer" />
          <button type="button" className="assistant-primary" onClick={onDone}>
            Done
          </button>
        </div>
      )}
    </div>
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
        ) : item.before && item.after ? (
          <button type="button" className="assistant-undo" onClick={onUndo}>
            <ArrowCounterClockwise aria-hidden="true" /> Undo AI changes
          </button>
        ) : (
          <span className="assistant-undone">Undo was not saved for this change</span>
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

// Whole seconds from start to end, counting up once a second until there is an end.
function useSeconds(start: number, end: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (end !== null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [end]);
  return Math.max(0, Math.round(((end ?? now) - start) / 1000));
}

function WaitingStep({ model, since }: { model: string; since: number }) {
  const seconds = useSeconds(since, null);
  return (
    <div className="assistant-tool running" role="status">
      <SpinnerGap className="spin" aria-hidden="true" />
      <span>
        Waiting for {model}
        {seconds >= 2 && <span aria-hidden="true"> · {seconds}s</span>}
      </span>
    </div>
  );
}

function ThinkingStep({ item }: { item: Extract<Item, { kind: "thinking" }> }) {
  const seconds = useSeconds(item.startedAt, item.endedAt);
  if (item.endedAt === null) {
    return (
      <div className="assistant-tool assistant-thinking running">
        <div className="assistant-thinking-head" role="status">
          <SpinnerGap className="spin" aria-hidden="true" />
          <span>
            Thinking<span aria-hidden="true"> · {seconds}s</span>
          </span>
        </div>
        <div className="assistant-thinking-live" aria-hidden="true">
          <MessageText
            text={recentThinking(item.text)}
            className="assistant-text assistant-thinking-markdown"
            copy={false}
          />
        </div>
      </div>
    );
  }
  return (
    <details className="assistant-tool assistant-thinking done">
      <summary className="assistant-thinking-head">
        <Brain aria-hidden="true" />
        <span>{seconds < 1 ? "Thought briefly" : `Thought for ${seconds}s`}</span>
        <CaretDown className="assistant-thinking-caret" weight="bold" aria-hidden="true" />
      </summary>
      <div className="assistant-thinking-text">
        <MessageText text={item.text.trim()} className="assistant-text assistant-thinking-markdown" />
      </div>
    </details>
  );
}

type MenuGroup = { label?: string; options: { value: string; label: string }[] };

// A picker that draws its own list: a native select opens in the operating
// system's style, which differs between Windows, macOS and Linux.
function ChipMenu({
  icon,
  label,
  text,
  groups,
  value,
  empty = "Nothing to choose",
  mono = false,
  disabled = false,
  className = "",
  onOpen,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  text: string;
  groups: MenuGroup[];
  value?: string;
  empty?: string;
  mono?: boolean;
  disabled?: boolean;
  className?: string;
  onOpen?: () => void;
  onSelect: (value: string) => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const options = groups.flatMap((group) => group.options);
  const optionId = (index: number) => `${id}-option-${index}`;
  const current = options.find((option) => option.value === value)?.label;
  const description = current ? `${label}: ${current}` : label;

  const show = () => {
    onOpen?.();
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  const hide = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const pick = (index: number) => {
    const option = options[index];
    if (!option) return;
    hide(true);
    onSelect(option.value);
  };

  const move = (step: number) => {
    if (options.length) setActive((current) => (current + step + options.length) % options.length);
  };

  // The list opens above the chip and shifts sideways to stay inside the message box.
  useLayoutEffect(() => {
    const list = listRef.current;
    const root = rootRef.current;
    if (!open || !list || !root) return;
    list.style.left = "0px";
    const bounds = (root.closest(".assistant-box, .assistant-log") ?? document.body).getBoundingClientRect();
    const anchor = root.getBoundingClientRect();
    const overflow = anchor.left + list.offsetWidth - bounds.right;
    list.style.left = `${Math.max(bounds.left - anchor.left, Math.min(0, -overflow))}px`;
    list.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  let index = -1;
  return (
    <span ref={rootRef} className={`assistant-chip${className ? ` ${className}` : ""}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={description}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        title={current ? description : label}
        disabled={disabled}
        onClick={() => (open ? hide(false) : show())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) show();
        }}
      >
        {icon}
        <span className="assistant-chip-text">{text}</span>
        <CaretDown className="assistant-chip-caret" weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={listRef}
          id={`${id}-list`}
          className={`assistant-menu${mono ? " mono" : ""}`}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={options.length ? optionId(active) : undefined}
          onKeyDown={(event) => {
            switch (event.key) {
              case "ArrowDown":
                move(1);
                break;
              case "ArrowUp":
                move(-1);
                break;
              case "Home":
                setActive(0);
                break;
              case "End":
                setActive(Math.max(0, options.length - 1));
                break;
              case "Enter":
              case " ":
                pick(active);
                break;
              case "Escape":
                hide(true);
                break;
              case "Tab":
                hide(true);
                return;
              default:
                return;
            }
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {options.length === 0 && <p className="assistant-menu-empty">{empty}</p>}
          {groups.map((group, groupIndex) =>
            group.options.length === 0 ? null : (
              <div key={group.label ?? groupIndex} role="group" aria-label={group.label}>
                {group.label && (
                  <div className="assistant-menu-label" aria-hidden="true">
                    {group.label}
                  </div>
                )}
                {group.options.map((option) => {
                  index += 1;
                  const optionIndex = index;
                  const selected = option.value === value;
                  return (
                    <div
                      key={option.value}
                      id={optionId(optionIndex)}
                      role="option"
                      aria-selected={selected}
                      className={`assistant-menu-option${optionIndex === active ? " active" : ""}`}
                      onPointerMove={() => setActive(optionIndex)}
                      onClick={() => pick(optionIndex)}
                    >
                      <span>{option.label}</span>
                      {selected && <Check weight="bold" aria-hidden="true" />}
                    </div>
                  );
                })}
              </div>
            ),
          )}
        </div>
      )}
    </span>
  );
}

const nextItemId = (items: Item[]) => items.reduce((max, item) => Math.max(max, item.id), 0) + 1;

export default function AssistantPanel({
  host,
  hidden,
  chatKey,
  request,
  onClose,
  accountSettings,
  onSaveAccountSettings,
  isExpanded,
  onToggleExpand,
}: {
  host: AssistantHost;
  hidden: boolean;
  // Names the open project's saved chat.
  chatKey: string;
  // A message to send from elsewhere in the editor; a new id sends it.
  request?: { id: number; text: string } | null;
  onClose: () => void;
  // undefined until Google Drive has answered; null when Drive has no settings yet.
  accountSettings?: AccountSettings | null;
  onSaveAccountSettings?: (settings: AccountSettings) => Promise<void>;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [config, setConfig] = useState(loadConfig);
  const active = activeChoice(config);
  const usable = config.providers.filter(isUsable);
  const [view, setView] = useState<"chat" | "settings">(() => (activeChoice(loadConfig()) ? "chat" : "settings"));
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [initialChat] = useState(() => loadChat(chatKey));
  // The items and the chat they belong to change together, so a save never mixes two projects.
  const [chat, setChat] = useState({ key: chatKey, items: initialChat.items });
  const items = chat.items;
  const setItems = (next: Item[] | ((list: Item[]) => Item[])) =>
    setChat((current) => ({ ...current, items: typeof next === "function" ? next(current.items) : next }));
  const [draft, setDraft] = useState("");
  const [tagged, setTagged] = useState<string[]>([]);
  const textPaths = () =>
    Object.keys(host.getProject().files)
      .filter((path) => host.isTextPath(path))
      .sort((a, b) => a.localeCompare(b));
  const [paths, setPaths] = useState(textPaths);
  const [running, setRunning] = useState(false);
  // Set while a request has been sent and nothing has come back yet.
  const [waiting, setWaiting] = useState<{ model: string; since: number } | null>(null);
  const historyRef = useRef<ChatMessage[]>(initialChat.history);
  const abortRef = useRef<AbortController | null>(null);
  // Each request gets a number; a request whose number is no longer current is ignored.
  const runRef = useRef(0);
  const nextIdRef = useRef(nextItemId(initialChat.items));
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Saves run one after another, so Drive never sees two at once.
  const driveSaveRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveRef = useRef<{ key: string; items: Item[] } | null>(null);
  const saveTimerRef = useRef(0);
  const handledRequestRef = useRef(0);

  const flushSave = () => {
    window.clearTimeout(saveTimerRef.current);
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) saveChat(pending.key, pending.items, historyRef.current);
  };

  // While a reply streams, the chat is saved once a second; otherwise straight away.
  useEffect(() => {
    pendingSaveRef.current = chat;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushSave, running ? 1000 : 0);
  }, [chat, running]);

  useEffect(() => {
    window.addEventListener("pagehide", flushSave);
    return () => {
      window.removeEventListener("pagehide", flushSave);
      flushSave();
    };
  }, []);

  // Another project was opened: stop the request for the previous one and show this project's chat.
  useLayoutEffect(() => {
    if (chat.key === chatKey) return;
    if (abortRef.current) {
      pendingSaveRef.current = {
        key: chat.key,
        items: [
          ...chat.items,
          { id: nextIdRef.current, kind: "notice", text: "Stopped, because another project was opened." },
        ],
      };
    }
    runRef.current += 1;
    abortRef.current?.abort();
    flushSave();
    const saved = loadChat(chatKey);
    historyRef.current = saved.history;
    nextIdRef.current = nextItemId(saved.items);
    setChat({ key: chatKey, items: saved.items });
  }, [chatKey]);

  // The Markdown renderer loads in the background once the panel opens, before the first reply.
  useEffect(() => {
    if (!hidden) void import("./Markdown");
  }, [hidden]);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) list.scrollTop = list.scrollHeight;
  }, [items, waiting]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const push = (item: DistributiveOmit<Item, "id">) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setItems((list) => [...list, { ...item, id } as Item]);
    return id;
  };

  const update = (id: number, patch: Partial<DistributiveOmit<Item, "id" | "kind">>) =>
    setItems((list) => list.map((item) => (item.id === id ? ({ ...item, ...patch } as Item) : item)));

  const commit = (next: StoredConfig) => {
    saveConfig(next);
    setConfig(next);
    if (!onSaveAccountSettings) return;
    const save = onSaveAccountSettings;
    driveSaveRef.current = driveSaveRef.current
      .then(() => save({ providers: next.providers, choice: next.choice }))
      .catch((error: unknown) => {
        push({
          kind: "error",
          text: `Saved on this device, but not to your Google Drive: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  };

  useEffect(() => {
    if (accountSettings === undefined) return;
    if (accountSettings === null) {
      const current = loadConfig();
      if (current.providers.length > 0) commit(current);
      return;
    }
    const next = { ...accountSettings, rememberKeys: loadConfig().rememberKeys };
    saveConfig(next);
    setConfig(next);
    if (activeChoice(next)) setView("chat");
  }, [accountSettings]);

  const choose = (patch: Partial<Choice>) => {
    if (!active) return;
    commit({
      ...config,
      choice: { providerId: active.provider.id, model: active.model, thinking: active.thinking, ...patch },
    });
  };

  // `fromComposer` sends what is typed in the box; retries and requests from the
  // editor bring their own text and tags, and may name another model.
  const send = async (
    text: string,
    {
      fromComposer = false,
      tags: givenTags,
      choice,
    }: { fromComposer?: boolean; tags?: string[]; choice?: { provider: Provider; model: string } } = {},
  ) => {
    const prompt = text.trim();
    if (!prompt || running || !active) return;
    const current = choice ? { ...active, ...choice } : active;
    const before = host.getProject();
    // Files tagged in the picker, plus any @path typed in the message that names a project file.
    const mentioned = [...prompt.matchAll(/@([^\s@]+)/g)].map((match) => match[1].replace(/[.,;:!?)]+$/, ""));
    const tags = givenTags ?? [...new Set([...tagged, ...mentioned])].filter((path) => path in before.files);
    const controller = new AbortController();
    abortRef.current = controller;
    const run = runRef.current + 1;
    runRef.current = run;
    const live = () => runRef.current === run;
    stickRef.current = true;
    if (fromComposer) {
      setDraft("");
      setTagged([]);
    }
    setRunning(true);
    // Only the latest failure can be retried.
    setItems((list) => list.map((item) => (item.kind === "error" && item.retry ? { ...item, retry: undefined } : item)));
    const level = THINKING_LEVELS.find((item) => item.value === current.thinking)?.label ?? "";
    const tagNote = tags.length ? ` · ${tags.map((path) => `@${path}`).join(" ")}` : "";
    push({ kind: "user", text: prompt, meta: `${current.model} · ${level}${tagNote}` });

    let replyId: number | null = null;
    let thinkingId: number | null = null;
    const model = current.model;
    const service = hostOf(current.provider.baseUrl);
    const started = Date.now();
    const toolItems = new Map<string, number>();
    try {
      const result = await runAssistant({
        settings: {
          baseUrl: current.provider.baseUrl,
          model: current.model,
          apiKey: current.provider.apiKey,
          authHeader: current.provider.authHeader,
          thinking: current.thinking,
        },
        host,
        history: compactHistory(historyRef.current),
        prompt,
        tagged: tags,
        signal: controller.signal,
        onEvent: (event) => {
          if (!live()) return;
          setWaiting(event.type === "waiting" ? { model, since: Date.now() } : null);
          if (event.type === "context") {
            push({ kind: "context", text: event.summary });
          } else if (event.type === "waiting") {
            replyId = null;
          } else if (event.type === "thinking") {
            if (thinkingId === null) {
              thinkingId = push({ kind: "thinking", text: event.text, startedAt: Date.now(), endedAt: null });
            } else {
              update(thinkingId, { text: event.text });
            }
          } else if (event.type === "thinking-end") {
            if (thinkingId !== null) update(thinkingId, { endedAt: Date.now() });
            thinkingId = null;
          } else if (event.type === "text") {
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
      if (live()) historyRef.current = result;
    } catch (error) {
      if (!live()) return;
      const historyLength = historyRef.current.length;
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
      if (controller.signal.aborted) {
        push({ kind: "notice", text: "Stopped." });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        push({ kind: "error", text: message, retry: { prompt, tags, historyLength } });
        reportError({
          source: "assistant",
          service,
          model,
          status: error instanceof AssistantError ? error.status : 0,
          message,
          ms: Date.now() - started,
        });
      }
    } finally {
      setWaiting(null);
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
      if (live()) {
        if (thinkingId !== null) update(thinkingId, { endedAt: Date.now() });
        const after = host.getProject();
        const changes = projectChanges(before, after);
        if (changes.length) push({ kind: "changes", changes, before, after, undone: null });
      }
    }
  };

  // Sends a failed request again, optionally with another model, in place of the failed attempt.
  const retry = (item: Extract<Item, { kind: "error" }>, choice?: { provider: Provider; model: string }) => {
    if (!item.retry || running) return;
    const { prompt, tags, historyLength } = item.retry;
    if (historyRef.current.length === historyLength + 2) historyRef.current = historyRef.current.slice(0, historyLength);
    if (choice) choose({ providerId: choice.provider.id, model: choice.model });
    void send(prompt, { tags, choice });
  };

  useEffect(() => {
    if (!request || request.id === handledRequestRef.current) return;
    handledRequestRef.current = request.id;
    if (running || !active) {
      setDraft(request.text);
      return;
    }
    setEditing(null);
    setView("chat");
    void send(request.text);
  }, [request]);

  const undo = (item: Extract<Item, { kind: "changes" }>) => {
    if (!item.before || !item.after) return;
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

  const showChat = () => {
    setEditing(null);
    setView("chat");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const formTarget = editing ?? (config.providers.length === 0 ? "new" : null);
  const settingsOpen = view === "settings" || !active;

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
        </div>
        <div className="assistant-header-actions">
          {onToggleExpand && (
            <button
              className={`icon-button${isExpanded ? " active" : ""}`}
              type="button"
              onClick={onToggleExpand}
              aria-label={isExpanded ? "Restore assistant width" : "Expand assistant width"}
              title={isExpanded ? "Restore width" : "Expand width"}
            >
              {isExpanded ? <ArrowsInSimple /> : <ArrowsOutSimple />}
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            onClick={newChat}
            disabled={running || items.length === 0}
            aria-label="New chat"
            title="New chat"
          >
            <NotePencil />
          </button>
          <button
            className={`icon-button${settingsOpen ? " active" : ""}`}
            type="button"
            onClick={() => (settingsOpen && active ? showChat() : setView("settings"))}
            aria-pressed={settingsOpen}
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

      {settingsOpen ? (
        <div className="assistant-scroll">
          {formTarget ? (
            <ProviderForm
              key={formTarget === "new" ? "new" : formTarget.id}
              initial={formTarget === "new" ? null : formTarget}
              onCancel={config.providers.length > 0 ? () => setEditing(null) : null}
              onSave={(provider) => {
                const exists = config.providers.some((item) => item.id === provider.id);
                const next: StoredConfig = {
                  ...config,
                  providers: exists
                    ? config.providers.map((item) => (item.id === provider.id ? provider : item))
                    : [...config.providers, provider],
                };
                if (!exists) next.choice = { providerId: provider.id, model: provider.models[0], thinking: "default" };
                commit(next);
                setEditing(null);
                if (!active) showChat();
              }}
            />
          ) : (
            <ServiceList
              config={config}
              signedIn={Boolean(onSaveAccountSettings)}
              onAdd={() => setEditing("new")}
              onEdit={setEditing}
              onDelete={(provider) =>
                commit({ ...config, providers: config.providers.filter((item) => item.id !== provider.id) })
              }
              onRememberKeys={(rememberKeys) => commit({ ...config, rememberKeys })}
              onDone={active ? showChat : null}
            />
          )}
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
                <h3 className="assistant-hero">
                  Ask the <span className="accent">PDF</span>
                </h3>
                <p className="assistant-caption">
                  <strong>Reads your compiled PDF before every answer</strong>
                  <br />
                  Edits, creates and renames files. Tag a file with @ to say where a change goes. Every
                  request can be undone.
                </p>
                <ul className="assistant-suggestions">
                  {SUGGESTIONS.map((suggestion, index) => (
                    <li key={suggestion} style={{ "--i": index } as React.CSSProperties}>
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(suggestion);
                          inputRef.current?.focus();
                        }}
                      >
                        <span>{suggestion}</span>
                        <ArrowRight aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              items.map((item) => {
                switch (item.kind) {
                  case "user":
                    return (
                      <div key={item.id} className="assistant-turn">
                        <div className="assistant-user">{item.text}</div>
                        <small className="assistant-meta">{item.meta}</small>
                      </div>
                    );
                  case "assistant":
                    return <MessageText key={item.id} text={item.text} />;
                  case "thinking":
                    return <ThinkingStep key={item.id} item={item} />;
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
                  case "context":
                    return (
                      <div key={item.id} className="assistant-tool context">
                        <Paperclip aria-hidden="true" />
                        <span>{item.text}</span>
                      </div>
                    );
                  case "changes":
                    return <ChangesCard key={item.id} item={item} onUndo={() => undo(item)} />;
                  case "error":
                    return (
                      <div key={item.id} className="assistant-error-group">
                        <div className="assistant-error" role="alert">
                          <WarningCircle weight="fill" aria-hidden="true" />
                          <span>{item.text}</span>
                        </div>
                        {item.retry && active && (
                          <div className="assistant-retry">
                            <button
                              type="button"
                              className="assistant-pill"
                              disabled={running}
                              onClick={() => retry(item)}
                            >
                              <ArrowClockwise aria-hidden="true" />
                              Retry
                            </button>
                            <ChipMenu
                              className="model"
                              icon={<Cpu aria-hidden="true" />}
                              label="Retry with another model"
                              text="Retry with another model"
                              disabled={running}
                              value=""
                              groups={usable.map((provider, providerIndex) => ({
                                label: provider.name,
                                options: provider.models.map((model, modelIndex) => ({
                                  value: `${providerIndex}:${modelIndex}`,
                                  label: model,
                                })),
                              }))}
                              onSelect={(value) => {
                                const [providerIndex, modelIndex] = value.split(":").map(Number);
                                const provider = usable[providerIndex];
                                if (provider) retry(item, { provider, model: provider.models[modelIndex] });
                              }}
                            />
                          </div>
                        )}
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
            {running && waiting && <WaitingStep model={waiting.model} since={waiting.since} />}
          </div>

          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft, { fromComposer: true });
            }}
          >
            <div className="assistant-box">
              {tagged.length > 0 && (
                <div className="assistant-tags">
                  {tagged.map((path) => (
                    <span key={path} className="assistant-tag">
                      @{path}
                      <button
                        type="button"
                        aria-label={`Untag ${path}`}
                        title="Untag"
                        onClick={() => setTagged(tagged.filter((item) => item !== path))}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={draft}
                rows={2}
                placeholder="Ask about the PDF, or ask for a change"
                aria-label="Message the assistant"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send(draft, { fromComposer: true });
                  }
                }}
              />
              <div className="assistant-bar">
                {active && (
                  <>
                    <ChipMenu
                      className="model"
                      icon={<Cpu aria-hidden="true" />}
                      label="Model for the next message"
                      text={active.model.split("/").pop() || active.model}
                      mono
                      disabled={running}
                      value={`${usable.indexOf(active.provider)}:${active.provider.models.indexOf(active.model)}`}
                      groups={usable.map((provider, providerIndex) => ({
                        label: provider.name,
                        options: provider.models.map((model, modelIndex) => ({
                          value: `${providerIndex}:${modelIndex}`,
                          label: model,
                        })),
                      }))}
                      onSelect={(value) => {
                        const [providerIndex, modelIndex] = value.split(":").map(Number);
                        const provider = usable[providerIndex];
                        if (provider) choose({ providerId: provider.id, model: provider.models[modelIndex] });
                      }}
                    />
                    <ChipMenu
                      icon={<Brain aria-hidden="true" />}
                      label="Thinking level for the next message"
                      text={THINKING_LEVELS.find((level) => level.value === active.thinking)?.short ?? "Default"}
                      disabled={running}
                      value={active.thinking}
                      groups={[
                        {
                          label: "Thinking",
                          options: THINKING_LEVELS.map((level) => ({ value: level.value, label: level.short })),
                        },
                      ]}
                      onSelect={(value) => choose({ thinking: value as ThinkingLevel })}
                    />
                  </>
                )}
                <ChipMenu
                  className="tag"
                  icon={<At aria-hidden="true" />}
                  label="Tag a file for the assistant to change"
                  text="Tag a file"
                  mono
                  disabled={running}
                  empty={paths.length ? "Every file is tagged" : "No text files yet"}
                  groups={[
                    {
                      label: "Edit this file",
                      options: paths
                        .filter((path) => !tagged.includes(path))
                        .map((path) => ({ value: path, label: path })),
                    },
                  ]}
                  onOpen={() => setPaths(textPaths())}
                  onSelect={(path) => {
                    if (!tagged.includes(path)) setTagged([...tagged, path]);
                  }}
                />
                <span className="assistant-spacer" />
                {running ? (
                  <button
                    type="button"
                    className="assistant-send stop"
                    onClick={() => abortRef.current?.abort()}
                    aria-label="Stop"
                    title="Stop"
                  >
                    <Stop weight="fill" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="assistant-send"
                    disabled={!draft.trim()}
                    aria-label="Send message"
                    title="Send (Enter)"
                  >
                    <ArrowUp weight="bold" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
