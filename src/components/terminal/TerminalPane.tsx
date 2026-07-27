'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { eventStyle, eventToneClass, formatEventTime, hasExpandableDetail } from '@/lib/events';
import type { PipelineEvent } from '@/lib/use-pipeline';

export interface TerminalMember {
  id: string;
  name: string;
  color: string;
}

interface TerminalPaneProps {
  events: PipelineEvent[];
  members: TerminalMember[];
  /** Member ids currently mid-turn, shown as a live cursor. */
  activeIds?: string[];
  /** Called when the user submits at the prompt. */
  onSubmit?: (memberId: string, message: string) => Promise<unknown> | void;
  /** Member the prompt is addressed to by default. */
  defaultTarget?: string;
  /** False when the stream has dropped and we are on fallback polling. */
  connected?: boolean;
  className?: string;
  title?: string;
}

/**
 * A terminal-style view of a run.
 *
 * The existing panels render pre-digested one-liners as chat bubbles, which is
 * fine for reading along but hides what the members are actually doing. This
 * shows the raw sequence — tool calls, their results, and assistant text — as a
 * log you can follow, filter by member, and type into.
 */
export function TerminalPane({
  events,
  members,
  activeIds = [],
  onSubmit,
  defaultTarget,
  connected = true,
  className = '',
  title = 'session',
}: TerminalPaneProps) {
  const [filter, setFilter] = useState<string>('all');
  const [showTools, setShowTools] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [follow, setFollow] = useState(true);
  const [input, setInput] = useState('');
  const [target, setTarget] = useState(defaultTarget || members[0]?.id || '');
  const [sending, setSending] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const visible = useMemo(() => {
    return events.filter((event) => {
      if (filter !== 'all' && event.agent !== filter) return false;
      if (!showTools && (event.type === 'tool_call' || event.type === 'tool_result')) return false;
      return true;
    });
  }, [events, filter, showTools]);

  // Stick to the bottom only while the user is actually following; scrolling up
  // to read something should not be yanked back by the next event.
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  }, []);

  const submit = useCallback(async () => {
    const message = input.trim();
    if (!message || !onSubmit || !target || sending) return;

    setSending(true);
    setInput('');
    setFollow(true);
    try {
      await onSubmit(target, message);
    } finally {
      setSending(false);
    }
  }, [input, onSubmit, target, sending]);

  const toggleExpanded = useCallback((index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-sunken font-mono text-[12px] leading-[1.55] ${className}`}
    >
      {/* ── Title bar ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-raised px-3 py-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${connected ? 'animate-pulse bg-signal-ok' : 'bg-signal-warn'}`}
          title={connected ? 'Live stream connected' : 'Stream dropped — polling'}
        />
        <span className="text-ink-soft">{title}</span>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="all" />
          {members.map((member) => (
            <FilterChip
              key={member.id}
              active={filter === member.id}
              onClick={() => setFilter(member.id)}
              label={member.id}
              color={member.color}
              busy={activeIds.includes(member.id)}
            />
          ))}

          <button
            type="button"
            onClick={() => setShowTools((v) => !v)}
            className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
              showTools ? 'text-ink-faint hover:text-ink-soft' : 'text-accent'
            }`}
            title={showTools ? 'Hide tool calls' : 'Show tool calls'}
          >
            {showTools ? 'tools on' : 'tools off'}
          </button>
        </div>
      </div>

      {/* ── Log ───────────────────────────────────────────────────── */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {visible.length === 0 ? (
          <p className="py-6 text-center text-ink-faint">Nothing yet. The log fills as members work.</p>
        ) : (
          visible.map((event, index) => {
            const style = eventStyle(event.type);
            const member = memberById.get(event.agent);
            const isExpanded = expanded.has(index);
            const expandable = hasExpandableDetail(event);

            return (
              <div key={`${event.time}-${index}`} className="group flex gap-2 py-[1px]">
                <span className="shrink-0 select-none text-ink-faint">{formatEventTime(event.time)}</span>

                <span
                  className="w-[9ch] shrink-0 truncate select-none"
                  style={{ color: member?.color }}
                  title={member?.name || event.agent}
                >
                  {event.agent === 'system' ? 'system' : member?.id || event.agent}
                </span>

                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={expandable ? () => toggleExpanded(index) : undefined}
                    className={`w-full whitespace-pre-wrap break-words text-left ${eventToneClass(event.type)} ${
                      expandable ? 'cursor-pointer hover:underline decoration-dotted underline-offset-2' : 'cursor-default'
                    }`}
                  >
                    {style.tag && <span className="mr-1.5 select-none opacity-70">{style.tag}</span>}
                    {event.text}
                    {expandable && !isExpanded && <span className="ml-1 select-none opacity-50">▸</span>}
                  </button>

                  {expandable && isExpanded && (
                    <pre className="mt-1 mb-1 max-h-72 overflow-auto rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-ink-faint">
                      {event.detail}
                    </pre>
                  )}
                </div>
              </div>
            );
          })
        )}

        {activeIds.length > 0 && (
          <div className="flex gap-2 py-[1px] text-ink-faint">
            <span className="select-none">{formatEventTime(new Date().toISOString())}</span>
            <span className="w-[9ch] shrink-0 truncate select-none">
              {memberById.get(activeIds[0])?.id || activeIds[0]}
            </span>
            <span className="animate-pulse select-none">▊</span>
          </div>
        )}
      </div>

      {/* ── Prompt ────────────────────────────────────────────────── */}
      {onSubmit && members.length > 0 && (
        <div className="flex items-center gap-2 border-t border-line bg-surface-raised px-3 py-2">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="shrink-0 rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink-soft outline-none focus:border-accent"
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.id}
              </option>
            ))}
          </select>

          <span className="select-none text-accent">❯</span>

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={sending ? 'sending…' : `message ${memberById.get(target)?.name || target}`}
            disabled={sending}
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
          />

          {!follow && (
            <button
              type="button"
              onClick={() => {
                setFollow(true);
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
              className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-ink-faint hover:text-ink-soft"
            >
              follow
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  color,
  busy,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
        active ? 'bg-surface text-ink' : 'text-ink-faint hover:text-ink-soft'
      }`}
      style={active && color ? { color } : undefined}
    >
      {busy && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-signal-ok align-middle" />}
      {label}
    </button>
  );
}
