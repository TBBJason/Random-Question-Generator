import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  Shuffle,
  Eye,
  RotateCcw,
  CheckCircle2,
  Flame,
  HelpCircle,
  BookOpen,
  Sparkles,
} from 'lucide-react';
import { db } from '../../db/db';

function BlobImage({ blob, alt }) {
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
    <img
      src={url}
      alt={alt}
      className="mx-auto max-h-[28rem] w-auto rounded-lg border border-slate-200 bg-white object-contain shadow-xs"
    />
  );
}

function RichContent({ text }) {
  if (!text || !text.trim()) return null;
  return (
    <div className="space-y-2 text-base leading-relaxed text-slate-800">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function fisherYatesShuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export default function StudySession({ onOpenQuickAdd, onGoToSnipper }) {
  const allQuestions = useLiveQuery(() => db.questions.toArray(), []);

  // Only cards that actually have a question image or text can be studied
  const studyableQuestions = useMemo(() => {
    if (!allQuestions) return [];
    return allQuestions.filter(
      (q) => Boolean(q.questionImageBlob) || Boolean(q.questionText?.trim())
    );
  }, [allQuestions]);

  // Unique course tags available
  const courses = useMemo(() => {
    const tags = new Set(studyableQuestions.map((q) => q.courseTag || 'General'));
    return Array.from(tags).sort();
  }, [studyableQuestions]);

  // Filter state
  const [selectedCourses, setSelectedCourses] = useState([]); // empty = All courses
  const [requireSolution, setRequireSolution] = useState(false);

  // Active shuffle-deck state
  const [deckIds, setDeckIds] = useState([]);
  const [isRevealed, setIsRevealed] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [initialDeckSize, setInitialDeckSize] = useState(0);
  const [sessionStarted, setSessionStarted] = useState(false);

  const matchingPool = useMemo(() => {
    return studyableQuestions.filter((q) => {
      const courseMatch =
        selectedCourses.length === 0 ||
        selectedCourses.includes(q.courseTag || 'General');
      const solutionMatch =
        !requireSolution ||
        Boolean(q.solutionImageBlob) ||
        Boolean(q.solutionText?.trim());
      return courseMatch && solutionMatch;
    });
  }, [studyableQuestions, selectedCourses, requireSolution]);

  const startNewDeck = useCallback(() => {
    const shuffled = fisherYatesShuffle(matchingPool.map((q) => q.id));
    setDeckIds(shuffled);
    setInitialDeckSize(shuffled.length);
    setCompletedCount(0);
    setIsRevealed(false);
    setSessionStarted(true);
  }, [matchingPool]);

  // Auto-initialize deck once questions load from IndexedDB
  useEffect(() => {
    if (!sessionStarted && matchingPool.length > 0) {
      startNewDeck();
    }
  }, [sessionStarted, matchingPool.length, startNewDeck]);

  const toggleCourse = (course) => {
    setSelectedCourses((prev) =>
      prev.includes(course) ? prev.filter((c) => c !== course) : [...prev, course]
    );
  };

  // Current active question record (looked up live so edits reflect immediately)
  const currentCard = useMemo(() => {
    if (deckIds.length === 0) return null;
    return studyableQuestions.find((q) => q.id === deckIds[0]) || null;
  }, [deckIds, studyableQuestions]);

  // Handle confidence rating: 'again' | 'hard' | 'good'
  const handleRate = useCallback(
    async (rating) => {
      if (!currentCard) return;

      await db.questions.update(currentCard.id, {
        confidence: rating,
        timesReviewed: (currentCard.timesReviewed || 0) + 1,
      });

      setDeckIds((prev) => {
        const [, ...rest] = prev;
        if (rating === 'again') {
          // Re-insert 3 to 5 positions later in the active deck
          const offset = Math.min(rest.length, 3 + Math.floor(Math.random() * 3));
          const updated = [...rest];
          updated.splice(offset, 0, currentCard.id);
          return updated;
        }
        return rest;
      });

      if (rating !== 'again') {
        setCompletedCount((c) => c + 1);
      }
      setIsRevealed(false);
    },
    [currentCard]
  );

  // Keyboard shortcuts: Space to reveal, 1/2/3 to rate
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!currentCard) return;

      if (e.code === 'Space' && !isRevealed) {
        e.preventDefault();
        setIsRevealed(true);
      } else if (isRevealed) {
        if (e.key === '1') {
          e.preventDefault();
          handleRate('again');
        } else if (e.key === '2') {
          e.preventDefault();
          handleRate('hard');
        } else if (e.key === '3') {
          e.preventDefault();
          handleRate('good');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentCard, isRevealed, handleRate]);

  // Empty state when no questions exist yet
  if (allQuestions && studyableQuestions.length === 0) {
    return (
      <div className="mx-auto mt-16 max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xs">
        <BookOpen className="mx-auto mb-3 h-10 w-10 text-indigo-600" />
        <h2 className="text-lg font-bold text-slate-900">Your Question Deck is Empty</h2>
        <p className="mt-2 text-sm text-slate-600">
          Add a few practice problems with text, LaTeX, or pasted screenshots to start an interleaved study session.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={onOpenQuickAdd}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            + Quick Add Question
          </button>
          <button
            type="button"
            onClick={onGoToSnipper}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Open PDF Snipper
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {/* Course Filter & Shuffle Bar */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedCourses([])}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                selectedCourses.length === 0
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              All Courses ({studyableQuestions.length})
            </button>
            {courses.map((course) => {
              const active = selectedCourses.includes(course);
              return (
                <button
                  key={course}
                  type="button"
                  onClick={() => toggleCourse(course)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {course}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={requireSolution}
                onChange={(e) => setRequireSolution(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              Has solution only
            </label>

            <button
              type="button"
              onClick={startNewDeck}
              disabled={matchingPool.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
            >
              <Shuffle className="h-3.5 w-3.5" />
              Shuffle Deck ({matchingPool.length})
            </button>
          </div>
        </div>

        {/* Session Progress Bar */}
        {initialDeckSize > 0 && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs font-medium text-slate-500">
              <span>
                Completed: {completedCount} / {initialDeckSize}
              </span>
              <span>{deckIds.length} remaining in deck</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full bg-indigo-600 transition-all duration-300"
                style={{
                  width: `${Math.min(100, Math.round((completedCount / initialDeckSize) * 100))}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Active Flashcard / Problem Stage */}
      {matchingPool.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-600">
          No questions match the current filter. Try selecting more courses or unchecking &ldquo;Has solution only&rdquo;.
        </div>
      ) : !currentCard ? (
        <div className="rounded-2xl border border-emerald-200 bg-white p-10 text-center shadow-xs">
          <Sparkles className="mx-auto mb-3 h-10 w-10 text-emerald-600" />
          <h2 className="text-xl font-bold text-slate-900">Deck Complete!</h2>
          <p className="mt-1.5 text-sm text-slate-600">
            You worked through all {initialDeckSize} shuffled questions in this set.
          </p>
          <button
            type="button"
            onClick={startNewDeck}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            <RotateCcw className="h-4 w-4" />
            Reshuffle &amp; Study Again
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {/* Card Header */}
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-6 py-3">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-indigo-100 px-2.5 py-0.5 text-xs font-bold text-indigo-700">
                {currentCard.courseTag || 'General'}
              </span>
              {currentCard.referenceLabel && (
                <span className="text-xs font-semibold text-slate-600">
                  {currentCard.referenceLabel}
                </span>
              )}
            </div>
            <span className="text-xs text-slate-400">
              Reviewed {currentCard.timesReviewed || 0}x
            </span>
          </div>

          {/* Question Body */}
          <div className="p-6 sm:p-8">
            <div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">
              Problem
            </div>
            <div className="space-y-4">
              <RichContent text={currentCard.questionText} />
              <BlobImage blob={currentCard.questionImageBlob} alt="Problem" />
            </div>
          </div>

          {/* Solution Section (Hidden until revealed) */}
          {!isRevealed ? (
            <div className="border-t border-slate-100 bg-slate-50 px-6 py-5 text-center">
              <button
                type="button"
                onClick={() => setIsRevealed(true)}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
              >
                <Eye className="h-4 w-4" />
                Reveal Solution (Space)
              </button>
            </div>
          ) : (
            <div className="border-t border-emerald-100 bg-emerald-50/30 p-6 sm:p-8">
              <div className="mb-3 text-xs font-bold uppercase tracking-wider text-emerald-700">
                Solution
              </div>

              {currentCard.solutionText?.trim() || currentCard.solutionImageBlob ? (
                <div className="space-y-4">
                  <RichContent text={currentCard.solutionText} />
                  <BlobImage blob={currentCard.solutionImageBlob} alt="Solution" />
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                  No solution attached to this card yet. You can add one anytime in the Library tab.
                </p>
              )}

              {/* Confidence Rating Controls */}
              <div className="mt-8 border-t border-slate-200/80 pt-5">
                <p className="mb-3 text-center text-xs font-semibold uppercase tracking-wider text-slate-500">
                  How did that go?
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => handleRate('again')}
                    className="flex flex-col items-center justify-center rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-rose-700 transition hover:bg-rose-100"
                  >
                    <span className="flex items-center gap-1.5 text-sm font-bold">
                      <RotateCcw className="h-4 w-4" />
                      Again (1)
                    </span>
                    <span className="mt-0.5 text-[11px] text-rose-600">
                      Re-queue in 3–5 cards
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleRate('hard')}
                    className="flex flex-col items-center justify-center rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-800 transition hover:bg-amber-100"
                  >
                    <span className="flex items-center gap-1.5 text-sm font-bold">
                      <HelpCircle className="h-4 w-4" />
                      Hard (2)
                    </span>
                    <span className="mt-0.5 text-[11px] text-amber-700">
                      Got it with effort
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleRate('good')}
                    className="flex flex-col items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-800 transition hover:bg-emerald-100"
                  >
                    <span className="flex items-center gap-1.5 text-sm font-bold">
                      <CheckCircle2 className="h-4 w-4" />
                      Good (3)
                    </span>
                    <span className="mt-0.5 text-[11px] text-emerald-700">
                      Solved cleanly
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}