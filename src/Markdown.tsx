import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import ReactMarkdown, { type Components, type ExtraProps, type UrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

// The closing $ of $…$, following Pandoc: it comes right after a character, is
// not followed by a digit, and is in the same paragraph as the opening $.
function closingDollar(text: string, from: number) {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text.startsWith("\n\n", index)) {
      return -1;
    } else if (text[index] === "$" && /\S/.test(text[index - 1]) && !/\d/.test(text[index + 1] ?? "")) {
      return index;
    }
  }
  return -1;
}

// A $ that cannot open or close math, as in "costs $5 and $10" or "type $ to
// start math", is escaped so it stays a dollar sign.
function escapeLoneDollars(text: string) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\") {
      out += text.slice(index, index + 2);
      index += 2;
    } else if (text.startsWith("$$", index)) {
      const end = text.indexOf("$$", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(index, stop);
      index = stop;
    } else if (text[index] === "$") {
      const close = /\S/.test(text[index + 1] ?? "") ? closingDollar(text, index + 1) : -1;
      out += close < 0 ? "\\$" : text.slice(index, close + 1);
      index = close < 0 ? index + 1 : close + 1;
    } else {
      out += text[index];
      index += 1;
    }
  }
  return out;
}

// Models write math as \( \) and \[ \] as often as with dollar signs, but
// remark-math reads only $ and $$. Code spans and code blocks are left alone.
function dollarMath(text: string) {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : escapeLoneDollars(
            part
              .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
              .replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => `$${math.trim()}$`),
          ),
    )
    .join("");
}

// Model output decides these addresses, so only web and mail links are kept.
const safeUrl: UrlTransform = (url) => (/^(https?:|mailto:)/i.test(url.trim()) ? url : "");

function CodeBlock({ node: _node, children, ...props }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const ref = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = () => {
    navigator.clipboard
      .writeText((ref.current?.textContent ?? "").replace(/\n$/, ""))
      .then(() => setState("copied"), () => setState("failed"));
  };
  const label = state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy";
  return (
    <div className="assistant-code">
      <pre ref={ref} {...props}>
        {children}
      </pre>
      <button type="button" className="assistant-code-copy" onClick={copy} aria-label={label} title={label}>
        {state === "copied" ? <Check weight="bold" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Images are linked, not loaded: a reply should not make the browser contact other servers.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || "Image"}
      </a>
    ) : (
      <span>{alt}</span>
    ),
  table: ({ children }) => (
    <div className="assistant-table">
      <table>{children}</table>
    </div>
  ),
};

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]> = [
  [rehypeKatex, { errorColor: "inherit", strict: "ignore" }],
];

const copyableComponents: Components = { ...components, pre: CodeBlock };

// `copy` adds a copy button to code blocks; the live thinking preview leaves it out.
function Markdown({ text, className, copy = true }: { text: string; className: string; copy?: boolean }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={copy ? copyableComponents : components}
        urlTransform={safeUrl}
      >
        {dollarMath(text)}
      </ReactMarkdown>
    </div>
  );
}

// Every message re-renders while a reply streams; only the one that changed is parsed again.
export default memo(Markdown);
