'use client';

import { useEffect, useId, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';

import { MarkdownText } from '@/components/shared/MarkdownText';

/**
 * The plan, read rather than scrolled past.
 *
 * A plan is the one artifact everyone on the run works against, and it used to
 * arrive two ways, both bad: as a wall of prose in the chat feed, where it
 * pushed everything else off the screen and could not be returned to, and as a
 * raw <pre> in a modal, where a hundred lines of markdown syntax sat between
 * the reader and the plan.
 *
 * So it renders. Headings are headings, tables are tables, and a ```mermaid
 * fence becomes the diagram it describes — which is the whole point of asking a
 * planner for one.
 */

/** Rendered lazily and per block, because mermaid is large and usually unused. */
function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          // The app is dark by default and a diagram in default light theme
          // reads as a bright hole in the page.
          theme: 'dark',
          securityLevel: 'strict',
          fontFamily: 'inherit',
        });
        const { svg: rendered } = await mermaid.render(`plan-diagram-${id}`, chart);
        if (mounted.current) setSvg(rendered);
      } catch (err) {
        // A diagram that will not parse is the planner's problem, not a reason
        // to blank the plan — show the source so it can be read and fixed.
        if (mounted.current) setError((err as Error).message || 'That diagram could not be drawn.');
      }
    })();

    return () => {
      mounted.current = false;
    };
  }, [chart, id]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-line bg-surface-sunken p-3">
        <p className="text-[11px] uppercase tracking-wider text-signal-warn">Diagram would not render</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-ink-faint">{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="my-3 rounded-lg border border-line bg-surface-sunken p-6 text-center text-xs text-ink-faint">Drawing…</div>;
  }

  return (
    <div
      className="my-3 overflow-x-auto rounded-lg border border-line bg-surface-sunken p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function PlanMarkdown({ content }: { content: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink-soft">
      <ReactMarkdown
        remarkPlugins={[remarkBreaks]}
        components={{
          h1: ({ children }) => <h1 className="mt-5 text-lg font-semibold text-ink">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-5 border-b border-line pb-1 text-base font-semibold text-ink">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-4 text-sm font-semibold text-ink">{children}</h3>,
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          a: ({ children, href }) => (
            <a href={href} className="text-accent underline underline-offset-2" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-line pl-3 text-ink-faint">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-line px-2 py-1 text-left font-semibold text-ink">{children}</th>,
          td: ({ children }) => <td className="border border-line px-2 py-1 align-top">{children}</td>,
          code: ({ className, children }) => {
            const text = String(children ?? '').replace(/\n$/, '');

            // A mermaid fence is a diagram, not a code sample.
            if (/language-mermaid/.test(className ?? '')) return <Mermaid chart={text} />;

            // Inline code has no language class and no newlines.
            if (!className && !text.includes('\n')) {
              return <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.85em] text-ink">{text}</code>;
            }

            return (
              <pre className="my-3 overflow-x-auto rounded-lg border border-line bg-surface-sunken p-3">
                <code className="font-mono text-xs leading-relaxed text-ink-soft">{text}</code>
              </pre>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Long enough that inlining it costs you the rest of the feed.
 *
 * Chosen by what it does to the screen rather than by any property of the
 * text: past roughly this size a message stops being something you read in
 * passing and becomes something you scroll, and everything above it is gone.
 */
const LONG_FORM_LINES = 14;
const LONG_FORM_CHARS = 900;

export function isLongForm(event: { type?: string; text?: string }): boolean {
  if (event.type !== 'text' || !event.text) return false;
  return event.text.split('\n').length > LONG_FORM_LINES || event.text.length > LONG_FORM_CHARS;
}

/** The first heading or sentence, so the card says what it is holding. */
export function documentTitle(text: string): string {
  const heading = text.split('\n').find((line) => /^#{1,3}\s+\S/.test(line.trim()));
  if (heading) return heading.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim().slice(0, 80);

  const first = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'Long answer';
  const sentence = first.split(/(?<=[.:!?])\s/)[0];
  return (sentence.length > 80 ? `${sentence.slice(0, 77)}…` : sentence).replace(/[*_`#]/g, '');
}

/**
 * One feed message, wherever a feed is drawn.
 *
 * A component rather than a snippet because there are four feeds — the office
 * sidebar, the live feed, the expanded-member modal and the squad view — and
 * the first version of this fix only reached one of them. Anything that has to
 * be true in every feed belongs somewhere there is only one of.
 */
export function FeedMessage({
  event,
  author,
  onOpen,
}: {
  event: { type?: string; text?: string };
  author: string;
  onOpen: (text: string) => void;
}) {
  const text = event.text ?? '';

  if (!isLongForm(event)) return <MarkdownText>{text}</MarkdownText>;

  return (
    <ArtifactCard
      title={documentTitle(text)}
      subtitle={`${text.split('\n').length} lines · ${author}`}
      onOpen={() => onOpen(text)}
    />
  );
}

/**
 * A card standing in for an artifact in the feed.
 *
 * The point is that a plan does not belong inline. One line that says a plan
 * exists, and opens it, beats two hundred lines nobody can scroll back past.
 */
export function ArtifactCard({
  title,
  subtitle,
  onOpen,
}: {
  title: string;
  subtitle: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-left transition-colors hover:border-accent"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-base">📄</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{title}</span>
        <span className="block truncate text-[11px] text-ink-faint">{subtitle}</span>
      </span>
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-ink-faint transition-colors group-hover:text-accent">
        Open
      </span>
    </button>
  );
}
