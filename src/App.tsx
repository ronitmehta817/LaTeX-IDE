import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  ArrowsLeftRight,
  ArrowsOutSimple,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  CheckCircle,
  DotsThreeVertical,
  DownloadSimple,
  Export,
  File,
  FilePdf,
  FileText,
  FolderOpen,
  MagnifyingGlass,
  Minus,
  Play,
  Plus,
  SidebarSimple,
  SpinnerGap,
  Warning,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { strToU8, unzipSync, zipSync } from "fflate";
import { SiglumCompiler, resolveRuntime } from "@siglum/engine";
import type { CompileResult } from "@siglum/engine/compiler";
import workerUrl from "@siglum/engine/worker?url";
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
      "&": { color: "#dcdee0", backgroundColor: "#2e3033" },
      ".cm-content": { caretColor: "#ffa43c" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#ffa43c" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "rgb(255 164 60 / 24%)" },
      ".cm-activeLine": { backgroundColor: "rgb(255 255 255 / 4%)" },
      ".cm-gutters": {
        backgroundColor: "#2e3033",
        color: "#a2a5aa",
        borderRight: "1px solid rgb(255 255 255 / 9%)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "rgb(255 255 255 / 4%)",
        color: "#dcdee0",
      },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: "transparent",
        outline: "1px solid rgb(255 164 60 / 70%)",
      },
      ".cm-searchMatch": {
        backgroundColor: "rgb(242 201 76 / 22%)",
        outline: "1px solid rgb(242 201 76 / 50%)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "rgb(255 164 60 / 40%)",
      },
      ".cm-selectionMatch": { backgroundColor: "rgb(255 255 255 / 8%)" },
      ".cm-foldPlaceholder": {
        border: "none",
        backgroundColor: "rgb(255 255 255 / 10%)",
        color: "#b8bbbf",
      },
      ".cm-tooltip": {
        border: "none",
        backgroundColor: "#35373a",
        boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 16%)",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "rgb(255 164 60 / 22%)",
        color: "#fff",
      },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.tagName, color: "#ffa43c" },
      { tag: [tags.atom, tags.number, tags.string], color: "#f2c94c" },
      { tag: tags.keyword, color: "#ff8257" },
      { tag: tags.bracket, color: "#a2a5aa" },
      { tag: tags.comment, color: "#a2a5aa", fontStyle: "italic" },
      { tag: tags.invalid, color: "#ff9090" },
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

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;

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
    };
  }, [onError, pageNumber, pdfDocument, scale]);

  return (
    <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber} of ${pageCount}`} />
  );
}

type PdfPreviewProps = {
  bytes: Uint8Array<ArrayBuffer> | null;
  stale: boolean;
  busy: boolean;
  onDownload: () => void;
  // x and y are PDF points measured from the top-left corner of the page.
  onLocateSource?: (page: number, x: number, y: number) => void;
};

function PdfPreview({
  bytes,
  stale,
  busy,
  onDownload,
  onLocateSource,
}: PdfPreviewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
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
                style={{
                  width: Math.floor(size.width * scale),
                  height: Math.floor(size.height * scale),
                }}
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
  const [activePane, setActivePane] = useState<"source" | "preview">("source");
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
    const archiveEntries = Object.fromEntries(
      Object.entries(project.files).map(([path, file]) => [
        path,
        file.kind === "text" ? strToU8(file.content) : file.content,
      ]),
    );
    const archive = zipSync(archiveEntries, { level: 6 });
    const archiveBytes = new Uint8Array(archive);
    downloadBlob(
      new Blob([archiveBytes.buffer], { type: "application/zip" }),
      `${sanitizeFilename(documentName)}.zip`,
    );
  }, [documentName, project.files]);

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
          const unpacked = unzipSync(new Uint8Array(await file.arrayBuffer()));
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

          importedFiles = {};
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
            const bytes = new Uint8Array(unpacked[originalPath]);
            importedFiles[path] = isTextPath(path)
              ? { kind: "text", content: new TextDecoder().decode(bytes) }
              : { kind: "binary", content: bytes };
          }
        }

        if (projectByteSize(importedFiles) > MAX_PROJECT_BYTES) {
          throw new Error("The unpacked project is larger than 50 MiB.");
        }

        const paths = Object.keys(importedFiles);
        const mainFile =
          paths.find((path) => path.toLowerCase() === "main.tex") ??
          paths.find((path) => path.toLowerCase().endsWith("/main.tex")) ??
          paths.find((path) => path.toLowerCase().endsWith(".tex"));
        if (!mainFile) {
          throw new Error("The project must contain at least one .tex file.");
        }

        setProject({ files: importedFiles, activeFile: mainFile, mainFile });
        setDocumentName(
          sanitizeFilename(file.name.replace(/\.(zip|tex)$/i, "")),
        );
        setProjectRevision((value) => value + 1);
        setCompiledRevision(-1);
        setPdfBytes(null);
        setSyncTexData(null);
        setDiagnostics([]);
        setLogs([]);
        setCompileStatus({ phase: "idle", label: "Project imported" });
      } catch (error) {
        setDiagnostics([
          {
            severity: "error",
            message:
              error instanceof Error
                ? error.message
                : "The project could not be imported.",
          },
        ]);
        setDiagnosticsOpen(true);
        setCompileStatus({ phase: "error", label: "Import failed" });
      }
    },
    [],
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

  const compile = useCallback(async () => {
    if (busy) {
      cancelCompile();
      return;
    }

    const mainEntry = project.files[project.mainFile];
    if (!mainEntry || mainEntry.kind !== "text") {
      setDiagnostics([
        {
          severity: "error",
          message: "Choose a text .tex file as the project main file.",
        },
      ]);
      setDiagnosticsOpen(true);
      return;
    }

    const mainByteSize = new TextEncoder().encode(mainEntry.content).byteLength;
    if (mainByteSize > 1024 * 1024 || byteSize > MAX_PROJECT_BYTES) {
      setDiagnostics([
        {
          severity: "error",
          message:
            mainByteSize > 1024 * 1024
              ? "The main source is larger than the 1 MiB compilation limit."
              : "The project is larger than the 50 MiB compilation limit.",
        },
      ]);
      setDiagnosticsOpen(true);
      return;
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
      if (requestRef.current !== requestId) return;

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
      if (requestRef.current !== requestId) return;

      const duration = performance.now() - startedAt;
      if (result.success) {
        setPdfBytes(result.pdf.slice());
        setSyncTexData(result.syncTexData ?? null);
        setCompiledRevision(revisionSnapshot);
        setLogs(result.log ? result.log.split("\n").slice(-2000) : []);
        setCompileStatus({
          phase: "success",
          label: `Compiled in ${(duration / 1000).toFixed(1)} s`,
          duration,
        });
        setProgress("");
      } else {
        const rawLog = result.log ?? "";
        setLogs(rawLog.split("\n").slice(-2000));
        setDiagnostics([
          parseDiagnostic(result.error, rawLog, mainFileSnapshot),
        ]);
        setDiagnosticsOpen(true);
        setRawLogOpen(true);
        setCompileStatus({
          phase: "error",
          label: "Compile failed",
          duration,
        });
        setProgress("");
      }
    } catch (error) {
      if (requestRef.current !== requestId) return;
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

  const locateSource = (page: number, x: number, y: number) => {
    if (!syncTexData) return;
    if (syncTexRef.current?.data !== syncTexData) {
      syncTexRef.current = { data: syncTexData, index: parseSyncTex(syncTexData) };
    }
    const target = findSyncTexSource(
      syncTexRef.current.index,
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
    const next = ((event.clientX - rect.left) / rect.width) * 100;
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

  return (
    <div className="app-shell">
      <a className="skip-link" href="#source-editor">
        Skip to source
      </a>
      <a className="skip-link" href="#preview-heading">
        Skip to preview
      </a>

      <header className="title-bar">
        <div className="traffic-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="window-title">
          {sanitizeFilename(documentName)} - LaTeX Editor
        </div>
        <div className="title-spacer" />
      </header>

      <div className="command-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            T<span>e</span>X
          </span>
          <span>
            LaTeX <span className="accent">Editor</span>
          </span>
        </div>

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

        <span className={`save-state ${saveState}`} aria-live="polite">
          {saveState === "saving"
            ? "Saving"
            : saveState === "saved"
              ? hasBinaryFiles
                ? "Text saved locally"
                : "Saved locally"
              : "Not saved"}
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
      </div>

      <main
        className={`workspace active-${activePane}`}
        style={{ "--source-width": `${split}%` } as React.CSSProperties}
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
