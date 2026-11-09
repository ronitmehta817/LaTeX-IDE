import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import CodeMirror from "@uiw/react-codemirror";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { openSearchPanel, search } from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type {
  PageViewport,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import {
  ArrowClockwise,
  ArrowsLeftRight,
  ArrowsOutSimple,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  CheckCircle,
  Cloud,
  CloudArrowUp,
  DotsThreeVertical,
  DownloadSimple,
  Export,
  File,
  FilePdf,
  FileText,
  FolderOpen,
  GoogleLogo,
  MagnifyingGlass,
  Minus,
  PencilSimple,
  Play,
  Plus,
  SidebarSimple,
  SignOut,
  Sparkle,
  SpinnerGap,
  Trash,
  Warning,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { strToU8, unzipSync, zipSync } from "fflate";
import { SiglumCompiler, resolveRuntime } from "@siglum/engine";
import type { CompileResult } from "@siglum/engine/compiler";
import workerUrl from "@siglum/engine/worker?url";
import type { AssistantHost, AssistantProject, CompileSummary } from "./assistant";
import AssistantPanel, { readAccountSettings, type AccountSettings } from "./AssistantPanel";
import "./styles.css";

const STARTER_SOURCE = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath}

\title{A Browser-Compiled Document}
\author{LaTeX Editor}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
This document is compiled locally in your browser. Edit the source,
then press \textbf{Compile} or use \texttt{Cmd+Enter}.

\section{An equation}
The Gaussian integral is
\[
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\]

\section{Notes}
\begin{itemize}
  \item Your source stays on this device.
  \item The last successful PDF remains available after an error.
  \item Download the source at any time.
\end{itemize}

\end{document}
`;

const EDITOR_THEME = [
  EditorView.theme(
    {
      "&": { color: "#dadbdb", backgroundColor: "#030407" },
      ".cm-content": { caretColor: "#f2a65a" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#f2a65a" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "rgb(107 61 0 / 85%)" },
      ".cm-activeLine": { backgroundColor: "rgb(26 46 82 / 35%)" },
      ".cm-gutters": {
        backgroundColor: "#030407",
        color: "#85878a",
        borderRight: "1px solid rgb(255 255 255 / 12%)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "rgb(255 255 255 / 4%)",
        color: "#dadbdb",
      },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: "transparent",
        outline: "1px solid rgb(242 166 90 / 70%)",
      },
      ".cm-searchMatch": {
        backgroundColor: "rgb(242 166 90 / 16%)",
        outline: "1px solid rgb(242 166 90 / 45%)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "rgb(242 166 90 / 40%)",
      },
      ".cm-selectionMatch": { backgroundColor: "rgb(255 255 255 / 8%)" },
      ".cm-foldPlaceholder": {
        border: "none",
        backgroundColor: "rgb(255 255 255 / 10%)",
        color: "#a8aaab",
      },
      ".cm-tooltip": {
        border: "none",
        backgroundColor: "#000",
        boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 28%)",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "#1a2e52",
        color: "#fff",
      },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.tagName, color: "#f2a65a" },
      { tag: [tags.atom, tags.number, tags.string], color: "#9db8e8" },
      { tag: tags.keyword, color: "#5fd3c4" },
      { tag: tags.bracket, color: "#85878a" },
      { tag: tags.comment, color: "#85878a", fontStyle: "italic" },
      { tag: tags.invalid, color: "#ff6b6b" },
    ]),
  ),
];

const EDITOR_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
  rectangularSelection: true,
  searchKeymap: true,
  tabSize: 2,
};

// EC/TC (T1, TS1) and Cyrillic Computer Modern fonts, including the default
// itemize bullet, only have Type 1 outlines in the deferred cm-super bundle
// (about 60 MB), which the engine does not load for a missing font on its own.
const CM_SUPER_FONT_ERROR =
  /\(file (?:ec|tc|la|lb|lc|rx)[a-z]{2}\d{4}\): Font \S+ at \d+ not found/;

const SYNCTEX_RECORD =
  /^([(xkg$hvr])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;
const SCALED_POINTS_PER_PDF_POINT = 65781.76;

const DRAFT_KEY = "latex-editor:draft:v1";
const PROJECT_KEY = "latex-editor:project:v2";
const NAME_KEY = "latex-editor:name:v1";
const SPLIT_KEY = "latex-editor:split:v1";
const EXPLORER_WIDTH_KEY = "latex-editor:explorer-width:v1";
const EXPLORER_HIDDEN_KEY = "latex-editor:explorer-hidden:v1";
const ASSISTANT_OPEN_KEY = "latex-editor:assistant-open:v1";
const DRIVE_PROJECT_KEY = "latex-editor:drive-project:v1";
const DRIVE_DIRTY_KEY = "latex-editor:drive-dirty:v1";
const GOOGLE_RETURN_KEY = "latex-editor:google-return:v1";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_SAVE_DELAY = 3000;
const EXPLORER_DEFAULT_WIDTH = 172;
const EXPLORER_MIN_WIDTH = 120;
const EXPLORER_MAX_WIDTH = 480;
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const MAX_PROJECT_FILES = 200;
const TEXT_EXTENSIONS = new Set([
  "tex",
  "sty",
  "cls",
  "bib",
  "bst",
  "txt",
  "md",
  "json",
  "csv",
  "svg",
]);

type ProjectFile =
  | { kind: "text"; content: string }
  | { kind: "binary"; content: Uint8Array<ArrayBuffer> };

type ProjectFiles = Record<string, ProjectFile>;

type CompilePhase =
  | "idle"
  | "setup"
  | "compiling"
  | "success"
  | "error"
  | "cancelled";

type Diagnostic = {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
};

type CompileStatus = {
  phase: CompilePhase;
  label: string;
  duration?: number;
};

type CompilerProgress = {
  stage: string;
  detail: string;
};

type SyncTexRecord = { file: string; line: number; h: number };

type SyncTexBox = {
  file: string;
  line: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  records: SyncTexRecord[];
};

// Boxes per PDF page, in PDF points measured from the top-left page corner.
type SyncTexIndex = Map<number, SyncTexBox[]>;

type PdfTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
type PdfTextItem = Extract<PdfTextContent["items"][number], { str: string }>;

// `text` is search-folded page text; `itemOf` and `offsetOf` map each of its
// characters back to a text item and an offset in that item's string.
type PdfPageText = {
  text: string;
  itemOf: number[];
  offsetOf: number[];
  items: PdfTextItem[];
  styles: PdfTextContent["styles"];
  viewport: PageViewport;
};

type PdfMatch = { page: number; start: number; end: number };

// Percentages of the rendered page, so boxes stay aligned at any zoom.
type PdfMatchBox = { left: number; top: number; width: number; height: number };

type CompilerSession = {
  compiler: SiglumCompiler;
  compile: (
    source: string,
    mainFile: string,
    additionalFiles: Record<string, string | Uint8Array<ArrayBuffer>>,
  ) => Promise<CompileResult>;
};

async function createCompilerSession(
  onProgress: (progress: CompilerProgress) => void,
  onLog: (message: string) => void,
): Promise<CompilerSession> {
  onProgress({
    stage: "setup",
    detail: "Resolving the verified TeX Live runtime",
  });

  const runtime = await resolveRuntime();
  const compiler = new SiglumCompiler({
    ...runtime,
    workerUrl,
    enableCtan: true,
    enableLazyFS: true,
    // Cached PDFs come back without the SyncTeX data reverse search needs.
    enableDocCache: false,
    maxRetries: 5,
    verbose: false,
    onLog,
    onProgress: (stage, detail) => onProgress({ stage, detail }),
  });

  await compiler.init();
  const runPdfLatex: CompilerSession["compile"] = (
    source,
    mainFile,
    additionalFiles,
  ) =>
    compiler.compile(source, {
      engine: "pdflatex",
      mainFile,
      additionalFiles,
    });

  return {
    compiler,
    compile: async (source, mainFile, additionalFiles) => {
      const result = await runPdfLatex(source, mainFile, additionalFiles);
      if (
        result.success ||
        !CM_SUPER_FONT_ERROR.test(result.error) ||
        compiler.getEagerBundles("pdflatex").includes("cm-super")
      ) {
        return result;
      }
      onProgress({
        stage: "fonts",
        detail: "Downloading Computer Modern Type 1 fonts",
      });
      compiler.eagerBundles = { pdflatex: ["cm-super"] };
      return runPdfLatex(source, mainFile, additionalFiles);
    },
  };
}

function safeStorageRead(key: string, fallback: string) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

type GoogleSession = { token: string; expiresAt: number; email: string };

type DriveProject = {
  id: string;
  name: string;
  modifiedTime: string;
  mainFile: string;
  activeFile: string;
};

type DriveFile = {
  id: string;
  name: string;
  modifiedTime: string;
  appProperties?: Record<string, string>;
};

type DriveSnapshot = {
  project: { files: ProjectFiles; activeFile: string; mainFile: string };
  documentName: string;
};

class GoogleExpiredError extends Error {
  constructor() {
    super("Your Google sign-in expired. Sign in again to keep saving to Google Drive.");
  }
}

class GoogleRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const GOOGLE_SIGN_IN_ERRORS: Record<string, string> = {
  cancelled: "Google sign-in was cancelled.",
  drive_permission:
    "Google sign-in needs permission to keep this app's files in your Google Drive. Sign in again and allow it.",
  state_mismatch: "Google sign-in could not be verified. Try signing in again.",
  not_configured: "Google sign-in is not set up on this site.",
};

// worker/index.js runs the redirect to Google and back. The app's same-origin
// opener policy breaks Google's popup flow.
function startGoogleSignIn(showProjects: boolean) {
  try {
    window.sessionStorage.setItem(GOOGLE_RETURN_KEY, showProjects ? "projects" : "editor");
  } catch {
    // The Projects screen then stays closed after sign-in.
  }
  window.location.assign("/auth/login");
}

// The Projects screen is the welcome page, except right after "Sign in again"
// from the editor, which returns straight to the editor.
function readGoogleSignInResult(): { error: string | null; showProjects: boolean } {
  let showProjects = true;
  try {
    showProjects = window.sessionStorage.getItem(GOOGLE_RETURN_KEY) !== "editor";
    window.sessionStorage.removeItem(GOOGLE_RETURN_KEY);
  } catch {
    showProjects = true;
  }
  const url = new URL(window.location.href);
  const code = url.searchParams.get("google_error");
  if (code === null) return { error: null, showProjects };
  url.searchParams.delete("google_error");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return {
    error: GOOGLE_SIGN_IN_ERRORS[code] ?? "Google sign-in failed. Try signing in again.",
    showProjects,
  };
}

// Runs before React renders, so a reload does not repeat the message.
const googleSignIn = readGoogleSignInResult();

// The Worker keeps the refresh token in an HttpOnly cookie and answers with a
// Google access token, which lasts an hour.
async function requestGoogleSession(): Promise<
  GoogleSession | "signed-out" | "unavailable"
> {
  const response = await fetch("/auth/token", { method: "POST" }).catch(() => null);
  if (!response?.headers.get("Content-Type")?.includes("application/json")) {
    return "unavailable";
  }
  const body = (await response.json()) as {
    error?: string;
    accessToken?: string;
    expiresIn?: number;
    email?: string;
  };
  if (response.status === 401) return "signed-out";
  if (body.error === "not_configured") return "unavailable";
  if (!response.ok || !body.accessToken) {
    throw new GoogleRequestError(
      "Google sign-in is not responding. Try again in a minute.",
      response.status,
    );
  }
  return {
    token: body.accessToken,
    expiresAt: Date.now() + ((body.expiresIn ?? 3600) - 60) * 1000,
    email: body.email ?? "",
  };
}

let googleRefresh: Promise<void> | null = null;

// Updates the session in place, so every Drive call holding it uses the new token.
function refreshGoogleSession(session: GoogleSession) {
  googleRefresh ??= requestGoogleSession()
    .then((next) => {
      if (next === "signed-out") throw new GoogleExpiredError();
      if (next === "unavailable") throw new Error("Google sign-in is not responding.");
      session.token = next.token;
      session.expiresAt = next.expiresAt;
    })
    .finally(() => {
      googleRefresh = null;
    });
  return googleRefresh;
}

async function googleFetch(
  session: GoogleSession,
  url: string,
  init: RequestInit = {},
) {
  if (session.expiresAt <= Date.now()) await refreshGoogleSession(session);
  const send = () => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${session.token}`);
    return fetch(url, { ...init, headers });
  };
  let response = await send();
  if (response.status === 401) {
    await refreshGoogleSession(session);
    response = await send();
  }
  if (response.status === 401) throw new GoogleExpiredError();
  if (!response.ok) {
    let message = `Google Drive answered with status ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the status message.
    }
    throw new GoogleRequestError(message, response.status);
  }
  return response;
}

async function listDriveFiles(session: GoogleSession, type: "project" | "settings") {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `appProperties has { key='type' and value='${type}' } and trashed=false`,
    orderBy: "modifiedTime desc",
    fields: "nextPageToken,files(id,name,modifiedTime,appProperties)",
    pageSize: "100",
  });
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    if (pageToken) params.set("pageToken", pageToken);
    const response = await googleFetch(session, `${DRIVE_API}?${params}`);
    const body = (await response.json()) as {
      files?: DriveFile[];
      nextPageToken?: string;
    };
    files.push(...(body.files ?? []));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return files;
}

function toDriveProject(file: DriveFile): DriveProject {
  return {
    id: file.id,
    name: file.name.replace(/\.zip$/i, ""),
    modifiedTime: file.modifiedTime,
    mainFile: file.appProperties?.mainFile ?? "",
    activeFile: file.appProperties?.activeFile ?? "",
  };
}

async function listDriveProjects(session: GoogleSession) {
  return (await listDriveFiles(session, "project")).map(toDriveProject);
}

async function getDriveProject(session: GoogleSession, id: string) {
  const response = await googleFetch(
    session,
    `${DRIVE_API}/${encodeURIComponent(id)}?fields=id,name,modifiedTime,appProperties`,
  );
  return toDriveProject((await response.json()) as DriveFile);
}

async function downloadDriveFile(session: GoogleSession, id: string) {
  const response = await googleFetch(
    session,
    `${DRIVE_API}/${encodeURIComponent(id)}?alt=media`,
  );
  return new Uint8Array(await response.arrayBuffer());
}

async function uploadDriveFile(
  session: GoogleSession,
  file: {
    id?: string;
    name: string;
    mimeType: string;
    appProperties: Record<string, string>;
    body: Blob;
  },
) {
  const start = await googleFetch(
    session,
    `${DRIVE_UPLOAD_API}${file.id ? `/${encodeURIComponent(file.id)}` : ""}?uploadType=resumable&fields=id`,
    {
      method: file.id ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.mimeType,
      },
      body: JSON.stringify({
        name: file.name,
        mimeType: file.mimeType,
        appProperties: file.appProperties,
        ...(file.id ? {} : { parents: ["appDataFolder"] }),
      }),
    },
  );
  const location = start.headers.get("Location");
  if (!location) throw new Error("Google Drive did not start the upload.");
  const response = await googleFetch(session, location, {
    method: "PUT",
    body: file.body,
  });
  return ((await response.json()) as { id: string }).id;
}

async function deleteDriveFile(session: GoogleSession, id: string) {
  await googleFetch(session, `${DRIVE_API}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

async function loadDriveSettings(session: GoogleSession): Promise<AccountSettings | null> {
  const [file] = await listDriveFiles(session, "settings");
  if (!file) return null;
  const bytes = await downloadDriveFile(session, file.id);
  try {
    return readAccountSettings(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

async function saveDriveSettings(session: GoogleSession, settings: AccountSettings) {
  const [file] = await listDriveFiles(session, "settings");
  await uploadDriveFile(session, {
    id: file?.id,
    name: "assistant-settings.json",
    mimeType: "application/json",
    appProperties: { type: "settings" },
    body: new Blob([JSON.stringify({ version: 2, ...settings })], { type: "application/json" }),
  });
}

// Mirrors the min() caps on .source-content so the handle never outruns the column.
function clampExplorerWidth(width: number, container: HTMLElement | null) {
  const share = window.matchMedia("(max-width: 620px)").matches ? 0.4 : 0.5;
  const available = container
    ? container.getBoundingClientRect().width * share
    : EXPLORER_MAX_WIDTH;
  const max = Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, available));
  return Math.round(Math.min(max, Math.max(EXPLORER_MIN_WIDTH, width)));
}

function isTextPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(extension);
}

function normalizeProjectPath(path: string) {
  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("/");
}

function createInitialProject(): {
  files: ProjectFiles;
  activeFile: string;
  mainFile: string;
} {
  const storedProject = safeStorageRead(PROJECT_KEY, "");
  if (storedProject) {
    try {
      const parsed = JSON.parse(storedProject) as {
        files?: Record<string, string>;
        activeFile?: string;
        mainFile?: string;
      };
      const files = Object.fromEntries(
        Object.entries(parsed.files ?? {}).map(([path, content]) => [
          path,
          { kind: "text" as const, content },
        ]),
      );
      const paths = Object.keys(files);
      if (paths.length > 0) {
        const mainFile =
          parsed.mainFile && files[parsed.mainFile]
            ? parsed.mainFile
            : paths.find((path) => path.endsWith(".tex")) ?? paths[0];
        const activeFile =
          parsed.activeFile && files[parsed.activeFile]
            ? parsed.activeFile
            : mainFile;
        return { files, activeFile, mainFile };
      }
    } catch {
      // Fall back to the previous single-file draft or starter project.
    }
  }

  const source = safeStorageRead(DRAFT_KEY, STARTER_SOURCE);
  return {
    files: { "main.tex": { kind: "text", content: source } },
    activeFile: "main.tex",
    mainFile: "main.tex",
  };
}

function projectByteSize(files: ProjectFiles) {
  const encoder = new TextEncoder();
  return Object.values(files).reduce(
    (total, file) =>
      total +
      (file.kind === "text"
        ? encoder.encode(file.content).byteLength
        : file.content.byteLength),
    0,
  );
}

function projectToZip(files: ProjectFiles) {
  const archiveEntries = Object.fromEntries(
    Object.entries(files).map(([path, file]) => [
      path,
      file.kind === "text" ? strToU8(file.content) : file.content,
    ]),
  );
  return new Uint8Array(zipSync(archiveEntries, { level: 6 }));
}

function projectFromZip(bytes: Uint8Array) {
  const unpacked = unzipSync(bytes);
  const rawPaths = Object.keys(unpacked)
    .filter((path) => !path.endsWith("/"))
    .map(normalizeProjectPath)
    .filter(
      (path) =>
        path &&
        !path.startsWith("__MACOSX/") &&
        !path.endsWith(".DS_Store"),
    );
  if (rawPaths.length === 0) {
    throw new Error("The archive does not contain any project files.");
  }
  if (rawPaths.length > MAX_PROJECT_FILES) {
    throw new Error(`Projects can contain at most ${MAX_PROJECT_FILES} files.`);
  }

  const firstSegments = rawPaths.map((path) => path.split("/")[0]);
  const commonRoot =
    rawPaths.every((path) => path.includes("/")) &&
    firstSegments.every((segment) => segment === firstSegments[0])
      ? `${firstSegments[0]}/`
      : "";

  const files: ProjectFiles = {};
  for (const originalPath of Object.keys(unpacked)) {
    if (originalPath.endsWith("/")) continue;
    const normalized = normalizeProjectPath(originalPath);
    if (
      !normalized ||
      normalized.startsWith("__MACOSX/") ||
      normalized.endsWith(".DS_Store")
    ) {
      continue;
    }
    const path = commonRoot
      ? normalized.slice(commonRoot.length)
      : normalized;
    if (!path) continue;
    const fileBytes = new Uint8Array(unpacked[originalPath]);
    files[path] = isTextPath(path)
      ? { kind: "text", content: new TextDecoder().decode(fileBytes) }
      : { kind: "binary", content: fileBytes };
  }
  return files;
}

function pickMainFile(paths: string[]) {
  return (
    paths.find((path) => path.toLowerCase() === "main.tex") ??
    paths.find((path) => path.toLowerCase().endsWith("/main.tex")) ??
    paths.find((path) => path.toLowerCase().endsWith(".tex"))
  );
}

function sanitizeFilename(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 80);
  return normalized || "document";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function parseDiagnostic(
  error: string,
  log: string,
  fallbackFile: string,
): Diagnostic {
  const combined = `${error}\n${log}`;
  const match =
    combined.match(/([^:\n]+\.tex):(\d+):\s*([^\n]+)/i) ??
    combined.match(/l\.(\d+)\s+([^\n]+)/i);
  const hasFile = Boolean(match?.[3]);

  return {
    severity: "error",
    file: hasFile ? normalizeProjectPath(match?.[1] ?? "") : fallbackFile,
    line: match ? Number(match[hasFile ? 2 : 1]) : undefined,
    message:
      match?.[hasFile ? 3 : 2]?.trim() ||
      error ||
      "LaTeX could not compile the document.",
  };
}

function resolveSyncTexPath(path: string) {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function parseSyncTex(text: string): SyncTexIndex {
  const inputs = new Map<string, string>();
  const pages: SyncTexIndex = new Map();
  let unit = 1;
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let boxes: SyncTexBox[] = [];
  let open: (SyncTexBox | null)[] = [];
  const toPoints = (value: string) =>
    (Number(value) * unit * magnification) / 1000 / SCALED_POINTS_PER_PDF_POINT;

  for (const line of text.split("\n")) {
    if (line.startsWith("Input:")) {
      const separator = line.indexOf(":", 6);
      inputs.set(
        line.slice(6, separator),
        resolveSyncTexPath(line.slice(separator + 1)),
      );
    } else if (line.startsWith("Unit:")) {
      unit = Number(line.slice(5)) || 1;
    } else if (line.startsWith("Magnification:")) {
      magnification = Number(line.slice(14)) || 1000;
    } else if (line.startsWith("X Offset:")) {
      xOffset = (Number(line.slice(9)) * unit) / SCALED_POINTS_PER_PDF_POINT;
    } else if (line.startsWith("Y Offset:")) {
      yOffset = (Number(line.slice(9)) * unit) / SCALED_POINTS_PER_PDF_POINT;
    } else if (line.startsWith("{")) {
      boxes = [];
      open = [];
      pages.set(Number(line.slice(1)), boxes);
    } else if (line.startsWith("[")) {
      open.push(null);
    } else if (line.startsWith(")") || line.startsWith("]")) {
      open.pop();
    } else {
      const match = SYNCTEX_RECORD.exec(line);
      if (!match) continue;
      const [, kind, tag, lineNumber, h, v, width, height, depth] = match;
      const record: SyncTexRecord = {
        file: inputs.get(tag) ?? "",
        line: Number(lineNumber),
        h: toPoints(h) + xOffset,
      };
      open.at(-1)?.records.push(record);
      if (kind === "(") {
        const baseline = toPoints(v) + yOffset;
        const box: SyncTexBox = {
          file: record.file,
          line: record.line,
          left: record.h,
          top: baseline - toPoints(height ?? "0"),
          right: record.h + toPoints(width ?? "0"),
          bottom: baseline + toPoints(depth ?? "0"),
          records: [],
        };
        boxes.push(box);
        open.push(box);
      }
    }
  }
  return pages;
}

function findSyncTexSource(
  syncTex: SyncTexIndex,
  page: number,
  x: number,
  y: number,
  isProjectFile: (file: string) => boolean,
) {
  const distance = (box: SyncTexBox) =>
    Math.hypot(
      Math.max(box.left - x, 0, x - box.right),
      Math.max(box.top - y, 0, y - box.bottom),
    );
  const area = (box: SyncTexBox) =>
    (box.right - box.left) * (box.bottom - box.top);
  const boxes = [...(syncTex.get(page) ?? [])].sort(
    (first, second) =>
      distance(first) - distance(second) || area(first) - area(second),
  );

  for (const box of boxes) {
    const records = box.records.filter((record) => isProjectFile(record.file));
    const target =
      records.filter((record) => record.h <= x).sort((a, b) => b.h - a.h)[0] ??
      records.sort((a, b) => a.h - b.h)[0] ??
      (isProjectFile(box.file) ? box : undefined);
    if (target) return { file: target.file, line: target.line };
  }
  return null;
}

type SourceTextMatch = {
  start: number;
  end: number;
  line: number;
  source: string;
  // The visible text, one entry per character, with each character's span in
  // the source. Spaces stand for any run of source whitespace or `~`.
  chars: string[];
  spans: { start: number; end: number }[];
};

type PdfTextSelection = {
  page: number;
  text: string;
  // PDF points from the top-left corner of the page, as SyncTeX uses.
  start: { x: number; y: number };
  end: { x: number; y: number };
};

type PdfTextEdit =
  | {
      kind: "ready";
      location: string;
      text: string;
      apply: (replacement: string) => boolean;
    }
  | { kind: "unavailable"; message: string; reveal?: () => void };

const MAX_EDIT_CHARS = 400;
const EDIT_MATCH_WINDOW = 40;

// Characters TeX typesets from ASCII ligatures in the source.
const PDF_CHAR_SOURCES: Record<string, string> = {
  "“": "``|“|\"",
  "”": "''|”|\"",
  "‘": "`|‘",
  "’": "'|’",
  "–": "--|–",
  "—": "---|—",
};

const LATEX_TEXT_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  "%": "\\%",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeLatexText(text: string) {
  return text.replace(/[\\{}$&#%_~^]/g, (char) => LATEX_TEXT_ESCAPES[char]);
}

function findTextInSource(
  source: string,
  selected: string,
  nearLine: number,
): SourceTextMatch | "too-long" | null {
  const characters = [...selected.normalize("NFKC")];
  const tokens: { char: string; optional: boolean }[] = [];
  characters.forEach((char, index) => {
    if (/\s/u.test(char)) return;
    const hyphen = char === "-" || char === "\u2010";
    // A hyphen before a line break may be one TeX added to split the word.
    const optional =
      hyphen &&
      /\s/u.test(characters[index + 1] ?? "") &&
      /\p{L}/u.test(tokens.at(-1)?.char ?? "");
    tokens.push({ char: hyphen ? "-" : char, optional });
  });
  if (tokens.length === 0) return null;
  if (tokens.length > MAX_EDIT_CHARS) return "too-long";

  const pattern = tokens
    .map(
      ({ char, optional }) =>
        `(${optional ? "-?" : (PDF_CHAR_SOURCES[char] ?? escapeRegExp(char))})`,
    )
    .join("([\\s~]*)");
  const regex = new RegExp(pattern, "gd");
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  let best: RegExpExecArray | null = null;
  let bestDistance = Infinity;
  for (let match = regex.exec(source); match; match = regex.exec(source)) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    const distance = Math.abs(lineAt(match.index) - nearLine);
    if (distance < bestDistance) {
      best = match;
      bestDistance = distance;
    }
  }
  if (!best?.indices || bestDistance > EDIT_MATCH_WINDOW) return null;
  const indices = best.indices;

  const chars: string[] = [];
  const spans: SourceTextMatch["spans"] = [];
  tokens.forEach(({ char }, index) => {
    const [start, end] = indices[1 + index * 2];
    if (end > start) {
      chars.push(char);
      spans.push({ start, end });
    }
    const gap = indices[2 + index * 2];
    if (index < tokens.length - 1 && gap && gap[1] > gap[0]) {
      chars.push(" ");
      spans.push({ start: gap[0], end: gap[1] });
    }
  });
  const start = best.index;
  const end = start + best[0].length;
  return {
    start,
    end,
    line: lineAt(start),
    source: source.slice(start, end),
    chars,
    spans,
  };
}

// Rewrites only the characters that changed, so the unchanged parts keep
// their original LaTeX spelling (``quotes'', --, ~ and line breaks).
function planTextReplacement(match: SourceTextMatch, replacement: string) {
  const previous = match.chars;
  const next = [...replacement.replace(/\s*\n\s*/g, " ")];
  if (previous.join("") === next.join("")) return null;
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous[prefix] === next[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const from = prefix === 0 ? match.spans[0].start : match.spans[prefix - 1].end;
  const to =
    suffix === 0
      ? match.spans[previous.length - 1].end
      : match.spans[previous.length - suffix].start;
  return {
    from,
    to,
    insert: escapeLatexText(next.slice(prefix, next.length - suffix).join("")),
  };
}

function foldSearchChar(char: string) {
  if (/\s/.test(char)) return " ";
  const lower = char.toLowerCase();
  return lower.length === 1 ? lower : char;
}

function foldSearchText(value: string) {
  let folded = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = foldSearchChar(value[index]);
    if (char !== " " || (folded && !folded.endsWith(" "))) folded += char;
  }
  return folded.trim();
}

async function readPdfPageText(
  pdfDocument: PDFDocumentProxy,
  pageNumber: number,
): Promise<PdfPageText> {
  const page = await pdfDocument.getPage(pageNumber);
  const content = await page.getTextContent();
  const items = content.items.filter(
    (item): item is PdfTextItem => "str" in item,
  );
  const chars: string[] = [];
  const itemOf: number[] = [];
  const offsetOf: number[] = [];
  const append = (char: string, item: number, offset: number) => {
    chars.push(char);
    itemOf.push(item);
    offsetOf.push(offset);
  };

  items.forEach((item, itemIndex) => {
    for (let offset = 0; offset < item.str.length; offset += 1) {
      const char = foldSearchChar(item.str[offset]);
      if (char === " " && (chars.length === 0 || chars.at(-1) === " ")) continue;
      append(char, itemIndex, offset);
    }
    if (!item.hasEOL) return;
    if (chars.at(-1) === "-") {
      // Rejoin words hyphenated across lines.
      chars.pop();
      itemOf.pop();
      offsetOf.pop();
    } else if (chars.length > 0 && chars.at(-1) !== " ") {
      append(" ", -1, 0);
    }
  });

  return {
    text: chars.join(""),
    itemOf,
    offsetOf,
    items,
    styles: content.styles,
    viewport: page.getViewport({ scale: 1 }),
  };
}

function findPdfMatches(pages: PdfPageText[], needle: string): PdfMatch[] {
  const matches: PdfMatch[] = [];
  pages.forEach((pageText, index) => {
    for (
      let at = pageText.text.indexOf(needle);
      at !== -1;
      at = pageText.text.indexOf(needle, at + needle.length)
    ) {
      matches.push({ page: index + 1, start: at, end: at + needle.length });
    }
  });
  return matches;
}

function textItemBox(
  pageText: PdfPageText,
  itemIndex: number,
  from: number,
  to: number,
  measure: CanvasRenderingContext2D | null,
): PdfMatchBox {
  const item = pageText.items[itemIndex];
  const [a, b, c, d, e, f]: number[] = item.transform;
  const advance = Math.hypot(a, b) || 1;
  const fontHeight = Math.hypot(c, d) || item.height || 1;
  const style = pageText.styles[item.fontName];
  const ascent =
    fontHeight * (style?.ascent || (style?.descent ? 1 + style.descent : 0.8));
  // Text items carry only a total width, so serif glyph widths approximate
  // where a substring starts and ends.
  const widthAt = (end: number) => {
    if (end <= 0) return 0;
    if (end >= item.str.length || !measure) {
      return item.width * Math.min(1, end / item.str.length);
    }
    const total = measure.measureText(item.str).width;
    return total > 0
      ? (item.width * measure.measureText(item.str.slice(0, end)).width) / total
      : (item.width * end) / item.str.length;
  };

  const corners = [widthAt(from), widthAt(to)].flatMap((along) =>
    [ascent - fontHeight, ascent].map(
      (across): number[] =>
        pageText.viewport.convertToViewportPoint(
          e + (along * a) / advance + (across * c) / fontHeight,
          f + (along * b) / advance + (across * d) / fontHeight,
        ),
    ),
  );
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const { width, height } = pageText.viewport;
  return {
    left: (Math.min(...xs) / width) * 100,
    top: (Math.min(...ys) / height) * 100,
    width: ((Math.max(...xs) - Math.min(...xs)) / width) * 100,
    height: ((Math.max(...ys) - Math.min(...ys)) / height) * 100,
  };
}

function pdfMatchBoxes(
  pageText: PdfPageText,
  match: PdfMatch,
  measure: CanvasRenderingContext2D | null,
) {
  const boxes: PdfMatchBox[] = [];
  for (let index = match.start; index < match.end; ) {
    const item = pageText.itemOf[index];
    let last = index;
    while (last + 1 < match.end && pageText.itemOf[last + 1] === item) last += 1;
    if (item >= 0) {
      boxes.push(
        textItemBox(
          pageText,
          item,
          pageText.offsetOf[index],
          pageText.offsetOf[last] + 1,
          measure,
        ),
      );
    }
    index = last + 1;
  }
  return boxes;
}

function getStatusIcon(phase: CompilePhase) {
  if (phase === "success") return <CheckCircle weight="fill" aria-hidden="true" />;
  if (phase === "error") return <XCircle weight="fill" aria-hidden="true" />;
  if (phase === "cancelled") return <WarningCircle weight="fill" aria-hidden="true" />;
  if (phase === "setup" || phase === "compiling") {
    return <SpinnerGap className="spin" aria-hidden="true" />;
  }
  return <Check aria-hidden="true" />;
}

type PdfPageSize = { width: number; height: number };

type PdfPageCanvasProps = {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  pageCount: number;
  scale: number;
  onError: (message: string) => void;
};

function PdfPageCanvas({
  pdfDocument,
  pageNumber,
  pageCount,
  scale,
  onError,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) return;
    const startSelecting = () => layer.classList.add("selecting");
    const stopSelecting = () => layer.classList.remove("selecting");
    layer.addEventListener("pointerdown", startSelecting);
    document.addEventListener("pointerup", stopSelecting);
    return () => {
      layer.removeEventListener("pointerdown", startSelecting);
      document.removeEventListener("pointerup", stopSelecting);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: { cancel: () => void } | null = null;

    async function renderPage() {
      const pdfPage = await pdfDocument.getPage(pageNumber);
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d", { alpha: false });
      if (cancelled || !canvas || !context) return;
      const viewport = pdfPage.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      renderTask = pdfPage.render({
        canvas,
        canvasContext: context,
        viewport,
        transform:
          pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      await renderTask.promise;

      const container = textLayerRef.current;
      if (cancelled || !container) return;
      const { TextLayer } = await import("pdfjs-dist");
      if (cancelled) return;
      container.replaceChildren();
      const layer = new TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container,
        viewport,
      });
      textLayer = layer;
      await layer.render();
      if (cancelled) return;
      const endOfContent = document.createElement("div");
      endOfContent.className = "endOfContent";
      container.append(endOfContent);
    }

    renderPage().catch((error: unknown) => {
      if (
        cancelled ||
        (error instanceof Error && error.name === "RenderingCancelledException")
      ) {
        return;
      }
      onError(
        error instanceof Error ? error.message : "This page could not be rendered.",
      );
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [onError, pageNumber, pdfDocument, scale]);

  return (
    <>
      <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber} of ${pageCount}`} />
      <div ref={textLayerRef} className="textLayer" />
    </>
  );
}

type PdfPreviewProps = {
  bytes: Uint8Array<ArrayBuffer> | null;
  stale: boolean;
  busy: boolean;
  onDownload: () => void;
  // x and y are PDF points measured from the top-left corner of the page.
  onLocateSource?: (page: number, x: number, y: number) => void;
  onPrepareEdit?: (selection: PdfTextSelection) => PdfTextEdit;
};

function PdfPreview({
  bytes,
  stale,
  busy,
  onDownload,
  onLocateSource,
  onPrepareEdit,
}: PdfPreviewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const editPopoverRef = useRef<HTMLDivElement>(null);
  // Positions are in the viewport's scrolled content, so they move with the
  // page. `top` sits below the selection and `above` is its top edge.
  const [selectionChip, setSelectionChip] = useState<{
    selection: PdfTextSelection;
    left: number;
    top: number;
    above: number;
  } | null>(null);
  const [textEdit, setTextEdit] = useState<{
    edit: PdfTextEdit;
    left: number;
    top: number;
    above: number;
    error: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const pageElementsRef = useRef<(HTMLDivElement | null)[]>([]);
  // The page at the top of the view, how far into it the view starts, and the
  // horizontal centre, so zooming and recompiling keep the reading position.
  const anchorRef = useRef<{ page: number; offset: number; centerX: number } | null>(
    null,
  );
  const pageTextsRef = useRef<{
    document: PDFDocumentProxy;
    pages: Promise<PdfPageText[]>;
  } | null>(null);
  const pageRef = useRef(1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PdfPageSize[]>([]);
  const [page, setPage] = useState(1);
  const [renderRange, setRenderRange] = useState({ first: 1, last: 0 });
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{
    pending: boolean;
    pages: PdfPageText[];
    matches: PdfMatch[];
  }>({ pending: false, pages: [], matches: [] });
  const [activeMatch, setActiveMatch] = useState(0);
  const [matchRequest, setMatchRequest] = useState(0);

  const pageCount = pageSizes.length;
  const widestPage =
    pageSizes.reduce((widest, size) => Math.max(widest, size.width), 0) || 612;
  const scale = fitWidth
    ? Math.min(2, Math.max(320, containerWidth - 64) / widestPage)
    : zoom;

  useEffect(() => {
    if (!bytes) {
      setPdfDocument(null);
      setPageSizes([]);
      setSearchOpen(false);
      anchorRef.current = null;
      return;
    }

    const activeBytes = bytes;
    let disposed = false;
    let handedOver = false;
    let loadingTask: ReturnType<(typeof import("pdfjs-dist"))["getDocument"]> | null =
      null;

    async function openPdf() {
      try {
        setPreviewError("");
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        loadingTask = pdfjs.getDocument({ data: activeBytes.slice() });
        const document = await loadingTask.promise;
        const sizes = await Promise.all(
          Array.from({ length: document.numPages }, async (_, index) => {
            const pdfPage = await document.getPage(index + 1);
            const { width, height } = pdfPage.getViewport({ scale: 1 });
            return { width, height };
          }),
        );
        if (disposed) {
          await document.destroy();
          return;
        }
        handedOver = true;
        setPageSizes(sizes);
        setPdfDocument(document);
      } catch (error) {
        if (!disposed) {
          setPreviewError(
            error instanceof Error ? error.message : "The PDF could not be opened.",
          );
        }
      }
    }

    void openPdf();

    return () => {
      disposed = true;
      if (!handedOver) loadingTask?.destroy();
    };
  }, [bytes]);

  // Destroying a document only after React has swapped in its replacement
  // lets page renders on the old document cancel cleanly first.
  useEffect(() => {
    if (!pdfDocument) return;
    return () => {
      void pdfDocument.destroy();
    };
  }, [pdfDocument]);

  // A hidden preview (narrow layout, Source tab) has no geometry; its anchor
  // stays as last seen and is restored when the preview is shown again.
  const restoreAnchor = useCallback(() => {
    const container = viewportRef.current;
    const anchor = anchorRef.current;
    if (!container || !anchor || container.clientHeight === 0 || pageCount === 0) {
      return;
    }
    const element = pageElementsRef.current[Math.min(anchor.page, pageCount) - 1];
    if (!element) return;
    container.scrollTop = element.offsetTop + anchor.offset * element.offsetHeight;
    container.scrollLeft =
      anchor.centerX * container.scrollWidth - container.clientWidth / 2;
  }, [pageCount]);

  const updateVisiblePages = useCallback(() => {
    const container = viewportRef.current;
    const pages = pageElementsRef.current.slice(0, pageCount);
    if (!container || pages.length === 0 || container.clientHeight === 0) return;

    const top = container.scrollTop;
    const bottom = top + container.clientHeight;
    const atEnd = bottom >= container.scrollHeight - 1;
    let first = 0;
    let last = 0;
    let current = 1;
    let anchor: { page: number; offset: number } | null = null;
    for (let index = 0; index < pages.length; index += 1) {
      const element = pages[index];
      if (!element) continue;
      const pageTop = element.offsetTop;
      const pageBottom = pageTop + element.offsetHeight;
      if (pageBottom > top && pageTop < bottom) {
        if (!first) first = index + 1;
        last = index + 1;
      }
      if (!anchor && pageBottom > top) {
        anchor = { page: index + 1, offset: (top - pageTop) / element.offsetHeight };
      }
      if (pageTop <= top + container.clientHeight / 3) current = index + 1;
    }
    if (atEnd && last) current = last;
    if (!first) first = last = current;

    anchorRef.current = {
      ...(anchor ?? { page: current, offset: 0 }),
      centerX:
        (container.scrollLeft + container.clientWidth / 2) /
        Math.max(1, container.scrollWidth),
    };
    const nextRange = {
      first: Math.max(1, first - 1),
      last: Math.min(pageCount, last + 1),
    };
    setRenderRange((range) =>
      range.first === nextRange.first && range.last === nextRange.last
        ? range
        : nextRange,
    );
    setPage(current);
  }, [pageCount]);

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;
    let wasHidden = container.clientHeight === 0;
    const observer = new ResizeObserver(() => {
      const hidden = container.clientHeight === 0;
      if (!hidden) setContainerWidth(container.clientWidth);
      if (wasHidden && !hidden) restoreAnchor();
      wasHidden = hidden;
      updateVisiblePages();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [restoreAnchor, updateVisiblePages]);

  useLayoutEffect(() => {
    restoreAnchor();
    updateVisiblePages();
  }, [pageSizes, restoreAnchor, scale, updateVisiblePages]);

  const goToPage = (pageNumber: number) => {
    const container = viewportRef.current;
    const element = pageElementsRef.current[pageNumber - 1];
    if (!container || !element) return;
    container.scrollTop =
      element.offsetTop - parseFloat(getComputedStyle(container).paddingTop);
  };

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchOpen]);

  useEffect(() => {
    const needle = foldSearchText(searchQuery);
    if (!searchOpen || !needle || !pdfDocument) {
      setSearchResult({ pending: false, pages: [], matches: [] });
      return;
    }

    const activeDocument = pdfDocument;
    let cancelled = false;
    setSearchResult((current) => ({ ...current, pending: true }));
    const timer = window.setTimeout(async () => {
      try {
        if (pageTextsRef.current?.document !== activeDocument) {
          pageTextsRef.current = {
            document: activeDocument,
            pages: Promise.all(
              Array.from({ length: activeDocument.numPages }, (_, index) =>
                readPdfPageText(activeDocument, index + 1),
              ),
            ),
          };
        }
        const pages = await pageTextsRef.current.pages;
        if (cancelled) return;
        const matches = findPdfMatches(pages, needle);
        const first = Math.max(
          0,
          matches.findIndex((match) => match.page >= pageRef.current),
        );
        setSearchResult({ pending: false, pages, matches });
        setActiveMatch(first);
      } catch {
        if (pageTextsRef.current?.document === activeDocument) {
          pageTextsRef.current = null;
        }
        if (!cancelled) setSearchResult({ pending: false, pages: [], matches: [] });
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pdfDocument, searchOpen, searchQuery]);

  const matchBoxesByPage = useMemo(() => {
    const boxes = new Map<number, { box: PdfMatchBox; index: number }[]>();
    if (searchResult.matches.length === 0) return boxes;
    const measure = document.createElement("canvas").getContext("2d");
    if (measure) measure.font = "100px serif";
    searchResult.matches.forEach((match, index) => {
      const pageText = searchResult.pages[match.page - 1];
      if (match.page < renderRange.first || match.page > renderRange.last || !pageText) {
        return;
      }
      const pageBoxes = boxes.get(match.page) ?? [];
      for (const box of pdfMatchBoxes(pageText, match, measure)) {
        pageBoxes.push({ box, index });
      }
      boxes.set(match.page, pageBoxes);
    });
    return boxes;
  }, [renderRange, searchResult]);

  useEffect(() => {
    const match = searchResult.matches[activeMatch];
    const pageText = match && searchResult.pages[match.page - 1];
    const element = match && pageElementsRef.current[match.page - 1];
    const container = viewportRef.current;
    if (!pageText || !element || !container) return;
    const measure = document.createElement("canvas").getContext("2d");
    if (measure) measure.font = "100px serif";
    const [box] = pdfMatchBoxes(pageText, match, measure);
    if (!box) return;

    const top = element.offsetTop + (box.top / 100) * element.offsetHeight;
    const bottom = top + (box.height / 100) * element.offsetHeight;
    const left = element.offsetLeft + (box.left / 100) * element.offsetWidth;
    const right = left + (box.width / 100) * element.offsetWidth;
    if (top < container.scrollTop || bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = top - container.clientHeight / 2;
    }
    if (left < container.scrollLeft || right > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = left - container.clientWidth / 2;
    }
  }, [activeMatch, matchRequest, searchResult]);

  const openSearch = () => {
    setSearchOpen(true);
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };

  const closeSearch = () => {
    setSearchOpen(false);
    searchToggleRef.current?.focus();
  };

  const matchCount = searchResult.matches.length;
  const goToMatch = (index: number) => {
    if (matchCount === 0) return;
    setActiveMatch((index + matchCount) % matchCount);
    setMatchRequest((value) => value + 1);
  };

  const searchStatus = !foldSearchText(searchQuery)
    ? ""
    : searchResult.pending
      ? "Searching…"
      : matchCount === 0
        ? "No matches"
        : `${activeMatch + 1} of ${matchCount}`;

  const changeZoom = (delta: number) => {
    setZoom(Math.min(2, Math.max(0.5, Math.round((scale + delta) * 10) / 10)));
    setFitWidth(false);
  };

  const handleDoubleClick = (
    event: React.MouseEvent<HTMLDivElement>,
    pageNumber: number,
  ) => {
    if (!onLocateSource || !pdfDocument) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    pdfDocument
      .getPage(pageNumber)
      .then((pdfPage) => {
        const viewport = pdfPage.getViewport({ scale });
        const [x, y]: number[] = viewport.convertToPdfPoint(pointerX, pointerY);
        const [left, , , top] = viewport.viewBox;
        onLocateSource(pageNumber, x - left, top - y);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    setSelectionChip(null);
    setTextEdit(null);
  }, [containerWidth, pdfDocument, scale]);

  const textEditReady = textEdit?.edit.kind === "ready";
  useEffect(() => {
    if (!textEditReady) return;
    editInputRef.current?.focus({ preventScroll: true });
    editInputRef.current?.select();
  }, [textEditReady]);

  // Open above the selection when there is no room below it.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const popover = editPopoverRef.current;
    if (!textEdit || !viewport || !popover) return;
    const height = popover.offsetHeight;
    const visibleBottom = viewport.scrollTop + viewport.clientHeight - 8;
    if (textEdit.top + height <= visibleBottom) return;
    const flipped = textEdit.above - height;
    if (flipped >= viewport.scrollTop + 8) {
      setTextEdit({ ...textEdit, top: flipped });
    } else {
      viewport.scrollTop += textEdit.top + height - visibleBottom;
    }
  }, [textEdit]);

  const pageOf = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)
      ?.closest(".textLayer")
      ?.closest<HTMLDivElement>(".pdf-page") ?? null;

  const captureSelection = (event: React.MouseEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!onPrepareEdit || !viewport) return;
    if ((event.target as Element).closest(".pdf-edit")) return;
    // A double-click selects a word too, but it keeps meaning "go to source".
    if (event.detail > 1) {
      setSelectionChip(null);
      return;
    }
    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount > 0 && !selection.isCollapsed
        ? selection.getRangeAt(0)
        : null;
    const text = selection?.toString() ?? "";
    const pageElement = range ? pageOf(range.startContainer) : null;
    const rects = range
      ? [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
      : [];
    const pageNumber = pageElement ? pageElementsRef.current.indexOf(pageElement) + 1 : 0;
    if (
      !range ||
      !pageElement ||
      pageOf(range.endContainer) !== pageElement ||
      !text.trim() ||
      rects.length === 0 ||
      pageNumber < 1
    ) {
      setSelectionChip(null);
      setTextEdit(null);
      return;
    }

    const pageBounds = pageElement.getBoundingClientRect();
    const viewBounds = viewport.getBoundingClientRect();
    const first = rects[0];
    const last = rects[rects.length - 1];
    const toPage = (clientX: number, clientY: number) => ({
      x: (clientX - pageBounds.left) / scale,
      y: (clientY - pageBounds.top) / scale,
    });
    setTextEdit(null);
    setSelectionChip({
      selection: {
        page: pageNumber,
        text,
        start: toPage(first.left + 1, first.top + first.height / 2),
        end: toPage(last.right - 1, last.top + last.height / 2),
      },
      left: Math.min(
        last.right - viewBounds.left + viewport.scrollLeft,
        viewport.scrollLeft + viewport.clientWidth - 128,
      ),
      top: last.bottom - viewBounds.top + viewport.scrollTop + 6,
      above: first.top - viewBounds.top + viewport.scrollTop - 6,
    });
  };

  const openTextEdit = () => {
    const viewport = viewportRef.current;
    if (!selectionChip || !onPrepareEdit || !viewport) return;
    const edit = onPrepareEdit(selectionChip.selection);
    setTextEdit({
      edit,
      left: Math.max(
        viewport.scrollLeft + 8,
        Math.min(
          selectionChip.left - 160,
          viewport.scrollLeft + viewport.clientWidth - 336,
        ),
      ),
      top: selectionChip.top,
      above: selectionChip.above,
      error: "",
    });
    setEditValue(edit.kind === "ready" ? edit.text : "");
    setSelectionChip(null);
  };

  const closeTextEdit = () => {
    setTextEdit(null);
    viewportRef.current?.focus({ preventScroll: true });
  };

  const submitTextEdit = () => {
    if (textEdit?.edit.kind !== "ready") return;
    if (!textEdit.edit.apply(editValue)) {
      setTextEdit({
        ...textEdit,
        error: "The source changed while this was open. Select the text again.",
      });
      return;
    }
    window.getSelection()?.removeAllRanges();
    closeTextEdit();
  };

  return (
    <section
      className="pane preview-pane"
      aria-labelledby="preview-heading"
      onKeyDown={(event) => {
        if (
          bytes &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          openSearch();
        }
      }}
    >
      <header className="pane-header preview-header">
        <div className="pane-heading-group">
          <FilePdf size={16} aria-hidden="true" />
          <h2 id="preview-heading">Preview</h2>
          {bytes && (
            <span className={`freshness ${stale ? "stale" : "current"}`}>
              {stale ? "Out of date" : "Current"}
            </span>
          )}
        </div>
        <div className="preview-controls" aria-label="PDF preview controls">
          <button
            className="icon-button"
            type="button"
            disabled={!pdfDocument || page <= 1}
            onClick={() => goToPage(page - 1)}
            aria-label="Previous page"
          >
            <CaretLeft />
          </button>
          <span className="page-count">
            {bytes ? `${page} / ${pageCount || 1}` : "0 / 0"}
          </span>
          <button
            className="icon-button"
            type="button"
            disabled={!pdfDocument || page >= pageCount}
            onClick={() => goToPage(page + 1)}
            aria-label="Next page"
          >
            <CaretRight />
          </button>
          <span className="control-divider" aria-hidden="true" />
          <button
            className="icon-button"
            type="button"
            disabled={!bytes}
            onClick={() => changeZoom(-0.1)}
            aria-label="Zoom out"
          >
            <Minus />
          </button>
          <button
            className={`zoom-value ${fitWidth ? "active" : ""}`}
            type="button"
            disabled={!bytes}
            onClick={() => setFitWidth(true)}
          >
            {fitWidth ? "Fit" : `${Math.round(zoom * 100)}%`}
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!bytes}
            onClick={() => changeZoom(0.1)}
            aria-label="Zoom in"
          >
            <Plus />
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!bytes}
            onClick={() => setFitWidth(true)}
            aria-label="Fit page width"
          >
            <ArrowsOutSimple />
          </button>
          <span className="control-divider" aria-hidden="true" />
          <button
            ref={searchToggleRef}
            className={`icon-button ${searchOpen ? "active" : ""}`}
            type="button"
            disabled={!bytes}
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
            aria-label="Search PDF"
            aria-expanded={searchOpen}
            title="Search PDF (⌘F)"
          >
            <MagnifyingGlass />
          </button>
        </div>
      </header>

      {stale && bytes && (
        <div className="stale-notice">
          <Warning size={15} weight="fill" aria-hidden="true" />
          Showing the last successful PDF. Compile to update it.
        </div>
      )}

      {searchOpen && (
        <div className="pdf-search" role="search">
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            placeholder="Find in PDF"
            aria-label="Find in PDF"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToMatch(activeMatch + (event.shiftKey ? -1 : 1));
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
          />
          <span className="pdf-search-count" role="status">
            {searchStatus}
          </span>
          <button
            className="icon-button"
            type="button"
            disabled={matchCount === 0}
            onClick={() => goToMatch(activeMatch - 1)}
            aria-label="Previous match"
          >
            <CaretUp />
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={matchCount === 0}
            onClick={() => goToMatch(activeMatch + 1)}
            aria-label="Next match"
          >
            <CaretDown />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={closeSearch}
            aria-label="Close PDF search"
          >
            <X />
          </button>
        </div>
      )}

      <div
        className="pdf-viewport"
        ref={viewportRef}
        tabIndex={0}
        onScroll={updateVisiblePages}
        onMouseUp={captureSelection}
      >
        {!bytes && !busy && (
          <div className="empty-state">
            <div className="empty-file" aria-hidden="true">
              <FilePdf size={42} weight="thin" />
            </div>
            <h3>
              Your PDF will <span className="accent">appear</span> here
            </h3>
            <p>Compile the LaTeX source to create a preview.</p>
            <kbd>⌘ Enter</kbd>
          </div>
        )}

        {busy && !bytes && (
          <div className="preview-loading" role="status">
            <div className="document-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <p>Preparing the browser compiler</p>
          </div>
        )}

        {previewError && (
          <div className="preview-error" role="alert">
            <XCircle size={28} weight="fill" aria-hidden="true" />
            <h3>Preview unavailable</h3>
            <p>The PDF was created, but this browser could not display it.</p>
            <button type="button" className="secondary-button" onClick={onDownload}>
              <DownloadSimple /> Download PDF
            </button>
          </div>
        )}

        {pdfDocument &&
          !previewError &&
          pageSizes.map((size, index) => {
            const pageNumber = index + 1;
            const rendered =
              pageNumber >= renderRange.first && pageNumber <= renderRange.last;
            return (
              <div
                key={pageNumber}
                ref={(element) => {
                  pageElementsRef.current[index] = element;
                }}
                className="pdf-page"
                style={
                  {
                    width: Math.floor(size.width * scale),
                    height: Math.floor(size.height * scale),
                    "--total-scale-factor": scale,
                  } as React.CSSProperties
                }
                onDoubleClick={(event) => handleDoubleClick(event, pageNumber)}
              >
                {rendered && (
                  <PdfPageCanvas
                    pdfDocument={pdfDocument}
                    pageNumber={pageNumber}
                    pageCount={pageCount}
                    scale={scale}
                    onError={setPreviewError}
                  />
                )}
                {matchBoxesByPage.get(pageNumber)?.map(({ box, index: match }, key) => (
                  <div
                    key={key}
                    className={match === activeMatch ? "pdf-match active" : "pdf-match"}
                    style={{
                      left: `${box.left}%`,
                      top: `${box.top}%`,
                      width: `${box.width}%`,
                      height: `${box.height}%`,
                    }}
                  />
                ))}
              </div>
            );
          })}

        {selectionChip && (
          <button
            type="button"
            className="pdf-edit pdf-edit-chip"
            style={{ left: selectionChip.left, top: selectionChip.top }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openTextEdit}
          >
            <PencilSimple aria-hidden="true" />
            Edit text
          </button>
        )}

        {textEdit && (
          <div
            ref={editPopoverRef}
            className="pdf-edit pdf-edit-popover"
            role="dialog"
            aria-labelledby="pdf-edit-title"
            style={{ left: textEdit.left, top: textEdit.top }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeTextEdit();
              }
            }}
          >
            <div className="pdf-edit-heading">
              <span id="pdf-edit-title">Edit text</span>
              {textEdit.edit.kind === "ready" && <code>{textEdit.edit.location}</code>}
            </div>
            {textEdit.edit.kind === "ready" ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  submitTextEdit();
                }}
              >
                <textarea
                  ref={editInputRef}
                  value={editValue}
                  rows={3}
                  aria-label="Replacement text"
                  onChange={(event) => setEditValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      submitTextEdit();
                    }
                  }}
                />
                {textEdit.error && (
                  <p className="pdf-edit-message" role="alert">
                    {textEdit.error}
                  </p>
                )}
                <div className="pdf-edit-actions">
                  <span className="pdf-edit-hint">Enter to replace</span>
                  <button type="button" className="secondary-button" onClick={closeTextEdit}>
                    Cancel
                  </button>
                  <button type="submit" className="pdf-edit-apply">
                    Replace
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="pdf-edit-message" role="alert">
                  {textEdit.edit.message}
                </p>
                <div className="pdf-edit-actions">
                  {textEdit.edit.reveal && (
                    <button
                      type="button"
                      className="pdf-edit-apply"
                      onClick={() => {
                        if (textEdit.edit.kind === "unavailable") textEdit.edit.reveal?.();
                        setTextEdit(null);
                      }}
                    >
                      Go to source
                    </button>
                  )}
                  <button type="button" className="secondary-button" onClick={closeTextEdit}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const PROJECT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// The "play" palette from the designer portfolio: Gaussian colour blobs warped
// by simplex noise, blended as weighted averages so they mix like wet paint.
const PROJECTS_BACKDROP_SHADER = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
  varying vec2 uv;
  uniform vec2 res;
  uniform float time;
  vec3 perm(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = perm(perm(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  float blob(vec2 p, vec2 c, float r) { vec2 d = p - c; return exp(-dot(d, d) / (r * r)); }
  vec3 acc; float tot;
  void add(vec3 c, vec2 w, vec2 at, float r, float k) { float b = blob(w, at, r) * k; acc += c * b; tot += b; }
  void main() {
    float a = res.x / res.y;
    vec2 p = vec2(uv.x * a, 1.0 - uv.y);
    float t = time;
    vec2 w = p + 0.10 * vec2(snoise(p * 1.7 + vec2(t * 0.06, 1.3)), snoise(p * 1.7 + vec2(-2.1, t * 0.05)));
    acc = vec3(0.0); tot = 0.35;
    add(vec3(0.03, 0.60, 0.57), w, vec2((0.80 + 0.05 * sin(t * 0.12)) * a, 0.12 + 0.04 * cos(t * 0.10)), 0.30, 3.0);
    add(vec3(0.05, 0.66, 0.62), w, vec2((0.98 + 0.04 * sin(t * 0.08)) * a, 0.26), 0.18, 1.8);
    add(vec3(0.02, 0.42, 0.42), w, vec2((0.57 + 0.04 * cos(t * 0.09)) * a, 0.22), 0.14, 1.6);
    add(vec3(0.31, 0.01, 0.21), w, vec2((0.16 + 0.04 * sin(t * 0.08)) * a, 0.24 + 0.05 * sin(t * 0.11)), 0.22, 2.0);
    add(vec3(0.77, 0.58, 0.10), w, vec2((-0.02 + 0.03 * sin(t * 0.10)) * a, 0.52 + 0.06 * cos(t * 0.07)), 0.22, 2.4);
    add(vec3(0.47, 0.38, 0.02), w, vec2(0.06 * a, 0.95), 0.20, 1.6);
    add(vec3(0.58, 0.40, 0.66), w, vec2((0.30 + 0.04 * sin(t * 0.13)) * a, 0.80), 0.11, 1.2);
    add(vec3(0.85, 0.70, 0.56), w, vec2(0.13 * a, 0.66), 0.07, 0.8);
    add(vec3(0.83, 0.24, 0.07), w, vec2((0.70 + 0.06 * sin(t * 0.09)) * a, 1.05), 0.26, 3.2);
    add(vec3(0.84, 0.22, 0.10), w, vec2((0.96 + 0.03 * cos(t * 0.11)) * a, 0.98), 0.18, 2.2);
    add(vec3(0.86, 0.44, 0.11), w, vec2(0.46 * a, 1.0), 0.15, 2.0);
    vec3 col = acc / tot;
    col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Draws at no more than 60% resolution and lets CSS stretch it, which softens
// the blobs for free. Without WebGL the canvas stays transparent over the CSS fallback.
function startProjectsBackdrop(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", {
    antialias: false,
    depth: false,
    stencil: false,
    alpha: false,
    powerPreference: "low-power",
  });
  if (!gl) return () => undefined;

  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return false;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
  };
  if (
    !compile(
      gl.VERTEX_SHADER,
      "attribute vec2 p; varying vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
    ) ||
    !compile(gl.FRAGMENT_SHADER, PROJECTS_BACKDROP_SHADER)
  ) {
    return () => undefined;
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return () => undefined;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const resolution = gl.getUniformLocation(program, "res");
  const time = gl.getUniformLocation(program, "time");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startedAt = performance.now();
  let frame = 0;
  const draw = (now: number) => {
    gl.uniform1f(time, reduceMotion ? 6 : ((now - startedAt) / 1000) * 2.2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.dataset.ready = "";
    if (!reduceMotion) frame = requestAnimationFrame(draw);
  };
  const resize = () => {
    const scale = Math.min(0.6, 1100 / Math.max(window.innerWidth, 1));
    canvas.width = Math.max(2, Math.round(canvas.clientWidth * scale));
    canvas.height = Math.max(2, Math.round(canvas.clientHeight * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(resolution, canvas.width, canvas.height);
    if (reduceMotion) draw(performance.now());
  };
  resize();
  window.addEventListener("resize", resize);
  if (!reduceMotion) frame = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  };
}

function ProjectsScreen({
  account,
  email,
  projects,
  expired,
  error,
  openProjectId,
  openProjectName,
  busy,
  onOpen,
  onNew,
  onSaveCurrent,
  onDelete,
  onRefresh,
  onSignIn,
  onSignOut,
  onClose,
}: {
  account: "checking" | "unavailable" | "signed-out" | "signed-in";
  email: string;
  projects: DriveProject[] | "loading" | null;
  expired: boolean;
  error: string;
  openProjectId: string;
  openProjectName: string;
  busy: boolean;
  onOpen: (project: DriveProject) => void;
  onNew: () => void;
  onSaveCurrent: () => void;
  onDelete: (project: DriveProject) => void;
  onRefresh: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const backdropRef = useRef<HTMLCanvasElement | null>(null);
  const [confirmId, setConfirmId] = useState("");
  const signedIn = account === "signed-in";
  const subtitle = {
    checking: "Checking your Google sign-in",
    unavailable: "Google sign-in is not set up on this site, so your project is saved in this browser only.",
    "signed-out": "Sign in with Google to see the projects saved in your Google Drive.",
    "signed-in": email ? `Stored in your Google Drive as ${email}` : "Stored in your Google Drive",
  }[account];

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    const canvas = backdropRef.current;
    return canvas ? startProjectsBackdrop(canvas) : undefined;
  }, []);

  return (
    <section
      className="projects-screen"
      aria-labelledby="projects-heading"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (confirmId) setConfirmId("");
        else onClose();
      }}
    >
      <canvas ref={backdropRef} className="projects-backdrop" aria-hidden="true" />
      <div className="projects-scroll">
        <div className={`projects-inner${account === "signed-out" ? " signed-out" : ""}`}>
          <header className="projects-header">
            <div>
              <h2 id="projects-heading" ref={headingRef} tabIndex={-1}>
                Your <span className="accent">projects</span>
              </h2>
              <p>{subtitle}</p>
            </div>
            <div className="projects-header-actions">
              <button type="button" className="secondary-button" onClick={onClose}>
                <PencilSimple aria-hidden="true" />
                Open editor
              </button>
              {signedIn && (
                <button type="button" className="secondary-button" onClick={onSignOut}>
                  <SignOut aria-hidden="true" />
                  Sign out
                </button>
              )}
            </div>
          </header>

          {signedIn && (
            <div className="projects-actions">
              <button
                type="button"
                className="compile-button"
                onClick={onNew}
                disabled={busy || expired}
              >
                <Plus weight="bold" aria-hidden="true" />
                <span>New project</span>
              </button>
              {!openProjectId && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onSaveCurrent}
                  disabled={busy || expired}
                >
                  <CloudArrowUp aria-hidden="true" />
                  Save “{openProjectName}” to Google Drive
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={onRefresh}
                disabled={projects === "loading"}
              >
                <ArrowClockwise aria-hidden="true" />
                Refresh
              </button>
            </div>
          )}

          {error && (
            <p className="projects-message error" role="alert">
              <WarningCircle weight="fill" aria-hidden="true" />
              {error}
            </p>
          )}

          {account === "signed-out" && (
            <div className="projects-sign-in">
              <button type="button" className="compile-button" onClick={onSignIn}>
                <GoogleLogo weight="bold" aria-hidden="true" />
                <span>Sign in with Google</span>
              </button>
            </div>
          )}

          {!signedIn ? null : expired ? (
            <div className="projects-message" role="alert">
              <span>Your Google sign-in expired.</span>
              <button type="button" className="secondary-button" onClick={onSignIn}>
                <GoogleLogo aria-hidden="true" />
                Sign in again
              </button>
            </div>
          ) : projects === "loading" ? (
            <p className="projects-message">
              <SpinnerGap className="spin" aria-hidden="true" />
              Loading your projects from Google Drive
            </p>
          ) : projects === null ? (
            <div className="projects-message">
              <span>Could not load your projects.</span>
              <button type="button" className="secondary-button" onClick={onRefresh}>
                Try again
              </button>
            </div>
          ) : projects.length === 0 ? (
            <p className="projects-message">
              No projects in Google Drive yet. Create one, or save the project you have open.
            </p>
          ) : (
            <ul className="projects-list">
              {projects.map((item) => {
                const current = item.id === openProjectId;
                return (
                  <li key={item.id} className={`projects-item${current ? " current" : ""}`}>
                    <button
                      type="button"
                      className="projects-item-open"
                      disabled={busy}
                      onClick={() => onOpen(item)}
                    >
                      <Cloud aria-hidden="true" />
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {current ? "Open now · " : ""}Edited{" "}
                          {PROJECT_DATE_FORMAT.format(new Date(item.modifiedTime))}
                        </small>
                      </span>
                    </button>
                    {confirmId === item.id ? (
                      <button
                        type="button"
                        className="secondary-button projects-delete-confirm"
                        disabled={busy}
                        autoFocus
                        onClick={() => {
                          setConfirmId("");
                          onDelete(item);
                        }}
                      >
                        Confirm delete
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Delete ${item.name} from Google Drive`}
                        title="Delete from Google Drive"
                        onClick={() => setConfirmId(item.id)}
                      >
                        <Trash />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [project, setProject] = useState(createInitialProject);
  const [documentName, setDocumentName] = useState(() =>
    safeStorageRead(NAME_KEY, "untitled-paper"),
  );
  const [saveState, setSaveState] = useState<"saving" | "saved" | "error">(
    "saved",
  );
  const [compileStatus, setCompileStatus] = useState<CompileStatus>({
    phase: "idle",
    label: "Compiler not loaded",
  });
  const [progress, setProgress] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [syncTexData, setSyncTexData] = useState<string | null>(null);
  const [projectRevision, setProjectRevision] = useState(0);
  const [compiledRevision, setCompiledRevision] = useState(-1);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [rawLogOpen, setRawLogOpen] = useState(false);
  const [activePane, setActivePane] = useState<"source" | "preview" | "assistant">(
    "source",
  );
  const [assistantOpen, setAssistantOpen] = useState(
    () => safeStorageRead(ASSISTANT_OPEN_KEY, "0") === "1",
  );
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [split, setSplit] = useState(() => {
    const stored = Number(safeStorageRead(SPLIT_KEY, "52"));
    return Number.isFinite(stored) ? Math.min(68, Math.max(32, stored)) : 52;
  });
  const [explorerWidth, setExplorerWidth] = useState(() => {
    const stored = Number(
      safeStorageRead(EXPLORER_WIDTH_KEY, String(EXPLORER_DEFAULT_WIDTH)),
    );
    return Number.isFinite(stored)
      ? Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, stored))
      : EXPLORER_DEFAULT_WIDTH;
  });
  const [explorerHidden, setExplorerHidden] = useState(
    () => safeStorageRead(EXPLORER_HIDDEN_KEY, "0") === "1",
  );
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [compileRequest, setCompileRequest] = useState(0);
  const [googleStatus, setGoogleStatus] = useState<"checking" | "available" | "unavailable">(
    "checking",
  );
  const [googleSession, setGoogleSession] = useState<GoogleSession | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(googleSignIn.showProjects);
  const [driveProjectId, setDriveProjectId] = useState(() =>
    safeStorageRead(DRIVE_PROJECT_KEY, ""),
  );
  const [driveDirty, setDriveDirty] = useState(
    () => safeStorageRead(DRIVE_DIRTY_KEY, "0") === "1",
  );
  const [driveReady, setDriveReady] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveState, setDriveState] = useState<
    "idle" | "saving" | "saved" | "error" | "expired"
  >("idle");
  const [driveError, setDriveError] = useState(googleSignIn.error ?? "");
  const [driveProjects, setDriveProjects] = useState<DriveProject[] | "loading" | null>(
    "loading",
  );
  const [accountSettings, setAccountSettings] = useState<AccountSettings | null | undefined>(undefined);

  const editorRef = useRef<EditorView | null>(null);
  const compilerRef = useRef<CompilerSession | null>(null);
  const syncTexRef = useRef<{ data: string; index: SyncTexIndex } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);
  const draggingRef = useRef(false);
  const explorerDragRef = useRef<{ grab: number } | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const fileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileMenuFocusRef = useRef<"first" | "last">("first");
  // Edits from the preview outlive the render that prepared them, so they read
  // the latest project and compile through these.
  const projectRef = useRef(project);
  const compileRef = useRef<() => Promise<CompileSummary>>(async () => ({
    success: false,
    message: "The compiler is not ready yet.",
    diagnostics: [],
    log: "",
  }));
  const busyRef = useRef(false);
  const documentNameRef = useRef(documentName);
  // The project and name that Google Drive last confirmed as saved.
  const syncedRef = useRef<DriveSnapshot>({ project, documentName });
  const driveTimerRef = useRef(0);
  const driveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const projectsButtonRef = useRef<HTMLButtonElement | null>(null);
  const projectsFocusRef = useRef<"editor" | "button" | null>(null);

  const activeEntry = project.files[project.activeFile];
  const source = activeEntry?.kind === "text" ? activeEntry.content : "";
  const busy =
    compileStatus.phase === "setup" || compileStatus.phase === "compiling";
  const stale = Boolean(pdfBytes && compiledRevision !== projectRevision);
  const byteSize = useMemo(
    () => projectByteSize(project.files),
    [project.files],
  );
  const projectPaths = useMemo(
    () => Object.keys(project.files).sort((left, right) => left.localeCompare(right)),
    [project.files],
  );
  const hasBinaryFiles = useMemo(
    () => Object.values(project.files).some((file) => file.kind === "binary"),
    [project.files],
  );

  const editorExtensions = useMemo(
    () => [
      StreamLanguage.define(stex),
      search({ top: true }),
      // Mod-Enter is the window-level compile shortcut; without this the
      // default keymap also inserts a blank line into the source.
      Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => true }])),
    ],
    [],
  );

  useEffect(() => {
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      try {
        const textFiles = Object.fromEntries(
          Object.entries(project.files)
            .filter(([, file]) => file.kind === "text")
            .map(([path, file]) => [
              path,
              file.kind === "text" ? file.content : "",
            ]),
        );
        window.localStorage.setItem(
          PROJECT_KEY,
          JSON.stringify({
            files: textFiles,
            activeFile: project.activeFile,
            mainFile: project.mainFile,
          }),
        );
        window.localStorage.setItem(NAME_KEY, sanitizeFilename(documentName));
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [documentName, project]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_KEY, String(split));
    } catch {
      // The splitter remains usable when local storage is unavailable.
    }
  }, [split]);

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth));
    } catch {
      // The resizer remains usable when local storage is unavailable.
    }
  }, [explorerWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPLORER_HIDDEN_KEY, explorerHidden ? "1" : "0");
    } catch {
      // The toggle remains usable when local storage is unavailable.
    }
  }, [explorerHidden]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ASSISTANT_OPEN_KEY, assistantOpen ? "1" : "0");
    } catch {
      // The panel still opens when local storage is unavailable.
    }
  }, [assistantOpen]);

  useEffect(() => {
    if (!fileMenuOpen) return;
    const items = Array.from(
      fileMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    (fileMenuFocusRef.current === "last" ? items[items.length - 1] : items[0])?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!fileMenuRef.current?.contains(event.target as Node)) {
        setFileMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [fileMenuOpen]);

  useEffect(
    () => () => {
      requestRef.current += 1;
      compilerRef.current?.compiler.unload();
    },
    [],
  );

  const updateActiveSource = useCallback(
    (content: string) => {
      setProject((current) => {
        const active = current.files[current.activeFile];
        if (!active || active.kind !== "text") return current;
        return {
          ...current,
          files: {
            ...current.files,
            [current.activeFile]: { kind: "text", content },
          },
        };
      });
      setProjectRevision((value) => value + 1);
    },
    [],
  );

  const downloadSource = useCallback(() => {
    if (!activeEntry || activeEntry.kind !== "text") return;
    downloadBlob(
      new Blob([activeEntry.content], { type: "text/plain;charset=utf-8" }),
      project.activeFile.split("/").pop() ?? "main.tex",
    );
  }, [activeEntry, project.activeFile]);

  const exportProject = useCallback(() => {
    downloadBlob(
      new Blob([projectToZip(project.files)], { type: "application/zip" }),
      `${sanitizeFilename(documentName)}.zip`,
    );
  }, [documentName, project.files]);

  const loadProject = useCallback(
    (
      files: ProjectFiles,
      mainFile: string,
      activeFile: string,
      name: string,
      label: string,
    ) => {
      const next = {
        files,
        activeFile: files[activeFile] ? activeFile : mainFile,
        mainFile,
      };
      const nextName = sanitizeFilename(name);
      setProject(next);
      setDocumentName(nextName);
      setProjectRevision((value) => value + 1);
      setCompiledRevision(-1);
      setPdfBytes(null);
      setSyncTexData(null);
      setDiagnostics([]);
      setLogs([]);
      setCompileStatus({ phase: "idle", label });
      return { project: next, documentName: nextName };
    },
    [],
  );

  const reportError = useCallback((message: string, label: string) => {
    setDiagnostics([{ severity: "error", message }]);
    setDiagnosticsOpen(true);
    setCompileStatus({ phase: "error", label });
  }, []);

  const uploadProject = (
    session: GoogleSession,
    snapshot: DriveSnapshot,
    id: string,
  ) => {
    const run = async () => {
      const savedId = await uploadDriveFile(session, {
        id: id || undefined,
        name: `${sanitizeFilename(snapshot.documentName)}.zip`,
        mimeType: "application/zip",
        appProperties: {
          type: "project",
          mainFile: snapshot.project.mainFile,
          activeFile: snapshot.project.activeFile,
        },
        body: new Blob([projectToZip(snapshot.project.files)], {
          type: "application/zip",
        }),
      });
      syncedRef.current = snapshot;
      if (
        projectRef.current === snapshot.project &&
        documentNameRef.current === snapshot.documentName
      ) {
        setDriveDirty(false);
      }
      setDriveState("saved");
      setDriveError("");
      return savedId;
    };
    const result = driveQueueRef.current.then(run, run);
    driveQueueRef.current = result.catch(() => undefined);
    return result;
  };

  const flushDriveSave = async () => {
    const snapshot = {
      project: projectRef.current,
      documentName: documentNameRef.current,
    };
    if (
      googleSession &&
      driveReady &&
      driveProjectId &&
      (snapshot.project !== syncedRef.current.project ||
        snapshot.documentName !== syncedRef.current.documentName)
    ) {
      window.clearTimeout(driveTimerRef.current);
      await uploadProject(googleSession, snapshot, driveProjectId);
    }
    await driveQueueRef.current;
  };

  const runDriveAction = async (action: (session: GoogleSession) => Promise<void>) => {
    if (!googleSession) return;
    setDriveBusy(true);
    setDriveError("");
    try {
      await action(googleSession);
    } catch (error) {
      if (error instanceof GoogleExpiredError) {
        setDriveState("expired");
      } else {
        const message =
          error instanceof Error ? error.message : "Google Drive did not respond.";
        setDriveError(message);
        reportError(message, "Google Drive action failed");
      }
    } finally {
      setDriveBusy(false);
    }
  };

  const refreshDriveProjects = async () => {
    if (!googleSession) return;
    setDriveProjects("loading");
    setDriveError("");
    try {
      setDriveProjects(await listDriveProjects(googleSession));
    } catch (error) {
      setDriveProjects(null);
      if (error instanceof GoogleExpiredError) {
        setDriveState("expired");
      } else {
        setDriveError(error instanceof Error ? error.message : "Google Drive did not respond.");
      }
    }
  };

  const closeProjects = () => {
    projectsFocusRef.current = "button";
    setProjectsOpen(false);
  };

  const showEditor = () => {
    projectsFocusRef.current = "editor";
    setProjectsOpen(false);
  };

  useEffect(() => {
    if (projectsOpen) return;
    const target = projectsFocusRef.current;
    projectsFocusRef.current = null;
    if (target === "editor") {
      editorRef.current?.focus();
    } else if (target === "button") {
      projectsButtonRef.current?.focus();
    }
  }, [projectsOpen]);

  const openDriveProject = (target: DriveProject) => {
    if (target.id === driveProjectId) {
      closeProjects();
      return;
    }
    void runDriveAction(async (session) => {
      await flushDriveSave();
      const files = projectFromZip(await downloadDriveFile(session, target.id));
      const mainFile = files[target.mainFile]
        ? target.mainFile
        : pickMainFile(Object.keys(files));
      if (!mainFile) {
        throw new Error("The project must contain at least one .tex file.");
      }
      syncedRef.current = loadProject(
        files,
        mainFile,
        target.activeFile,
        target.name,
        "Opened from Google Drive",
      );
      setDriveProjectId(target.id);
      setDriveDirty(false);
      setDriveState("saved");
      setDriveReady(true);
      showEditor();
    });
  };

  const newDriveProject = () => {
    void runDriveAction(async (session) => {
      await flushDriveSave();
      const snapshot = loadProject(
        { "main.tex": { kind: "text", content: STARTER_SOURCE } },
        "main.tex",
        "main.tex",
        "untitled-paper",
        "New project",
      );
      setDriveProjectId("");
      setDriveDirty(false);
      setDriveProjectId(await uploadProject(session, snapshot, ""));
      setDriveReady(true);
      showEditor();
    });
  };

  const saveProjectToDrive = () => {
    void runDriveAction(async (session) => {
      const snapshot = {
        project: projectRef.current,
        documentName: documentNameRef.current,
      };
      setDriveProjectId(await uploadProject(session, snapshot, ""));
      setDriveReady(true);
      await refreshDriveProjects();
    });
  };

  const deleteDriveProject = (target: DriveProject) => {
    void runDriveAction(async (session) => {
      const isOpen = target.id === driveProjectId;
      if (isOpen) {
        window.clearTimeout(driveTimerRef.current);
        await driveQueueRef.current;
      }
      await deleteDriveFile(session, target.id);
      if (isOpen) {
        setDriveProjectId("");
        setDriveDirty(false);
        setDriveState("idle");
      }
      await refreshDriveProjects();
    });
  };

  const signIn = () => startGoogleSignIn(driveState !== "expired");

  const signOut = async () => {
    if (!googleSession) return;
    try {
      await flushDriveSave();
    } catch {
      // Sign out even when the last save fails; the local copy keeps the edits.
    }
    await fetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    setGoogleSession(null);
    setDriveReady(false);
    setDriveState("idle");
    setDriveProjects("loading");
    setAccountSettings(undefined);
    setDriveError("");
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(DRIVE_PROJECT_KEY, driveProjectId);
      window.localStorage.setItem(DRIVE_DIRTY_KEY, driveDirty ? "1" : "0");
    } catch {
      // Drive saving still works for this page when local storage is unavailable.
    }
  }, [driveDirty, driveProjectId]);

  useEffect(() => {
    if (googleSignIn.error) reportError(googleSignIn.error, "Google sign-in failed");
  }, [reportError]);

  useEffect(() => {
    let cancelled = false;
    requestGoogleSession().then(
      (result) => {
        if (cancelled) return;
        setGoogleStatus(result === "unavailable" ? "unavailable" : "available");
        if (typeof result === "object") setGoogleSession(result);
      },
      (error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Google sign-in is not responding.";
        setGoogleStatus("available");
        setDriveError(message);
        reportError(message, "Google sign-in unavailable");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  useEffect(() => {
    if (!googleSession) return;
    const session = googleSession;
    let cancelled = false;
    const fail = (error: unknown) => {
      if (cancelled) return;
      if (error instanceof GoogleExpiredError) {
        setDriveState("expired");
        return;
      }
      const message =
        error instanceof Error ? error.message : "Google Drive did not respond.";
      setDriveState("error");
      setDriveError(message);
      reportError(message, "Google Drive unavailable");
    };

    void (async () => {
      try {
        const settings = await loadDriveSettings(session);
        if (cancelled) return;
        setAccountSettings(settings);
      } catch (error) {
        fail(error);
        return;
      }

      if (!driveProjectId) {
        if (!cancelled) setDriveReady(true);
        return;
      }
      try {
        const [target, bytes] = await Promise.all([
          getDriveProject(session, driveProjectId),
          downloadDriveFile(session, driveProjectId),
        ]);
        const files = projectFromZip(bytes);
        if (cancelled) return;
        if (driveDirty) {
          // Local storage keeps only text, so images come back from Drive
          // while the newer local text wins.
          setProject((current) => ({
            ...current,
            files: {
              ...Object.fromEntries(
                Object.entries(files).filter(([, file]) => file.kind === "binary"),
              ),
              ...current.files,
            },
          }));
          setProjectRevision((value) => value + 1);
        } else {
          const mainFile = files[target.mainFile]
            ? target.mainFile
            : pickMainFile(Object.keys(files));
          if (mainFile) {
            syncedRef.current = loadProject(
              files,
              mainFile,
              target.activeFile,
              target.name,
              "Opened from Google Drive",
            );
          }
          setDriveState("saved");
        }
        setDriveReady(true);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof GoogleRequestError && error.status === 404) {
          setDriveProjectId("");
          setDriveDirty(false);
          setDriveReady(true);
          return;
        }
        fail(error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [googleSession]);

  useEffect(() => {
    if (!driveProjectId) return;
    const snapshot = { project, documentName };
    if (
      snapshot.project === syncedRef.current.project &&
      snapshot.documentName === syncedRef.current.documentName
    ) {
      return;
    }
    setDriveDirty(true);
    if (!googleSession || !driveReady) return;
    setDriveState("saving");
    const session = googleSession;
    driveTimerRef.current = window.setTimeout(() => {
      uploadProject(session, snapshot, driveProjectId).catch((error: unknown) => {
        if (error instanceof GoogleExpiredError) {
          setDriveState("expired");
        } else {
          setDriveState("error");
          setDriveError(
            error instanceof Error ? error.message : "Google Drive did not respond.",
          );
        }
      });
    }, DRIVE_SAVE_DELAY);
    return () => window.clearTimeout(driveTimerRef.current);
  }, [documentName, driveProjectId, driveReady, googleSession, project]);

  useEffect(() => {
    if (projectsOpen && googleSession) void refreshDriveProjects();
  }, [projectsOpen, googleSession]);

  const importProject = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      try {
        if (file.size > MAX_IMPORT_BYTES) {
          throw new Error("Project archives must be 25 MiB or smaller.");
        }

        let importedFiles: ProjectFiles;
        if (file.name.toLowerCase().endsWith(".tex")) {
          importedFiles = {
            "main.tex": { kind: "text", content: await file.text() },
          };
        } else {
          importedFiles = projectFromZip(new Uint8Array(await file.arrayBuffer()));
        }

        if (projectByteSize(importedFiles) > MAX_PROJECT_BYTES) {
          throw new Error("The unpacked project is larger than 50 MiB.");
        }

        const mainFile = pickMainFile(Object.keys(importedFiles));
        if (!mainFile) {
          throw new Error("The project must contain at least one .tex file.");
        }

        await flushDriveSave().catch(() => undefined);
        setDriveProjectId("");
        setDriveDirty(false);
        loadProject(
          importedFiles,
          mainFile,
          mainFile,
          file.name.replace(/\.(zip|tex)$/i, ""),
          "Project imported",
        );
      } catch (error) {
        reportError(
          error instanceof Error ? error.message : "The project could not be imported.",
          "Import failed",
        );
      }
    },
    [flushDriveSave, loadProject, reportError],
  );

  const downloadPdf = useCallback(() => {
    if (!pdfBytes) return;
    downloadBlob(
      new Blob([pdfBytes], { type: "application/pdf" }),
      `${sanitizeFilename(documentName)}.pdf`,
    );
  }, [documentName, pdfBytes]);

  const handleProgress = useCallback((nextProgress: CompilerProgress) => {
    setProgress(nextProgress.detail || nextProgress.stage);
  }, []);

  const handleLog = useCallback((message: string) => {
    setLogs((current) => [...current.slice(-1999), message]);
  }, []);

  const cancelCompile = useCallback(() => {
    requestRef.current += 1;
    compilerRef.current?.compiler.terminate();
    compilerRef.current = null;
    setCompileStatus({ phase: "cancelled", label: "Compile cancelled" });
    setProgress("");
  }, []);

  const compile = useCallback(async (): Promise<CompileSummary> => {
    const failure = (message: string, log = ""): CompileSummary => ({
      success: false,
      message,
      diagnostics: [{ message }],
      log,
    });
    if (busy) {
      cancelCompile();
      return failure("Compile cancelled.");
    }

    const mainEntry = project.files[project.mainFile];
    if (!mainEntry || mainEntry.kind !== "text") {
      const message = "Choose a text .tex file as the project main file.";
      setDiagnostics([{ severity: "error", message }]);
      setDiagnosticsOpen(true);
      return failure(message);
    }

    const mainByteSize = new TextEncoder().encode(mainEntry.content).byteLength;
    if (mainByteSize > 1024 * 1024 || byteSize > MAX_PROJECT_BYTES) {
      const message =
        mainByteSize > 1024 * 1024
          ? "The main source is larger than the 1 MiB compilation limit."
          : "The project is larger than the 50 MiB compilation limit.";
      setDiagnostics([{ severity: "error", message }]);
      setDiagnosticsOpen(true);
      return failure(message);
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const mainFileSnapshot = project.mainFile;
    const sourceSnapshot = mainEntry.content;
    const revisionSnapshot = projectRevision;
    const additionalFiles = Object.fromEntries(
      Object.entries(project.files)
        .filter(([path]) => path !== mainFileSnapshot)
        .map(([path, file]) => [
          path,
          file.kind === "text" ? file.content : file.content.slice(),
        ]),
    );
    const startedAt = performance.now();
    setLogs([]);
    setDiagnostics([]);
    setRawLogOpen(false);
    setCompileStatus({ phase: "setup", label: "Preparing compiler" });
    setProgress("Resolving the verified TeX Live runtime");

    try {
      if (!compilerRef.current) {
        compilerRef.current = await createCompilerSession(
          handleProgress,
          handleLog,
        );
      }
      if (requestRef.current !== requestId) return failure("A newer compile replaced this one.");

      setCompileStatus({
        phase: "compiling",
        label: `Compiling ${mainFileSnapshot}`,
      });
      setProgress("Running pdfLaTeX");
      const result = await compilerRef.current.compile(
        sourceSnapshot,
        mainFileSnapshot,
        additionalFiles,
      );
      if (requestRef.current !== requestId) return failure("A newer compile replaced this one.");

      const duration = performance.now() - startedAt;
      if (result.success) {
        const label = `Compiled in ${(duration / 1000).toFixed(1)} s`;
        setPdfBytes(result.pdf.slice());
        setSyncTexData(result.syncTexData ?? null);
        setCompiledRevision(revisionSnapshot);
        setLogs(result.log ? result.log.split("\n").slice(-2000) : []);
        setCompileStatus({ phase: "success", label, duration });
        setProgress("");
        return { success: true, message: label, diagnostics: [], log: result.log ?? "" };
      }
      const rawLog = result.log ?? "";
      const diagnostic = parseDiagnostic(result.error, rawLog, mainFileSnapshot);
      setLogs(rawLog.split("\n").slice(-2000));
      setDiagnostics([diagnostic]);
      setDiagnosticsOpen(true);
      setRawLogOpen(true);
      setCompileStatus({
        phase: "error",
        label: "Compile failed",
        duration,
      });
      setProgress("");
      return { success: false, message: "Compile failed.", diagnostics: [diagnostic], log: rawLog };
    } catch (error) {
      if (requestRef.current !== requestId) return failure("A newer compile replaced this one.");
      const message =
        error instanceof Error
          ? error.message
          : "The browser compiler could not be loaded.";
      setDiagnostics([{ severity: "error", message }]);
      setDiagnosticsOpen(true);
      setRawLogOpen(true);
      setCompileStatus({ phase: "error", label: "Compiler unavailable" });
      setProgress("");
      compilerRef.current?.compiler.unload();
      compilerRef.current = null;
      return failure(message);
    }
  }, [
    busy,
    byteSize,
    cancelCompile,
    handleLog,
    handleProgress,
    project,
    projectRevision,
  ]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void compile();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) {
          exportProject();
        } else {
          downloadSource();
        }
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [compile, downloadSource, exportProject]);

  useLayoutEffect(() => {
    projectRef.current = project;
    documentNameRef.current = documentName;
    compileRef.current = compile;
    busyRef.current = busy;
  });

  const assistantHost = useMemo<AssistantHost>(
    () => ({
      getProject: () => projectRef.current as AssistantProject,
      setProject: (next) => {
        flushSync(() => {
          setProject(next as typeof projectRef.current);
          setProjectRevision((value) => value + 1);
        });
      },
      compile: async () => {
        while (busyRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        }
        return compileRef.current();
      },
      isTextPath,
      normalizePath: normalizeProjectPath,
      maxFiles: MAX_PROJECT_FILES,
      maxBytes: MAX_PROJECT_BYTES,
    }),
    [],
  );

  useEffect(() => {
    if (compileRequest > 0) void compileRef.current();
  }, [compileRequest]);

  const showAssistant = assistantOpen || activePane === "assistant";

  const openAssistant = () => {
    setAssistantOpen(true);
    if (window.matchMedia("(max-width: 899px)").matches) setActivePane("assistant");
  };

  const closeAssistant = () => {
    setAssistantOpen(false);
    if (activePane === "assistant") setActivePane("source");
  };

  const revealSourceLine = (file: string | undefined, lineNumber: number) => {
    if (file && project.files[file]?.kind === "text") {
      setProject((current) => ({ ...current, activeFile: file }));
    }
    setActivePane("source");
    window.setTimeout(() => {
      const view = editorRef.current;
      if (!view) return;
      const safeLine = Math.min(Math.max(lineNumber, 1), view.state.doc.lines);
      const line = view.state.doc.line(safeLine);
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
      view.focus();
    }, 0);
  };

  const searchSource = () => {
    if (activeEntry?.kind === "text" && editorRef.current) {
      openSearchPanel(editorRef.current);
    }
  };

  const jumpToDiagnostic = (diagnostic: Diagnostic) => {
    if (diagnostic.line) revealSourceLine(diagnostic.file, diagnostic.line);
  };

  const getSyncTexIndex = () => {
    if (!syncTexData) return null;
    if (syncTexRef.current?.data !== syncTexData) {
      syncTexRef.current = { data: syncTexData, index: parseSyncTex(syncTexData) };
    }
    return syncTexRef.current.index;
  };

  const locateSource = (page: number, x: number, y: number) => {
    const index = getSyncTexIndex();
    if (!index) return;
    const target = findSyncTexSource(
      index,
      page,
      x,
      y,
      (file) => project.files[file]?.kind === "text",
    );
    const entry = target && project.files[target.file];
    if (!target || entry?.kind !== "text") return;

    // The last line of a paragraph maps to the blank line that ends it.
    const lines = entry.content.split("\n");
    let line = Math.min(target.line, lines.length);
    while (line > 1 && !lines[line - 1].trim()) line -= 1;
    revealSourceLine(target.file, line);
  };

  const applyTextEdit = (file: string, match: SourceTextMatch, replacement: string) => {
    const current = projectRef.current.files[file];
    if (
      current?.kind !== "text" ||
      current.content.slice(match.start, match.end) !== match.source
    ) {
      return false;
    }
    const change = planTextReplacement(match, replacement);
    if (!change) return true;

    const view = editorRef.current;
    if (
      file === projectRef.current.activeFile &&
      view &&
      view.state.doc.toString() === current.content
    ) {
      // Going through the editor keeps the change on its undo history.
      view.dispatch({
        changes: { from: change.from, to: change.to, insert: change.insert },
        selection: { anchor: change.from + change.insert.length },
        effects: EditorView.scrollIntoView(change.from, { y: "center" }),
        userEvent: "input.replace",
      });
    } else {
      const content =
        current.content.slice(0, change.from) +
        change.insert +
        current.content.slice(change.to);
      setProject((value) => ({
        ...value,
        files: { ...value.files, [file]: { kind: "text", content } },
      }));
      setProjectRevision((value) => value + 1);
    }
    if (!busy) setCompileRequest((value) => value + 1);
    return true;
  };

  const prepareTextEdit = (selection: PdfTextSelection): PdfTextEdit => {
    const index = getSyncTexIndex();
    const target =
      index &&
      findSyncTexSource(
        index,
        selection.page,
        selection.start.x,
        selection.start.y,
        (file) => project.files[file]?.kind === "text",
      );
    const entry = target ? project.files[target.file] : undefined;
    if (!target || entry?.kind !== "text") {
      return {
        kind: "unavailable",
        message: "This part of the PDF doesn't come from a file you can edit here.",
      };
    }

    const reveal = () => revealSourceLine(target.file, target.line);
    const match = findTextInSource(entry.content, selection.text, target.line);
    if (match === "too-long") {
      return {
        kind: "unavailable",
        message: `Select up to ${MAX_EDIT_CHARS} characters at a time.`,
        reveal,
      };
    }
    if (!match) {
      return {
        kind: "unavailable",
        message: stale
          ? "The preview is out of date, so this text may have changed. Compile, then try again."
          : `This text isn't written out in ${target.file}. It may come from a command, maths or formatting, so edit it in the source instead.`,
        reveal,
      };
    }
    return {
      kind: "ready",
      location: `${target.file}:${match.line}`,
      text: match.chars.join(""),
      apply: (replacement) => applyTextEdit(target.file, match, replacement),
    };
  };

  const handleEditorUpdate = useCallback((update: ViewUpdate) => {
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    const column = head - line.from + 1;
    setCursor((current) =>
      current.line === line.number && current.column === column
        ? current
        : { line: line.number, column },
    );
  }, []);

  const startDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
  };

  const dragSplitter = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const workspace = event.currentTarget.parentElement;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    const assistant = workspace.querySelector<HTMLElement>(".assistant-pane:not([hidden])");
    const shared = rect.width - (assistant ? assistant.getBoundingClientRect().width + 10 : 0);
    const next = ((event.clientX - rect.left) / shared) * 100;
    setSplit(Math.min(68, Math.max(32, next)));
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const adjustSplitWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSplit((value) => Math.max(32, value - amount));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSplit((value) => Math.min(68, value + amount));
    }
    if (event.key === "Home") {
      event.preventDefault();
      setSplit(32);
    }
    if (event.key === "End") {
      event.preventDefault();
      setSplit(68);
    }
  };

  const startExplorerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "true";
    explorerDragRef.current = {
      grab: event.clientX - handle.getBoundingClientRect().left,
    };
  };

  const stopExplorerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    explorerDragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const dragExplorer = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = explorerDragRef.current;
    if (!drag) return;
    if ((event.buttons & 1) === 0) {
      stopExplorerResize(event);
      return;
    }
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const left = container.getBoundingClientRect().left;
    setExplorerWidth(clampExplorerWidth(event.clientX - left - drag.grab, container));
  };

  const openFileMenu = (focus: "first" | "last") => {
    fileMenuFocusRef.current = focus;
    setFileMenuOpen(true);
  };

  const runFileMenuAction = (action: () => void) => {
    setFileMenuOpen(false);
    fileMenuButtonRef.current?.focus();
    action();
  };

  const handleFileMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setFileMenuOpen(false);
      fileMenuButtonRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setFileMenuOpen(false);
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? items[(index + 1) % items.length]
        : event.key === "ArrowUp"
          ? items[(index <= 0 ? items.length : index) - 1]
          : event.key === "Home"
            ? items[0]
            : event.key === "End"
              ? items[items.length - 1]
              : null;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const resizeExplorerWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const container = event.currentTarget.parentElement;
    const current = clampExplorerWidth(explorerWidth, container);
    const step = event.shiftKey ? 40 : 8;
    const next =
      event.key === "ArrowLeft"
        ? current - step
        : event.key === "ArrowRight"
          ? current + step
          : event.key === "Home"
            ? EXPLORER_MIN_WIDTH
            : event.key === "End"
              ? EXPLORER_MAX_WIDTH
              : null;
    if (next === null) return;
    event.preventDefault();
    setExplorerWidth(clampExplorerWidth(next, container));
  };

  const googleActive = Boolean(googleSession) && driveState !== "expired";
  // Until the linked project is downloaded, actions on the Projects screen wait.
  const driveSyncing = Boolean(googleSession) && !driveReady && driveState === "idle";
  const driveLabel =
    driveProjectId && googleSession
      ? {
          idle: "",
          saving: "Saving to Google Drive",
          saved: "Saved to Google Drive",
          error: "Not saved to Google Drive",
          expired: "Google sign-in expired",
        }[driveState]
      : "";

  return (
    <div className={`app-shell${projectsOpen ? " projects-open" : ""}`}>
      <a className="skip-link" href="#source-editor">
        Skip to source
      </a>
      <a className="skip-link" href="#preview-heading">
        Skip to preview
      </a>

      <header className="title-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            T<span>e</span>X
          </span>
          <span>
            LaTeX <span className="accent">Editor</span>
          </span>
        </div>
        <div className="window-title">
          {projectsOpen ? "Projects" : sanitizeFilename(documentName)} - LaTeX Editor
        </div>
        {googleStatus === "available" && !projectsOpen ? (
          <button
            className="account-button"
            type="button"
            onClick={googleActive ? () => setProjectsOpen(true) : signIn}
            title={
              googleActive
                ? `Google Drive projects (${googleSession?.email || "signed in"})`
                : "Sign in with Google to save projects and API keys to your Google Drive"
            }
          >
            {googleActive ? <Cloud aria-hidden="true" /> : <GoogleLogo aria-hidden="true" />}
            <span>
              {googleActive
                ? "Projects"
                : driveState === "expired"
                  ? "Sign in again"
                  : "Sign in"}
            </span>
          </button>
        ) : (
          <div className="title-spacer" />
        )}
      </header>

      {projectsOpen && (
        <ProjectsScreen
          account={
            googleSession
              ? "signed-in"
              : googleStatus === "available"
                ? "signed-out"
                : googleStatus
          }
          email={googleSession?.email ?? ""}
          projects={driveProjects}
          expired={driveState === "expired"}
          error={driveError}
          openProjectId={driveProjectId}
          openProjectName={sanitizeFilename(documentName)}
          busy={driveBusy || driveSyncing}
          onOpen={openDriveProject}
          onNew={newDriveProject}
          onSaveCurrent={saveProjectToDrive}
          onDelete={deleteDriveProject}
          onRefresh={() => void refreshDriveProjects()}
          onSignIn={signIn}
          onSignOut={() => void signOut()}
          onClose={closeProjects}
        />
      )}

      <div className="command-bar">
        <button
          ref={projectsButtonRef}
          className="toolbar-button projects-button"
          type="button"
          onClick={() => setProjectsOpen(true)}
          title="All projects"
        >
          <CaretLeft />
          <span>Projects</span>
        </button>

        <label className="document-name">
          <span className="sr-only">Project name</span>
          <FolderOpen aria-hidden="true" />
          <input
            value={documentName}
            maxLength={80}
            onChange={(event) => setDocumentName(event.target.value)}
            onBlur={() => setDocumentName((value) => sanitizeFilename(value))}
          />
        </label>

        <span
          className={`save-state ${
            driveLabel
              ? driveState === "error" || driveState === "expired"
                ? "error"
                : driveState
              : saveState
          }`}
          title={driveLabel && driveState === "error" ? driveError : undefined}
          aria-live="polite"
        >
          {driveLabel ||
            (saveState === "saving"
              ? "Saving"
              : saveState === "saved"
                ? hasBinaryFiles
                  ? "Text saved locally"
                  : "Saved locally"
                : "Not saved")}
        </span>

        <div className="command-spacer" />

        <input
          ref={importInputRef}
          className="sr-only"
          type="file"
          accept=".zip,.tex,application/zip,application/x-tex"
          onChange={(event) => void importProject(event)}
        />

        <button
          className="toolbar-button"
          type="button"
          onClick={() => importInputRef.current?.click()}
          title="Import a ZIP project or LaTeX file"
        >
          <FolderOpen />
          <span>Import</span>
        </button>

        <button
          className="toolbar-button"
          type="button"
          onClick={exportProject}
          title="Export the complete project as ZIP"
        >
          <Export />
          <span>Export ZIP</span>
        </button>

        <button
          className="toolbar-button"
          type="button"
          onClick={downloadSource}
          disabled={!activeEntry || activeEntry.kind !== "text"}
          title="Download the active text file"
        >
          <DownloadSimple />
          <span>Current file</span>
        </button>

        <button
          className="toolbar-button"
          type="button"
          onClick={downloadPdf}
          disabled={!pdfBytes}
          title={
            pdfBytes
              ? stale
                ? "Download the last successful PDF"
                : "Download PDF"
              : "Compile successfully to create a PDF"
          }
        >
          <FilePdf />
          <span>{stale ? "Last PDF" : "Download PDF"}</span>
        </button>

        <button
          className={`toolbar-button${showAssistant ? " active" : ""}`}
          type="button"
          aria-pressed={showAssistant}
          onClick={() => (showAssistant ? closeAssistant() : openAssistant())}
          title="AI assistant"
        >
          <Sparkle />
          <span>Assistant</span>
        </button>

        <button
          className={`compile-button ${busy ? "cancel" : ""}`}
          type="button"
          onClick={() => void compile()}
          aria-describedby={diagnostics.length ? "diagnostics-summary" : undefined}
        >
          {busy ? <X weight="bold" /> : <Play weight="fill" />}
          <span>{busy ? "Cancel" : "Compile"}</span>
          {!busy && <kbd>⌘↵</kbd>}
        </button>

        <div className="file-menu" ref={fileMenuRef}>
          <button
            ref={fileMenuButtonRef}
            className="file-menu-button"
            type="button"
            aria-label="File actions"
            aria-haspopup="menu"
            aria-expanded={fileMenuOpen}
            aria-controls={fileMenuOpen ? "file-menu-list" : undefined}
            title="Import, export and download"
            onClick={() =>
              fileMenuOpen ? setFileMenuOpen(false) : openFileMenu("first")
            }
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                openFileMenu(event.key === "ArrowUp" ? "last" : "first");
              }
            }}
          >
            <DotsThreeVertical weight="bold" />
          </button>
          {fileMenuOpen && (
            <div
              id="file-menu-list"
              className="file-menu-list"
              role="menu"
              aria-label="File actions"
              onKeyDown={handleFileMenuKeyDown}
            >
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={!activeEntry || activeEntry.kind !== "text"}
                onClick={() => runFileMenuAction(downloadSource)}
              >
                <DownloadSimple aria-hidden="true" />
                <span>Download source</span>
                <small>{project.activeFile.split("/").pop()}</small>
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={!pdfBytes}
                onClick={() => runFileMenuAction(downloadPdf)}
              >
                <FilePdf aria-hidden="true" />
                <span>{stale ? "Download last PDF" : "Download PDF"}</span>
                <small>
                  {pdfBytes
                    ? `${sanitizeFilename(documentName)}.pdf`
                    : "Compile first to create it"}
                </small>
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => runFileMenuAction(exportProject)}
              >
                <Export aria-hidden="true" />
                <span>Export project</span>
                <small>{`${sanitizeFilename(documentName)}.zip`}</small>
              </button>
              <div className="file-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() =>
                  runFileMenuAction(() => importInputRef.current?.click())
                }
              >
                <FolderOpen aria-hidden="true" />
                <span>Import project</span>
                <small>.zip or .tex file</small>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mobile-tabs" role="tablist" aria-label="Workspace panes">
        <button
          type="button"
          role="tab"
          aria-selected={activePane === "source"}
          onClick={() => setActivePane("source")}
        >
          Source
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activePane === "preview"}
          onClick={() => setActivePane("preview")}
        >
          Preview
          {stale && <span className="tab-state">Out of date</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activePane === "assistant"}
          onClick={() => setActivePane("assistant")}
        >
          Assistant
        </button>
      </div>

      <main
        className={`workspace active-${activePane}${showAssistant ? " with-assistant" : ""}`}
        style={
          { "--source-width": `${split}%`, "--split-ratio": split / 100 } as React.CSSProperties
        }
      >
        <section
          className="pane source-pane"
          aria-labelledby="source-heading"
          onKeyDown={(event) => {
            if (
              !event.defaultPrevented &&
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === "f"
            ) {
              event.preventDefault();
              searchSource();
            }
          }}
        >
          <header className="pane-header">
            <div className="pane-heading-group">
              <FileText size={16} aria-hidden="true" />
              <h2 id="source-heading">Source</h2>
              <span className="logical-file">{project.activeFile}</span>
            </div>
            <div className="source-header-actions">
              {project.activeFile !== project.mainFile &&
                project.activeFile.toLowerCase().endsWith(".tex") &&
                activeEntry?.kind === "text" && (
                  <button
                    type="button"
                    className="set-main-button"
                    onClick={() => {
                      setProject((current) => ({
                        ...current,
                        mainFile: current.activeFile,
                      }));
                      setProjectRevision((value) => value + 1);
                    }}
                  >
                    Set as main
                  </button>
                )}
              {diagnostics.length > 0 && (
                <button
                  type="button"
                  className="diagnostic-count"
                  onClick={() => setDiagnosticsOpen(true)}
                >
                  <XCircle weight="fill" />
                  {diagnostics.length}
                </button>
              )}
              <button
                className="icon-button"
                type="button"
                onClick={() => setExplorerHidden((hidden) => !hidden)}
                aria-label={explorerHidden ? "Show project files" : "Hide project files"}
                aria-controls="project-explorer"
                aria-expanded={!explorerHidden}
                title={explorerHidden ? "Show project files" : "Hide project files"}
              >
                <SidebarSimple />
              </button>
              <button
                className="icon-button"
                type="button"
                disabled={activeEntry?.kind !== "text"}
                onClick={searchSource}
                aria-label="Search in file"
                title="Search in file (⌘F)"
              >
                <MagnifyingGlass />
              </button>
            </div>
          </header>
          <div
            className={`source-content${explorerHidden ? " explorer-hidden" : ""}`}
            style={{ "--explorer-width": `${explorerWidth}px` } as React.CSSProperties}
          >
            <aside
              id="project-explorer"
              className="project-explorer"
              aria-label="Project files"
              hidden={explorerHidden}
            >
              <div className="explorer-heading">
                <span>Project</span>
                <span>{projectPaths.length}</span>
              </div>
              <ul>
                {projectPaths.map((path) => {
                  const file = project.files[path];
                  return (
                    <li key={path}>
                      <button
                        type="button"
                        className={path === project.activeFile ? "active" : ""}
                        onClick={() =>
                          setProject((current) => ({
                            ...current,
                            activeFile: path,
                          }))
                        }
                        title={path}
                      >
                        {file.kind === "text" ? (
                          <FileText aria-hidden="true" />
                        ) : (
                          <File aria-hidden="true" />
                        )}
                        <span>{path}</span>
                        {path === project.mainFile && <em>Main</em>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            {!explorerHidden && (
              <div
                className="explorer-resizer"
                role="separator"
                aria-label="Resize project files"
                aria-controls="project-explorer"
                aria-orientation="vertical"
                aria-valuemin={EXPLORER_MIN_WIDTH}
                aria-valuemax={EXPLORER_MAX_WIDTH}
                aria-valuenow={explorerWidth}
                tabIndex={0}
                onPointerDown={startExplorerResize}
                onPointerMove={dragExplorer}
                onPointerUp={stopExplorerResize}
                onPointerCancel={stopExplorerResize}
                onLostPointerCapture={stopExplorerResize}
                onDoubleClick={() => setExplorerWidth(EXPLORER_DEFAULT_WIDTH)}
                onKeyDown={resizeExplorerWithKeyboard}
              />
            )}

            <div id="source-editor" className="editor-wrap">
              {activeEntry?.kind === "text" ? (
                <CodeMirror
                  key={project.activeFile}
                  value={source}
                  height="100%"
                  theme={EDITOR_THEME}
                  extensions={editorExtensions}
                  onChange={updateActiveSource}
                  onUpdate={handleEditorUpdate}
                  onCreateEditor={(view) => {
                    editorRef.current = view;
                  }}
                  basicSetup={EDITOR_SETUP}
                />
              ) : (
                <div className="binary-file-state">
                  <File size={32} weight="thin" aria-hidden="true" />
                  <strong>Binary file</strong>
                  <span>{project.activeFile}</span>
                  <p>This file is preserved for compilation and project export.</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <div
          className="splitter"
          role="separator"
          aria-label="Resize source and preview panes"
          aria-orientation="vertical"
          aria-valuemin={32}
          aria-valuemax={68}
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          onPointerDown={startDragging}
          onPointerMove={dragSplitter}
          onPointerUp={stopDragging}
          onDoubleClick={() => setSplit(52)}
          onKeyDown={adjustSplitWithKeyboard}
        >
          <ArrowsLeftRight aria-hidden="true" />
        </div>

        <PdfPreview
          bytes={pdfBytes}
          stale={stale}
          busy={busy}
          onDownload={downloadPdf}
          onLocateSource={syncTexData ? locateSource : undefined}
          onPrepareEdit={syncTexData ? prepareTextEdit : undefined}
        />

        <AssistantPanel
          host={assistantHost}
          hidden={!showAssistant}
          onClose={closeAssistant}
          accountSettings={accountSettings}
          onSaveAccountSettings={
            googleSession
              ? (settings) => saveDriveSettings(googleSession, settings)
              : undefined
          }
        />
      </main>

      <section
        className={`diagnostics ${diagnosticsOpen ? "open" : ""}`}
        aria-labelledby="diagnostics-heading"
      >
        <button
          id="diagnostics-summary"
          className="diagnostics-summary"
          type="button"
          onClick={() => setDiagnosticsOpen((value) => !value)}
          aria-expanded={diagnosticsOpen}
        >
          <span>
            {diagnostics.length > 0 ? (
              <XCircle weight="fill" aria-hidden="true" />
            ) : (
              <CheckCircle weight="fill" aria-hidden="true" />
            )}
            <strong id="diagnostics-heading">
              {diagnostics.length
                ? `${diagnostics.length} ${
                    diagnostics.length === 1 ? "error" : "errors"
                  }`
                : "No compile issues"}
            </strong>
          </span>
          <span className="diagnostics-meta">
            {logs.length > 0 && `${logs.length} log lines`}
            <CaretDown aria-hidden="true" />
          </span>
        </button>

        {diagnosticsOpen && (
          <div className="diagnostics-body">
            {diagnostics.length > 0 ? (
              <ul className="diagnostic-list">
                {diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.message}-${index}`}>
                    <button
                      type="button"
                      onClick={() => jumpToDiagnostic(diagnostic)}
                      disabled={!diagnostic.line}
                    >
                      <XCircle weight="fill" aria-hidden="true" />
                      <span>
                        <strong>Error</strong>
                        <span>{diagnostic.message}</span>
                      </span>
                      <code>
                        {diagnostic.line
                          ? `${diagnostic.file ?? project.mainFile}:${diagnostic.line}`
                          : diagnostic.file ?? project.mainFile}
                      </code>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="clean-diagnostics">
                Compile the document to refresh diagnostics.
              </p>
            )}

            {logs.length > 0 && (
              <div className="raw-log">
                <button
                  type="button"
                  onClick={() => setRawLogOpen((value) => !value)}
                  aria-expanded={rawLogOpen}
                >
                  <CaretRight className={rawLogOpen ? "rotated" : ""} />
                  Raw compiler log
                </button>
                {rawLogOpen && <pre>{logs.join("\n")}</pre>}
              </div>
            )}
          </div>
        )}
      </section>

      <footer className={`status-bar phase-${compileStatus.phase}`}>
        <div className="status-primary" role="status" aria-live="polite">
          {getStatusIcon(compileStatus.phase)}
          <span>{(busy && progress) || compileStatus.label}</span>
        </div>
        <div className="status-right">
          {byteSize > 10 * 1024 * 1024 && (
            <span className="byte-warning">
              {(byteSize / 1024 / 1024).toFixed(1)} MiB / 50 MiB
            </span>
          )}
          <span>Ln {cursor.line}, Col {cursor.column}</span>
          <span>Spaces: 2</span>
          <span>UTF-8</span>
          <span>pdfLaTeX</span>
        </div>
      </footer>
    </div>
  );
}
