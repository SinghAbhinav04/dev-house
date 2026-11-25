'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface WhiteboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialPlan?: string;
  onSavePlan?: (newPlan: string) => void;
  onStartPipelineWithPlan?: (newPlan: string) => void;
}

export function WhiteboardModal({
  isOpen,
  onClose,
  initialPlan = '',
  onSavePlan,
  onStartPipelineWithPlan,
}: WhiteboardModalProps) {
  const [userEditedText, setUserEditedText] = useState<string | null>(null);
  const planText = userEditedText ?? initialPlan;
  const [activeTab, setActiveTab] = useState<'edit' | 'preview'>('edit');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleSave = async (andRunPipeline = false) => {
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      // 1. Post to API to save plan to plan.md
      await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: planText }),
      });

      // 2. Notify parent studio system to update in-world whiteboard texture and state
      onSavePlan?.(planText);
      setSaveSuccess(true);

      // 3. Optionally launch pipeline
      if (andRunPipeline) {
        onStartPipelineWithPlan?.(planText);
        onClose();
      } else {
        setTimeout(() => setSaveSuccess(false), 2400);
      }
    } catch (err) {
      console.error('Failed to save plan:', err);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/80 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 16 }}
          className="relative flex h-[85vh] max-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[rgba(244,236,226,0.15)] bg-[#17130f] shadow-[0_25px_60px_rgba(0,0,0,0.9)]"
        >
          {/* Header Bar */}
          <div className="flex items-center justify-between border-b border-[rgba(244,236,226,0.08)] bg-[#1e1915]/90 px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="h-3 w-3 rounded-full bg-[#3b82f6]" />
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wider text-[#f4ece2]">
                  Mission Architecture Whiteboard
                </h2>
                <p className="text-[11px] text-[#8a7a6b]">
                  Write or edit the engineering plan executed by the autonomous agent team
                </p>
              </div>
            </div>

            {/* View / Edit Mode Switcher */}
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-[rgba(244,236,226,0.08)] bg-[#262019] p-0.5">
                <button
                  type="button"
                  onClick={() => setActiveTab('edit')}
                  className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-all ${
                    activeTab === 'edit'
                      ? 'bg-[#3b82f6] text-[#ffffff] shadow-sm'
                      : 'text-[#8a7a6b] hover:text-[#f4ece2]'
                  }`}
                >
                  Editor
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('preview')}
                  className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-all ${
                    activeTab === 'preview'
                      ? 'bg-[#3b82f6] text-[#ffffff] shadow-sm'
                      : 'text-[#8a7a6b] hover:text-[#f4ece2]'
                  }`}
                >
                  Preview
                </button>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[rgba(244,236,226,0.08)] text-[#8a7a6b] hover:bg-[#262019] hover:text-[#f4ece2] transition-colors"
                title="Close (Esc)"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Body Content */}
          <div className="relative flex-1 overflow-hidden p-6">
            {activeTab === 'edit' ? (
              <textarea
                value={planText}
                onChange={(e) => setUserEditedText(e.target.value)}
                placeholder="# Mission Architecture Plan&#10;&#10;## Objectives&#10;- [x] Step 1: Initialize Dev House Studio&#10;- [ ] Step 2: Implement autonomous agent pipeline&#10;- [ ] Step 3: Run Vitest contract verification suite&#10;&#10;## Technical Architecture&#10;Describe system components, interfaces, and permissions here..."
                className="h-full w-full resize-none rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#0d0a08] p-4 font-mono text-xs leading-relaxed text-[#f4ece2] placeholder-[#8a7a6b]/50 focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6]"
                spellCheck={false}
              />
            ) : (
              <div className="h-full w-full overflow-y-auto rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#0d0a08] p-5 font-mono text-xs leading-relaxed text-[#f4ece2]">
                {planText.trim().length === 0 ? (
                  <p className="text-[#8a7a6b] italic">No plan written yet. Switch to Editor to create your architecture plan.</p>
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-[#f4ece2]/90">
                    {planText}
                  </pre>
                )}
              </div>
            )}
          </div>

          {/* Footer Bar & Actions */}
          <div className="flex items-center justify-between border-t border-[rgba(244,236,226,0.08)] bg-[#1e1915]/90 px-6 py-3.5">
            <div className="flex items-center gap-2">
              {saveSuccess && (
                <span className="font-mono text-xs font-semibold text-[#8fae60]">
                  Plan saved to whiteboard & pipeline
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-[rgba(244,236,226,0.1)] px-4 py-2 font-mono text-xs font-bold text-[#8a7a6b] hover:bg-[#262019] hover:text-[#f4ece2] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => handleSave(false)}
                className="rounded-xl border border-[#3b82f6]/40 bg-[#3b82f6]/20 px-4 py-2 font-mono text-xs font-bold text-[#60a5fa] hover:bg-[#3b82f6]/30 transition-all disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save to Whiteboard'}
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => handleSave(true)}
                className="rounded-xl bg-[#3b82f6] px-5 py-2 font-mono text-xs font-bold text-[#ffffff] shadow-lg hover:bg-[#2563eb] transition-all disabled:opacity-50"
              >
                Save & Run Pipeline
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
