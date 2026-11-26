'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface BriefSubmitResult {
  ok: boolean;
  error?: string;
  started?: boolean;
}

export interface WhiteboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The brief currently on the board. */
  brief?: string;
  /** The planner's plan as it stands, read-only here. */
  plan?: string;
  planStatus?: 'drafting' | 'final';
  planBy?: string;
  /** A run is in progress: the brief is locked until it ends. */
  runActive?: boolean;
  /** Save the brief; with `start`, hand it to the planner and begin a run. */
  onSubmitBrief?: (text: string, start: boolean) => Promise<BriefSubmitResult>;
}

export function WhiteboardModal({
  isOpen,
  onClose,
  brief = '',
  plan = '',
  planStatus,
  planBy,
  runActive = false,
  onSubmitBrief,
}: WhiteboardModalProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? brief;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const submit = async (start: boolean) => {
    if (!onSubmitBrief || !text.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await onSubmitBrief(text.trim(), start);
      if (!result.ok) {
        setMessage({ ok: false, text: result.error || 'The board did not accept that.' });
        return;
      }
      setDraft(null);
      if (start) {
        onClose();
      } else {
        setMessage({ ok: true, text: 'Brief is on the board.' });
      }
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message || 'Could not reach the studio server.' });
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  const locked = runActive || busy;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/80 backdrop-blur-md"
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 16 }}
          role="dialog"
          aria-label="Studio whiteboard"
          className="relative flex h-[85vh] max-h-[720px] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[rgba(244,236,226,0.15)] bg-[#17130f] shadow-[0_25px_60px_rgba(0,0,0,0.9)]"
        >
          <div className="flex items-center justify-between border-b border-[rgba(244,236,226,0.08)] bg-[#1e1915]/90 px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="h-3 w-3 rounded-full bg-[#3b82f6]" />
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wider text-[#f4ece2]">Studio Whiteboard</h2>
                <p className="text-[11px] text-[#8a7a6b]">
                  Write what you want built. The planner reads it, then drafts the plan on the board.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[rgba(244,236,226,0.08)] text-[#8a7a6b] transition-colors hover:bg-[#262019] hover:text-[#f4ece2]"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-6 md:grid-cols-2">
            <section className="flex min-h-0 flex-col">
              <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-wider text-[#c9b8a6]">Your brief</h3>
              <textarea
                value={text}
                onChange={(e) => setDraft(e.target.value)}
                readOnly={runActive}
                placeholder={'A kanban board with drag and drop.\nThree columns: To Do, Doing, Done.\nPlain HTML and JS, no build step.'}
                className="min-h-[160px] flex-1 resize-none rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#0d0a08] p-4 font-mono text-xs leading-relaxed text-[#f4ece2] placeholder-[#8a7a6b]/50 focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6] read-only:opacity-70"
                spellCheck
              />
              {runActive && (
                <p className="mt-2 text-[11px] text-[#d9a441]">A run is in progress — the brief is locked until it ends.</p>
              )}
            </section>

            <section className="flex min-h-0 flex-col">
              <h3 className="mb-2 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-[#93c5fd]">
                Plan{planBy ? ` · ${planBy}` : ''}
                {planStatus === 'drafting' && <span className="rounded bg-[#3b82f6]/20 px-1.5 py-0.5 text-[9px] text-[#93c5fd]">writing…</span>}
                {planStatus === 'final' && <span className="rounded bg-[#8fae60]/20 px-1.5 py-0.5 text-[9px] text-[#8fae60]">final</span>}
              </h3>
              <div className="min-h-[160px] flex-1 overflow-y-auto rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#0d0a08] p-4">
                {plan.trim() ? (
                  <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-[#f4ece2]/90">{plan}</pre>
                ) : (
                  <p className="text-xs italic text-[#8a7a6b]">
                    No plan yet. Submit your brief and the planner drafts it here while it thinks.
                  </p>
                )}
              </div>
            </section>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[rgba(244,236,226,0.08)] bg-[#1e1915]/90 px-6 py-3.5">
            <span role="status" className={`font-mono text-xs ${message?.ok ? 'text-[#8fae60]' : 'text-[#cf6c5a]'}`}>
              {message?.text}
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-[rgba(244,236,226,0.1)] px-4 py-2 font-mono text-xs font-bold text-[#8a7a6b] transition-colors hover:bg-[#262019] hover:text-[#f4ece2]"
              >
                Close
              </button>
              <button
                type="button"
                disabled={locked || !text.trim() || !onSubmitBrief}
                onClick={() => submit(false)}
                className="rounded-xl border border-[#3b82f6]/40 bg-[#3b82f6]/20 px-4 py-2 font-mono text-xs font-bold text-[#60a5fa] transition-all hover:bg-[#3b82f6]/30 disabled:opacity-50"
              >
                Save brief
              </button>
              <button
                type="button"
                disabled={locked || !text.trim() || !onSubmitBrief}
                onClick={() => submit(true)}
                className="rounded-xl bg-[#3b82f6] px-5 py-2 font-mono text-xs font-bold text-white shadow-lg transition-all hover:bg-[#2563eb] disabled:opacity-50"
              >
                {busy ? 'Submitting…' : 'Submit to planner'}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
