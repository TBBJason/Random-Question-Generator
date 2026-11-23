import React, { useState, useEffect } from 'react';
import { X, ClipboardPaste, Upload, Check } from 'lucide-react';
import { db } from '../../db/db';

function ImagePreviewBox({ blob, onClear }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  if (!url) return null;

  return (
    <div className="relative mt-2 inline-block rounded-lg border border-slate-200 bg-slate-50 p-1.5">
      <img src={url} alt="Pasted preview" className="max-h-36 rounded object-contain" />
      <button
        type="button"
        onClick={onClear}
        className="absolute -right-2 -top-2 rounded-full bg-slate-800 p-1 text-white shadow hover:bg-red-600"
        title="Remove image"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export default function QuickAddModal({ isOpen, onClose, existingCourses = [] }) {
  const [courseTag, setCourseTag] = useState('');
  const [referenceLabel, setReferenceLabel] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [questionBlob, setQuestionBlob] = useState(null);
  const [solutionText, setSolutionText] = useState('');
  const [solutionBlob, setSolutionBlob] = useState(null);
  const [savedToast, setSavedToast] = useState(false);

  if (!isOpen) return null;

  const extractClipboardImage = (e, setter) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) setter(file);
        break;
      }
    }
  };

  const handleSave = async (e, keepOpen = false) => {
    e.preventDefault();
    if (!questionText.trim() && !questionBlob) return;

    await db.questions.add({
      courseTag: courseTag.trim() || 'General',
      textbookId: null,
      referenceLabel: referenceLabel.trim(),
      status: 'ready',
      questionText: questionText.trim(),
      questionImageBlob: questionBlob,
      solutionText: solutionText.trim(),
      solutionImageBlob: solutionBlob,
      confidence: 'new',
      timesReviewed: 0,
      createdAt: Date.now(),
    });

    setReferenceLabel('');
    setQuestionText('');
    setQuestionBlob(null);
    setSolutionText('');
    setSolutionBlob(null);

    if (keepOpen) {
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 1800);
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Quick Add Question</h2>
            <p className="text-xs text-slate-500">
              Supports Markdown, LaTeX ($...$), and direct screenshot paste (Cmd+V)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={(e) => handleSave(e, false)} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Course Tag
              </label>
              <input
                type="text"
                list="course-suggestions"
                placeholder="e.g. MATH 237"
                value={courseTag}
                onChange={(e) => setCourseTag(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <datalist id="course-suggestions">
                {existingCourses.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Topic / Reference (Optional)
              </label>
              <input
                type="text"
                placeholder="e.g. Ch 3 #14 or Partial Derivatives"
                value={referenceLabel}
                onChange={(e) => setReferenceLabel(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Question Input */}
          <div
            onPaste={(e) => extractClipboardImage(e, setQuestionBlob)}
            className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5"
          >
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                Question *
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600">
                <Upload className="h-3.5 w-3.5" />
                Attach Image
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => setQuestionBlob(e.target.files?.[0] || null)}
                />
              </label>
            </div>

            <textarea
              rows={3}
              placeholder="Type problem text / LaTeX here, or click here and press Cmd+V to paste a screenshot..."
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <ImagePreviewBox blob={questionBlob} onClear={() => setQuestionBlob(null)} />
          </div>

          {/* Solution Input */}
          <div
            onPaste={(e) => extractClipboardImage(e, setSolutionBlob)}
            className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5"
          >
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                Solution (Optional)
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-slate-600 hover:text-emerald-600">
                <Upload className="h-3.5 w-3.5" />
                Attach Image
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => setSolutionBlob(e.target.files?.[0] || null)}
                />
              </label>
            </div>

            <textarea
              rows={3}
              placeholder="Type solution / LaTeX here, or click here and press Cmd+V to paste a screenshot..."
              value={solutionText}
              onChange={(e) => setSolutionText(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <ImagePreviewBox blob={solutionBlob} onClear={() => setSolutionBlob(null)} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <ClipboardPaste className="h-3.5 w-3.5" />
              Tip: Copy any screen region and paste directly into either box
            </span>

            <div className="flex items-center gap-2">
              {savedToast && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                  <Check className="h-3.5 w-3.5" /> Saved!
                </span>
              )}
              <button
                type="button"
                onClick={(e) => handleSave(e, true)}
                disabled={!questionText.trim() && !questionBlob}
                className="rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
              >
                Save &amp; Add Another
              </button>
              <button
                type="submit"
                disabled={!questionText.trim() && !questionBlob}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                Save Question
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}