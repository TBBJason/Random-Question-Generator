import React, { useState, useEffect } from 'react';
import { X, Upload, ClipboardPaste, Loader2 } from 'lucide-react';
import { updateQuestion } from '../../db/db';

function EditableImageSlot({ existingUrl, isCleared, newBlob, onClear, alt }) {
  const [previewUrl, setPreviewUrl] = useState(null);

  useEffect(() => {
    if (!newBlob) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(newBlob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [newBlob]);

  const displayUrl = previewUrl || (!isCleared ? existingUrl : null);
  if (!displayUrl) return null;

  return (
    <div className="relative mt-2 inline-block rounded-lg border border-slate-200 bg-white p-1.5">
      <img
        src={displayUrl}
        alt={alt}
        className="max-h-44 rounded object-contain"
      />
      <button
        type="button"
        onClick={onClear}
        title="Remove image"
        className="absolute -right-2 -top-2 rounded-full bg-slate-800 p-1 text-white shadow hover:bg-rose-600"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export default function EditQuestionModal({
  question,
  isOpen,
  onClose,
  existingCourses = [],
}) {
  const [courseTag, setCourseTag] = useState('');
  const [referenceLabel, setReferenceLabel] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [questionBlob, setQuestionBlob] = useState(null);
  const [clearQuestionImage, setClearQuestionImage] = useState(false);

  const [solutionText, setSolutionText] = useState('');
  const [solutionBlob, setSolutionBlob] = useState(null);
  const [clearSolutionImage, setClearSolutionImage] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!question || !isOpen) return;
    setCourseTag(question.courseTag || 'General');
    setReferenceLabel(question.referenceLabel || '');
    setQuestionText(question.questionText || '');
    setQuestionBlob(null);
    setClearQuestionImage(false);

    setSolutionText(question.solutionText || '');
    setSolutionBlob(null);
    setClearSolutionImage(false);
  }, [question, isOpen]);

  if (!isOpen || !question) return null;

  const handlePasteImage = (e, setBlob, setCleared) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          setBlob(file);
          setCleared(false);
        }
        break;
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSaving) return;

    setIsSaving(true);
    try {
      await updateQuestion(question.id, {
        courseTag,
        referenceLabel,
        questionText: questionText.trim(),
        questionImageBlob: questionBlob,
        clearQuestionImage,
        solutionText: solutionText.trim(),
        solutionImageBlob: solutionBlob,
        clearSolutionImage,
      });
      onClose();
    } catch (err) {
      console.error('Failed to update question:', err);
      alert(`Could not save changes: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl sm:p-6">
        <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Edit Question &amp; Solution
            </h2>
            <p className="text-xs text-slate-500">
              Update details, add LaTeX notes, or paste screenshots (Cmd+V)
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

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Course Tag
              </label>
              <input
                type="text"
                list="edit-course-suggestions"
                value={courseTag}
                onChange={(e) => setCourseTag(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <datalist id="edit-course-suggestions">
                {existingCourses.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Topic / Reference
              </label>
              <input
                type="text"
                placeholder="e.g. Ch 3 #14"
                value={referenceLabel}
                onChange={(e) => setReferenceLabel(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Question Box */}
          <div
            onPaste={(e) =>
              handlePasteImage(e, setQuestionBlob, setClearQuestionImage)
            }
            className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5"
          >
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                Question
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600">
                <Upload className="h-3.5 w-3.5" />
                {question.questionImageUrl || questionBlob
                  ? 'Replace Image'
                  : 'Attach Image'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setQuestionBlob(file);
                      setClearQuestionImage(false);
                    }
                  }}
                />
              </label>
            </div>

            <textarea
              rows={3}
              placeholder="Add or edit question text / LaTeX ($...$), or press Cmd+V to paste an image..."
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />

            <EditableImageSlot
              existingUrl={question.questionImageUrl}
              isCleared={clearQuestionImage}
              newBlob={questionBlob}
              alt="Question preview"
              onClear={() => {
                setQuestionBlob(null);
                setClearQuestionImage(true);
              }}
            />
          </div>

          {/* Solution Box */}
          <div
            onPaste={(e) =>
              handlePasteImage(e, setSolutionBlob, setClearSolutionImage)
            }
            className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5"
          >
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                Solution
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-slate-600 hover:text-emerald-600">
                <Upload className="h-3.5 w-3.5" />
                {question.solutionImageUrl || solutionBlob
                  ? 'Replace Image'
                  : 'Attach Image'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setSolutionBlob(file);
                      setClearSolutionImage(false);
                    }
                  }}
                />
              </label>
            </div>

            <textarea
              rows={3}
              placeholder="Type solution / LaTeX ($...$), or click here and press Cmd+V to paste a solution screenshot..."
              value={solutionText}
              onChange={(e) => setSolutionText(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />

            <EditableImageSlot
              existingUrl={question.solutionImageUrl}
              isCleared={clearSolutionImage}
              newBlob={solutionBlob}
              alt="Solution preview"
              onClear={() => {
                setSolutionBlob(null);
                setClearSolutionImage(true);
              }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <ClipboardPaste className="h-3.5 w-3.5" />
              Paste screenshots directly into either section
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}