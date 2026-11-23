import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  Crop,
  Trash2,
  Sparkles,
  Cpu,
  AlertTriangle,
  CheckCheck,
} from 'lucide-react';
import { updateQuestionMeta, deleteQuestion } from '../../db/db';

function PreviewImg({ blob, label }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objUrl = URL.createObjectURL(blob);
    setUrl(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [blob]);

  if (!url) {
    return (
      <div className="flex h-36 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 text-center text-xs text-slate-400">
        No {label} captured
      </div>
    );
  }

  return (
    <div className="flex max-h-56 items-center justify-center overflow-auto rounded-lg border border-slate-200 bg-white p-2">
      <img src={url} alt={label} className="max-h-52 w-auto object-contain" />
    </div>
  );
}

export default function AutoExtractReviewModal({
  isOpen,
  onClose,
  batchSummary,
  onFixCrop,
}) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    setItems(batchSummary?.items || []);
  }, [batchSummary]);

  if (!isOpen || !batchSummary) return null;

  const handleApproveOne = async (id) => {
    await updateQuestionMeta(id, { status: 'ready' });
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, approved: true } : item))
    );
  };

  const handleApproveAll = async () => {
    const readyIds = items
      .filter((it) => !it.approved && it.questionImageBlob)
      .map((it) => it.id);

    if (readyIds.length > 0) {
      await Promise.all(
        readyIds.map((id) => updateQuestionMeta(id, { status: 'ready' }))
      );
    }
    onClose();
  };

  const handleDiscard = async (id) => {
    await deleteQuestion(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const unapprovedWithQuestionCount = items.filter(
    (it) => !it.approved && it.questionImageBlob
  ).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-bold text-slate-900">
                Verify Auto-Extracted Questions
              </h2>
              {batchSummary.questionEngine === 'vision-llm' ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
                  <Sparkles className="h-3 w-3" /> Vision AI
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                  <Cpu className="h-3 w-3" /> Local Heuristic Fallback
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              Double-check each screenshot pair below, fix any clipped boxes, or
              approve all to add them to your Study deck.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {unapprovedWithQuestionCount > 0 && (
              <button
                type="button"
                onClick={handleApproveAll}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700"
              >
                <CheckCheck className="h-4 w-4" />
                Approve All ({unapprovedWithQuestionCount})
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Done
            </button>
          </div>
        </div>

        {/* Fallback Notice Banner */}
        {batchSummary.fallbackReason && (
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-xs text-amber-900">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              <strong>Offline / Fallback mode active:</strong>{' '}
              {batchSummary.fallbackReason}. Used local text-coordinate
              cropping—please verify edges below.
            </span>
          </div>
        )}

        {/* Scrollable Verification Cards */}
        <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-6">
          {items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
              No items left in this batch.
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className={`rounded-xl border bg-white p-4 shadow-2xs transition ${
                  item.approved
                    ? 'border-emerald-300 bg-emerald-50/20'
                    : 'border-slate-200'
                }`}
              >
                {/* Card Top Bar */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-900">
                      {item.referenceLabel}
                    </span>
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      {item.courseTag}
                    </span>
                    {item.approved && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">
                        <CheckCircle2 className="h-3 w-3" /> Added to Deck
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {!item.approved && (
                      <button
                        type="button"
                        onClick={() => handleApproveOne(item.id)}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Approve
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDiscard(item.id)}
                      title="Discard question"
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Side-by-Side Question & Solution Comparison */}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {/* Question Column */}
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                        Question{' '}
                        {item.questionPage ? `(p. ${item.questionPage})` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          onFixCrop({
                            questionId: item.id,
                            slot: 'question',
                            pageNumber: item.questionPage || 1,
                            normRect: item.questionNormRect || null,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100"
                      >
                        <Crop className="h-3 w-3" />
                        {item.questionImageBlob
                          ? 'Adjust Q Crop'
                          : 'Snip Manually'}
                      </button>
                    </div>
                    <PreviewImg
                      blob={item.questionImageBlob}
                      label="question"
                    />
                  </div>

                  {/* Solution Column */}
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                        Solution{' '}
                        {item.solutionPage ? `(p. ${item.solutionPage})` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          onFixCrop({
                            questionId: item.id,
                            slot: 'solution',
                            pageNumber: item.solutionPage || 1,
                            normRect: item.solutionNormRect || null,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                      >
                        <Crop className="h-3 w-3" />
                        {item.solutionImageBlob
                          ? 'Adjust Sol Crop'
                          : 'Snip Manually'}
                      </button>
                    </div>
                    <PreviewImg
                      blob={item.solutionImageBlob}
                      label="solution"
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}