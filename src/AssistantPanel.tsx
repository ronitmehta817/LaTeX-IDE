import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowCounterClockwise,
  Check,
  GearSix,
  PaperPlaneRight,
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

const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "default", label: "Default thinking" },
  { value: "low", label: "Low thinking" },
  { value: "medium", label: "Medium thinking" },
  { value: "high", label: "High thinking" },
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

function isLocalUrl(baseUrl: string) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl.trim()).hostname);
  } catch {
    return false;
  }
}

function presetFor(baseUrl: string) {
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
  const baseUrl = text(raw.baseUrl).trim();
  if (!baseUrl) return null;
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

type Item =
  | { id: number; kind: "user"; text: string; meta: string }
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
      <p className="assistant-settings-intro">
        {initial ? `Edit ${initial.name}.` : "Add a service that offers the OpenAI chat completions API with tool calling."}
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
            <button type="button" className="secondary-button" onClick={addModel} disabled={!draftModel}>
              <Plus aria-hidden="true" />
              Add
            </button>
          </div>
          {submitted && modelsError && <em role="alert">{modelsError}</em>}
        </div>
      )}

      <div className={`assistant-consent${submitted && !consent ? " invalid" : ""}`}>
        <p>
          Each time you send a message with this service, your messages, the text of your project files and the
          compile log are sent to <strong>{host || "the service above"}</strong>. Its API key is sent only there.
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
          <button type="button" className="secondary-button" onClick={onCancel}>
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
      <p className="assistant-settings-intro">
        Add each AI service you use with its API key and your models, then pick the model and thinking level for
        each message in the chat.
        {signedIn && " These services, their API keys and your models are also saved to your Google Drive."}
      </p>

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
                className="secondary-button assistant-delete-confirm"
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

      <button type="button" className="secondary-button assistant-add-service" onClick={onAdd}>
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
  // undefined until Google Drive has answered; null when Drive has no settings yet.
  accountSettings?: AccountSettings | null;
  onSaveAccountSettings?: (settings: AccountSettings) => Promise<void>;
}) {
  const [config, setConfig] = useState(loadConfig);
  const active = activeChoice(config);
  const usable = config.providers.filter(isUsable);
  const [view, setView] = useState<"chat" | "settings">(() => (activeChoice(loadConfig()) ? "chat" : "settings"));
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const historyRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const nextIdRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Saves run one after another, so Drive never sees two at once.
  const driveSaveRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) list.scrollTop = list.scrollHeight;
  }, [items]);

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

  const send = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || running || !active) return;
    const before = host.getProject();
    const controller = new AbortController();
    abortRef.current = controller;
    stickRef.current = true;
    setDraft("");
    setRunning(true);
    const level = THINKING_LEVELS.find((item) => item.value === active.thinking)?.label ?? "";
    push({ kind: "user", text: prompt, meta: `${active.model} · ${level}` });

    let replyId: number | null = null;
    const toolItems = new Map<string, number>();
    try {
      historyRef.current = await runAssistant({
        settings: {
          baseUrl: active.provider.baseUrl,
          model: active.model,
          apiKey: active.provider.apiKey,
          authHeader: active.provider.authHeader,
          thinking: active.thinking,
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
                        <small className="assistant-model">{item.meta}</small>
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
            {active && (
              <div className="assistant-picker">
                <select
                  aria-label="Model for the next message"
                  value={`${usable.indexOf(active.provider)}:${active.provider.models.indexOf(active.model)}`}
                  disabled={running}
                  onChange={(event) => {
                    const [providerIndex, modelIndex] = event.target.value.split(":").map(Number);
                    const provider = usable[providerIndex];
                    if (provider) choose({ providerId: provider.id, model: provider.models[modelIndex] });
                  }}
                >
                  {usable.map((provider, providerIndex) => (
                    <optgroup key={provider.id} label={provider.name}>
                      {provider.models.map((model, modelIndex) => (
                        <option key={model} value={`${providerIndex}:${modelIndex}`}>
                          {model}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <select
                  aria-label="Thinking level for the next message"
                  value={active.thinking}
                  disabled={running}
                  onChange={(event) => choose({ thinking: event.target.value as ThinkingLevel })}
                >
                  {THINKING_LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="assistant-input">
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
            </div>
          </form>
        </>
      )}
    </section>
  );
}
