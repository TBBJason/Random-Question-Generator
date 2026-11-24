import React, { useState, useMemo } from 'react';
import {
  Download,
  Upload,
  Trash2,
  Search,
  CheckCircle2,
  Clock,
  Image as ImageIcon,
  Pencil,
} from 'lucide-react';
import { useQuestions, addQuestion, deleteQuestion } from '../../db/db';
import EditQuestionModal from './EditQuestionModal';

async function imageUrlToDataURL(url) {
  if (!url) return null;
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

export default function QuestionBank() {
  const { questions, loading } = useQuestions();

  const [searchQuery, setSearchQuery] = useState('');
  const [courseFilter, setCourseFilter] = useState('ALL');
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);

  const courses = useMemo(() => {
    if (!questions) return [];
    return Array.from(new Set(questions.map((q) => q.courseTag || 'General'))).sort();
  }, [questions]);

  const filtered = useMemo(() => {
    if (!questions) return [];
    return questions.filter((q) => {
      const matchesCourse =
        courseFilter === 'ALL' || (q.courseTag || 'General') === courseFilter;
      const needle = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !needle ||
        q.referenceLabel?.toLowerCase().includes(needle) ||
        q.questionText?.toLowerCase().includes(needle) ||
        q.courseTag?.toLowerCase().includes(needle);
      return matchesCourse && matchesSearch;
    });
  }, [questions, courseFilter, searchQuery]);

  const handleExportBackup = async () => {
    if (!questions || questions.length === 0) return;
    setIsExporting(true);
    try {
      const serialized = await Promise.all(
        questions.map(async (q) => ({
          courseTag: q.courseTag,
          referenceLabel: q.referenceLabel,
          status: q.status,
          questionText: q.questionText,
          questionImageDataUrl: q.questionImageUrl
            ? await imageUrlToDataURL(q.questionImageUrl)
            : null,
          solutionText: q.solutionText,
          solutionImageDataUrl: q.solutionImageUrl
            ? await imageUrlToDataURL(q.solutionImageUrl)
            : null,
          confidence: q.confidence,
          timesReviewed: q.timesReviewed,
          createdAt: q.createdAt,
        }))
      );

      const payload = JSON.stringify(
        { exportedAt: new Date().toISOString(), questions: serialized },
        null,
        2
      );
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shuffle-study-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportBackup = async (file) => {
    if (!file) return;
    setIsImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed.questions) ? parsed.questions : [];

      for (const item of items) {
        const questionImageBlob = item.questionImageDataUrl
          ? await dataURLToBlob(item.questionImageDataUrl)
          : null;
        const solutionImageBlob = item.solutionImageDataUrl
          ? await dataURLToBlob(item.solutionImageDataUrl)
          : null;

        await addQuestion({
          courseTag: item.courseTag || 'General',
          referenceLabel: item.referenceLabel || '',
          status: item.status || 'ready',
          questionText: item.questionText || '',
          questionImageBlob,
          solutionText: item.solutionText || '',
          solutionImageBlob,
          confidence: item.confidence || 'new',
          timesReviewed: item.timesReviewed || 0,
        });
      }
    } catch (err) {
      alert('Could not import backup file. Make sure it is a valid ShuffleStudy JSON export.');
      console.error(err);
    } finally {
      setIsImporting(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteQuestion(id);
    } catch (err) {
      alert(`Could not delete question: ${err.message}`);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
      {/* Top Controls */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search questions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <select
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 focus:border-indigo-500 focus:outline-none"
          >
            <option value="ALL">All Courses</option>
            {courses.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportBackup}
            disabled={isExporting || !questions?.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {isExporting ? 'Exporting...' : 'Export Backup (.json)'}
          </button>

          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
            <Upload className="h-3.5 w-3.5" />
            {isImporting ? 'Importing...' : 'Import Backup'}
            <input
              type="file"
              accept="application/json"
              disabled={isImporting}
              className="hidden"
              onChange={(e) => handleImportBackup(e.target.files?.[0])}
            />
          </label>
        </div>
      </div>

      {/* Question List */}
      <div className="space-y-2.5">
        {loading && filtered.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            Loading library...
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
            No saved questions found.
          </div>
        ) : (
          filtered.map((q) => {
            const hasQuestion = Boolean(q.questionImageUrl || q.questionText?.trim());
            const hasSolution = Boolean(q.solutionImageUrl || q.solutionText?.trim());

            return (
              <div
                key={q.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-2xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs font-bold text-indigo-700">
                      {q.courseTag || 'General'}
                    </span>
                    {q.referenceLabel && (
                      <span className="text-sm font-semibold text-slate-900">
                        {q.referenceLabel}
                      </span>
                    )}
                    {hasQuestion ? (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        <CheckCircle2 className="h-3 w-3" /> Ready
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                        <Clock className="h-3 w-3" /> Draft
                      </span>
                    )}
                    {q.questionImageUrl && (
                      <span className="inline-flex items-center gap-1 rounded bg-indigo-50/70 px-2 py-0.5 text-[11px] font-medium text-indigo-600">
                        <ImageIcon className="h-3 w-3" /> Q Image
                      </span>
                    )}
                    {hasSolution && (
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        + Solution
                      </span>
                    )}
                  </div>

                  {q.questionText && (
                    <p className="mt-1.5 truncate text-xs text-slate-600">
                      {q.questionText}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditingQuestion(q)}
                    title="Edit question or solution"
                    className="rounded-lg p-2 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(q.id)}
                    title="Delete question"
                    className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <EditQuestionModal
        question={editingQuestion}
        isOpen={Boolean(editingQuestion)}
        onClose={() => setEditingQuestion(null)}
        existingCourses={courses}
      />
    </div>
  );
}