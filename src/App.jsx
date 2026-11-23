import React, { useState, useMemo } from 'react';
import { Shuffle, Scissors, Library, Plus, LogOut } from 'lucide-react';
import { useQuestions } from './db/db';
import { supabase } from './lib/supabase';
import LoginGate from './components/auth/LoginGate';
import StudySession from './components/study/StudySession';
import TextbookSnipper from './components/ingest/TextbookSnipper';
import QuickAddModal from './components/ingest/QuickAddModal';
import QuestionBank from './components/library/QuestionBank';

function MainApp() {
  const [activeTab, setActiveTab] = useState('study'); // 'study' | 'snipper' | 'library'
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);

  const { questions } = useQuestions();

  const readyCount = useMemo(() => {
    if (!questions) return 0;
    return questions.filter(
      (q) => Boolean(q.questionImageUrl) || Boolean(q.questionText?.trim())
    ).length;
  }, [questions]);

  const existingCourses = useMemo(() => {
    if (!questions) return [];
    return Array.from(new Set(questions.map((q) => q.courseTag).filter(Boolean))).sort();
  }, [questions]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="sticky top-0 z-30 flex min-h-16 flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-6">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <span className="rounded-lg bg-indigo-600 px-2.5 py-1 text-sm font-bold text-white">
            ShuffleStudy
          </span>

          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setActiveTab('study')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition sm:px-3 ${
                activeTab === 'study'
                  ? 'bg-white text-indigo-700 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Shuffle className="h-3.5 w-3.5" />
              Study ({readyCount})
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('library')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition sm:px-3 ${
                activeTab === 'library'
                  ? 'bg-white text-indigo-700 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Library className="h-3.5 w-3.5" />
              Library ({questions?.length || 0})
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('snipper')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition sm:px-3 ${
                activeTab === 'snipper'
                  ? 'bg-white text-indigo-700 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Scissors className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">PDF</span> Snipper
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsQuickAddOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-indigo-700 sm:px-3.5"
          >
            <Plus className="h-4 w-4" />
            Quick Add
          </button>

          <button
            type="button"
            onClick={() => supabase.auth.signOut()}
            title="Sign out"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </nav>

      {activeTab === 'study' && (
        <StudySession
          onOpenQuickAdd={() => setIsQuickAddOpen(true)}
          onGoToSnipper={() => setActiveTab('snipper')}
        />
      )}
      {activeTab === 'library' && <QuestionBank />}
      {activeTab === 'snipper' && <TextbookSnipper />}

      <QuickAddModal
        isOpen={isQuickAddOpen}
        onClose={() => setIsQuickAddOpen(false)}
        existingCourses={existingCourses}
      />
    </div>
  );
}

export default function App() {
  return (
    <LoginGate>
      <MainApp />
    </LoginGate>
  );
}