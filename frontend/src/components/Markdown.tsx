import { Fragment, memo, useMemo, type ReactNode } from "react";

import { CopyButton } from "./CopyButton";

/**
 * A deliberately small Markdown subset renderer: headings, lists, fenced code,
 * blockquotes, bold, italic, inline code and links.
 *
 * Written by hand rather than pulled from a library to keep the dependency
 * surface at zero. It returns React nodes and never sets innerHTML, so model
 * output cannot inject markup.
 */

type Block =
  | { kind: "code"; language: string; content: string }
  | { kind: "heading"; level: number; content: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; content: string }
  | { kind: "paragraph"; content: string };

const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

/** Renders bold, italic, inline code and links inside a single line of text. */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(INLINE_PATTERN).filter((part) => part !== "");

  return parts.map((part, index) => {
    const key = `${index}-${part.slice(0, 8)}`;

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("__") && part.endsWith("__")) {
      return <strong key={key} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={key}
          className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-800"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (
      (part.startsWith("*") && part.endsWith("*")) ||
      (part.startsWith("_") && part.endsWith("_"))
    ) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = link[2];
      // Only allow safe schemes — never render javascript: as a link.
      const safe = /^(https?:\/\/|mailto:|\/)/i.test(href);

      return safe ? (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
        >
          {link[1]}
        </a>
      ) : (
        <Fragment key={key}>{link[1]}</Fragment>
      );
    }

    return <Fragment key={key}>{part}</Fragment>;
  });
}

/** Splits raw text into block-level chunks. */
function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code block
    const fence = /^```(\w+)?\s*$/.exec(line.trim());
    if (fence) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      index++;

      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        body.push(lines[index]);
        index++;
      }
      index++; // consume the closing fence

      blocks.push({ kind: "code", language, content: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      index++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        content: heading[2],
      });
      index++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^>\s?/, ""));
        index++;
      }
      blocks.push({ kind: "quote", content: body.join(" ") });
      continue;
    }

    const isUnordered = /^\s*[-*•]\s+/.test(line);
    const isOrdered = /^\s*\d+[.)]\s+/.test(line);

    if (isUnordered || isOrdered) {
      const items: string[] = [];
      const matcher = isOrdered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/;

      while (index < lines.length && matcher.test(lines[index])) {
        items.push(lines[index].replace(matcher, ""));
        index++;
      }

      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const body: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !/^```/.test(lines[index].trim()) &&
      !/^(#{1,4})\s+/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !/^\s*[-*•]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index])
    ) {
      body.push(lines[index]);
      index++;
    }

    blocks.push({ kind: "paragraph", content: body.join(" ") });
  }

  return blocks;
}

const HEADING_CLASSES: Record<number, string> = {
  1: "text-lg font-semibold",
  2: "text-base font-semibold",
  3: "text-sm font-semibold",
  4: "text-sm font-semibold",
};

function MarkdownComponent({ content }: { content: string }) {
  // Answer text never changes once rendered, so the block parse is done once per
  // message rather than on every parent re-render.
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <div className="space-y-3 text-[0.95rem] leading-relaxed">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;

        switch (block.kind) {
          case "code":
            return (
              <div key={key} className="group/code relative">
                <pre className="overflow-x-auto rounded-xl bg-slate-900 p-4 pr-12 text-[0.82rem] leading-relaxed text-slate-100">
                  <code>{block.content}</code>
                </pre>
                <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
                  <CopyButton
                    value={block.content}
                    label="Copy code"
                    className="bg-slate-800/80 text-slate-200 hover:bg-slate-700 hover:text-white"
                  />
                </div>
              </div>
            );

          case "heading":
            return (
              <p key={key} className={HEADING_CLASSES[block.level] ?? "font-semibold"}>
                {renderInline(block.content)}
              </p>
            );

          case "list":
            return block.ordered ? (
              <ol key={key} className="list-decimal space-y-1 pl-5 marker:text-slate-400">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="list-disc space-y-1 pl-5 marker:text-slate-400">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ul>
            );

          case "quote":
            return (
              <blockquote
                key={key}
                className="border-l-2 border-slate-300 pl-3 text-slate-600 italic"
              >
                {renderInline(block.content)}
              </blockquote>
            );

          default:
            return <p key={key}>{renderInline(block.content)}</p>;
        }
      })}
    </div>
  );
}

/** Memoised: parsing and node construction are the heaviest work in a message. */
export const Markdown = memo(MarkdownComponent);
export default Markdown;
