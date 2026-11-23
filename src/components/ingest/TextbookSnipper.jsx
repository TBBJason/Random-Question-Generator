import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Upload,
  FileText,
  Scissors,
  Check,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Plus,
  Trash2,
  BookOpen,
  KeyRound,
  X,
  Image as ImageIcon,
  Wand2,
  Key,
  Loader2,
} from 'lucide-react';
import { db, queueDraftQuestions, updateQuestionSlot } from '../../db/db';
import { parseStructuredProblems } from '../../utils/parseProblemList';
import { pdfjsLib } from '../../utils/pdfConfig';
import { autoExtractFromPdf, findSolutionsStartPage } from '../../utils/autoCropper';
import AutoExtractReviewModal from './AutoExtractReviewModal';

function BlobPreview({ blob, alt, className }) {
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
  return <img src={url} alt={alt} className={className} />;
}

export default function TextbookSnipper() {
  // --- Live IndexedDB Queries ---
  const textbooks = useLiveQuery(
    () => db.textbooks.orderBy('createdAt').reverse().toArray(),
    []
  );

  const [selectedTextbookId, setSelectedTextbookId] = useState(null);
  const selectedTextbook = useMemo(
    () => textbooks?.find((t) => t.id === selectedTextbookId) || null,
    [textbooks, selectedTextbookId]
  );

  useEffect(() => {
    if (!selectedTextbookId && textbooks && textbooks.length > 0) {
      setSelectedTextbookId(textbooks[0].id);
    }
  }, [textbooks, selectedTextbookId]);

  const questions = useLiveQuery(async () => {
    if (selectedTextbookId) {
      return await db.questions
        .where('textbookId')
        .equals(selectedTextbookId)
        .toArray();
    }
    return await db.questions.orderBy('createdAt').toArray();
  }, [selectedTextbookId]);

  // --- Textbook Upload Form State ---
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCourseTag, setNewCourseTag] = useState('');
  const [bookFile, setBookFile] = useState(null);
  const [solutionsFile, setSolutionsFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  // --- Smart Queue & Auto-Extract State ---
  const [rawProblemList, setRawProblemList] = useState('');
  const [queueCourseTag, setQueueCourseTag] = useState('');
  const [startPageHint, setStartPageHint] = useState('');
  const [solPageHint, setSolPageHint] = useState('');
  
  const [queueFilter, setQueueFilter] = useState('all');

  // Gemini API Key persisted in localStorage
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || import.meta.env.VITE_GEMINI_API_KEY || '');
  const [showApiKeyBox, setShowApiKeyBox] = useState(false);

  // Auto-extract progress & verification modal state
  const [isAutoExtracting, setIsAutoExtracting] = useState(false);
  const [extractStatusText, setExtractStatusText] = useState('');
  const [reviewBatch, setReviewBatch] = useState(null);
  const [isReviewOpen, setIsReviewOpen] = useState(false);

  useEffect(() => {
    if (selectedTextbook?.courseTag) {
      setQueueCourseTag(selectedTextbook.courseTag);
    }
  }, [selectedTextbook?.courseTag]);

  const structuredPreview = useMemo(
    () => parseStructuredProblems(rawProblemList),
    [rawProblemList]
  );

  // --- Active Question & Target Slot ('question' | 'solution') ---
  const [activeQuestionId, setActiveQuestionId] = useState(null);
  const [activeSlot, setActiveSlot] = useState('question');

  const filteredQuestions = useMemo(() => {
    if (!questions) return [];
    return questions.filter((q) => {
      if (queueFilter === 'missing-q') {
        return !q.questionImageBlob && !q.questionText?.trim();
      }
      if (queueFilter === 'missing-a') {
        return !q.solutionImageBlob && !q.solutionText?.trim();
      }
      return true;
    });
  }, [questions, queueFilter]);

  useEffect(() => {
    if (!questions || questions.length === 0) {
      setActiveQuestionId(null);
      return;
    }
    const stillExists = questions.some((q) => q.id === activeQuestionId);
    if (!stillExists) {
      const firstDraft = questions.find((q) => q.status === 'draft') || questions[0];
      setActiveQuestionId(firstDraft.id);
    }
  }, [questions, activeQuestionId]);

  const activeQuestion = useMemo(
    () => questions?.find((q) => q.id === activeQuestionId) || null,
    [questions, activeQuestionId]
  );

  // --- PDF Viewer State ---
  const [pdfSource, setPdfSource] = useState('book'); // 'book' | 'solutions'
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNumbers, setPageNumbers] = useState({ book: 1, solutions: 1 });
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1.2);
  const [pdfLoading, setPdfLoading] = useState(false);

  // Pending pre-drawn normalized box when jumping from Review Modal -> "Adjust Crop"
  const pendingNormRectRef = useRef(null);

  const currentPage = pageNumbers[pdfSource] || 1;

  // Restore saved page number from localStorage when switching books (no Dexie write!)
  useEffect(() => {
    if (!selectedTextbookId) return;
    const savedBookPage = Number(
      localStorage.getItem(`shufflestudy_page_${selectedTextbookId}`) || 1
    );
    setPageNumbers({
      book: savedBookPage > 0 ? savedBookPage : 1,
      solutions: 1,
    });
    if (pdfSource === 'solutions' && !selectedTextbook?.solutionsPdfBlob) {
      setPdfSource('book');
    }
  }, [selectedTextbookId]);

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage, pdfSource]);

  // Load PDF document ONLY when selectedTextbookId, the PDF blobs, or pdfSource changes
  const activePdfBlob =
    pdfSource === 'solutions'
      ? selectedTextbook?.solutionsPdfBlob
      : selectedTextbook?.bookPdfBlob;

  useEffect(() => {
    let cancelled = false;
    let loadedDoc = null;

    async function loadPdf() {
      if (!activePdfBlob) {
        setPdfDoc(null);
        setNumPages(0);
        return;
      }

      setPdfLoading(true);
      try {
        const arrayBuffer = await activePdfBlob.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        loadedDoc = await loadingTask.promise;

        if (!cancelled) {
          setPdfDoc(loadedDoc);
          setNumPages(loadedDoc.numPages);
          setPageNumbers((prev) => ({
            ...prev,
            [pdfSource]: Math.min(Math.max(1, prev[pdfSource]), loadedDoc.numPages),
          }));
        }
      } catch (err) {
        console.error('Failed to load PDF:', err);
      } finally {
        if (!cancelled) setPdfLoading(false);
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
      if (loadedDoc) {
        loadedDoc.destroy();
      }
    };
  }, [selectedTextbookId, activePdfBlob, pdfSource]);

  // --- Canvas & Drag-to-Crop State ---
  const pdfCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [selectionRect, setSelectionRect] = useState(null);
  const [isSavingSnip, setIsSavingSnip] = useState(false);

  useEffect(() => {
    if (!pendingNormRectRef.current) {
      setSelectionRect(null);
    }
    setIsDragging(false);
  }, [currentPage, zoom, pdfSource, selectedTextbookId]);

  // Render current PDF page onto primary canvas
  useEffect(() => {
    let active = true;

    async function renderPage() {
      if (!pdfDoc || !pdfCanvasRef.current || !overlayCanvasRef.current) return;

      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // Ignore
        }
      }

      try {
        const page = await pdfDoc.getPage(currentPage);
        if (!active) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: zoom });

        const pdfCanvas = pdfCanvasRef.current;
        const overlayCanvas = overlayCanvasRef.current;
        const ctx = pdfCanvas.getContext('2d');

        const cssWidth = Math.floor(viewport.width);
        const cssHeight = Math.floor(viewport.height);

        pdfCanvas.width = Math.floor(viewport.width * dpr);
        pdfCanvas.height = Math.floor(viewport.height * dpr);
        pdfCanvas.style.width = `${cssWidth}px`;
        pdfCanvas.style.height = `${cssHeight}px`;

        overlayCanvas.width = cssWidth;
        overlayCanvas.height = cssHeight;
        overlayCanvas.style.width = `${cssWidth}px`;
        overlayCanvas.style.height = `${cssHeight}px`;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const renderTask = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = renderTask;

        await renderTask.promise;

        // If user clicked "Adjust Crop" from the Review Modal, pre-populate selection box
        if (active && pendingNormRectRef.current) {
          const nr = pendingNormRectRef.current;
          pendingNormRectRef.current = null;
          setSelectionRect({
            x: nr.x * cssWidth,
            y: nr.y * cssHeight,
            width: nr.width * cssWidth,
            height: nr.height * cssHeight,
          });
        }
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Error rendering PDF page:', err);
        }
      }
    }

    renderPage();

    return () => {
      active = false;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // Ignore
        }
      }
    };
  }, [pdfDoc, currentPage, zoom]);

  // Draw selection rectangle on overlay canvas
  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (!selectionRect || selectionRect.width < 4 || selectionRect.height < 4) return;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.25)';
    ctx.fillRect(0, 0, overlay.width, overlay.height);

    ctx.clearRect(
      selectionRect.x,
      selectionRect.y,
      selectionRect.width,
      selectionRect.height
    );

    ctx.strokeStyle = activeSlot === 'question' ? '#4f46e5' : '#059669';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      selectionRect.x,
      selectionRect.y,
      selectionRect.width,
      selectionRect.height
    );
  }, [selectionRect, activeSlot]);

  // --- Mouse Handlers for Drag-to-Crop ---
  const getRelativeCoords = (e) => {
    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    return { x, y };
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0 || !pdfDoc) return;
    const coords = getRelativeCoords(e);
    setIsDragging(true);
    setDragStart(coords);
    setSelectionRect({ x: coords.x, y: coords.y, width: 0, height: 0 });
  };

  const handleMouseMove = (e) => {
    if (!isDragging || !dragStart) return;
    const coords = getRelativeCoords(e);
    setSelectionRect({
      x: Math.min(dragStart.x, coords.x),
      y: Math.min(dragStart.y, coords.y),
      width: Math.abs(coords.x - dragStart.x),
      height: Math.abs(coords.y - dragStart.y),
    });
  };

  const handleMouseUp = () => {
    if (!isDragging) return;
    setIsDragging(false);
    if (selectionRect && (selectionRect.width < 10 || selectionRect.height < 10)) {
      setSelectionRect(null);
    }
  };

  // --- Save Cropped Snip & Auto-Advance Queue ---
  const handleSaveSnip = useCallback(async () => {
    if (
      !selectionRect ||
      selectionRect.width < 10 ||
      selectionRect.height < 10 ||
      !pdfCanvasRef.current ||
      !overlayCanvasRef.current ||
      !activeQuestion
    ) {
      return;
    }

    setIsSavingSnip(true);
    try {
      const pdfCanvas = pdfCanvasRef.current;
      const overlayCanvas = overlayCanvasRef.current;

      const scaleX = pdfCanvas.width / overlayCanvas.width;
      const scaleY = pdfCanvas.height / overlayCanvas.height;

      const srcX = Math.round(selectionRect.x * scaleX);
      const srcY = Math.round(selectionRect.y * scaleY);
      const srcW = Math.round(selectionRect.width * scaleX);
      const srcH = Math.round(selectionRect.height * scaleY);

      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = srcW;
      cropCanvas.height = srcH;
      const cropCtx = cropCanvas.getContext('2d');

      cropCtx.drawImage(pdfCanvas, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

      const blob = await new Promise((resolve) =>
        cropCanvas.toBlob(resolve, 'image/png')
      );

      if (blob) {
        await updateQuestionSlot(activeQuestion.id, activeSlot, { imageBlob: blob });
        setSelectionRect(null);

        if (questions && questions.length > 1) {
          const currentIndex = questions.findIndex((q) => q.id === activeQuestion.id);
          const orderedAfter = [
            ...questions.slice(currentIndex + 1),
            ...questions.slice(0, currentIndex),
          ];

          const nextTarget = orderedAfter.find((q) =>
            activeSlot === 'question'
              ? !q.questionImageBlob && !q.questionText?.trim()
              : !q.solutionImageBlob && !q.solutionText?.trim()
          );

          if (nextTarget) {
            setActiveQuestionId(nextTarget.id);
          } else if (currentIndex + 1 < questions.length) {
            setActiveQuestionId(questions[currentIndex + 1].id);
          }
        }
      }
    } finally {
      setIsSavingSnip(false);
    }
  }, [selectionRect, activeQuestion, activeSlot, questions]);

  // --- Fast Page Navigation (No Dexie write!) ---
  const goToPage = useCallback(
    (targetPage) => {
      if (!numPages) return;
      const clamped = Math.min(Math.max(1, targetPage), numPages);
      setPageNumbers((prev) => ({ ...prev, [pdfSource]: clamped }));

      if (pdfSource === 'book' && selectedTextbookId) {
        localStorage.setItem(`shufflestudy_page_${selectedTextbookId}`, String(clamped));
      }
    },
    [numPages, pdfSource, selectedTextbookId]
  );

  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Enter' && selectionRect) {
        e.preventDefault();
        handleSaveSnip();
      } else if (e.key === 'Escape' && selectionRect) {
        e.preventDefault();
        setSelectionRect(null);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPage(currentPage - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToPage(currentPage + 1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectionRect, handleSaveSnip, goToPage, currentPage]);

  // --- Handlers: Upload Textbook ---
  const handleUploadTextbook = async (e) => {
    e.preventDefault();
    if (!bookFile) return;

    setIsUploading(true);
    try {
      const cleanTitle = newTitle.trim() || bookFile.name.replace(/\.pdf$/i, '');
      const id = await db.textbooks.add({
        title: cleanTitle,
        courseTag: newCourseTag.trim() || 'General',
        bookPdfBlob: bookFile,
        solutionsPdfBlob: solutionsFile || null,
        createdAt: Date.now(),
      });

      setSelectedTextbookId(id);
      setNewTitle('');
      setNewCourseTag('');
      setBookFile(null);
      setSolutionsFile(null);
      setShowUploadForm(false);
    } finally {
      setIsUploading(false);
    }
  };

  const handleAttachSolutionsLater = async (file) => {
    if (!file || !selectedTextbookId) return;
    await db.textbooks.update(selectedTextbookId, { solutionsPdfBlob: file });
    setPdfSource('solutions');
  };

  // --- Manual Queue Generation ---
  const handleManualQueueOnly = async () => {
    if (structuredPreview.length === 0) return;

    await queueDraftQuestions({
      courseTag: queueCourseTag || selectedTextbook?.courseTag || 'General',
      textbookId: selectedTextbookId,
      labels: structuredPreview.map((p) => p.label),
    });

    setRawProblemList('');
  };

  // --- HYBRID AUTO-EXTRACT (Vision-LLM Primary + Local Heuristic Fallback) ---
    const handleAutoExtract = async (e) => {
        e.preventDefault();
        if (!selectedTextbook?.bookPdfBlob || structuredPreview.length === 0) return;

        setIsAutoExtracting(true);
        setExtractStatusText('Finding and cropping questions...');

        try {
        const parsedHint = parseInt(startPageHint, 10);
        const qHint = !Number.isNaN(parsedHint) && parsedHint > 0 ? parsedHint : null;

        // Extract Questions only (keeps extraction fast and accurate)
        const qResult = await autoExtractFromPdf({
            pdfBlob: selectedTextbook.bookPdfBlob,
            structuredProblems: structuredPreview,
            mode: 'question',
            isBackOfBook: false,
            apiKey,
            startPageHint: qHint,
            onProgress: setExtractStatusText,
        });

        const now = Date.now();
        const course = (queueCourseTag || selectedTextbook.courseTag || 'General').trim();
        const reviewItems = [];

        for (const prob of structuredPreview) {
            const qMatch = qResult.matches.get(prob.problemNumber) || null;

            const id = await db.questions.add({
            courseTag: course,
            textbookId: selectedTextbookId,
            referenceLabel: prob.label,
            status: 'draft',
            questionText: '',
            questionImageBlob: qMatch?.blob || null,
            solutionText: '',
            solutionImageBlob: null,
            confidence: 'new',
            timesReviewed: 0,
            createdAt: now,
            });

            reviewItems.push({
            id,
            courseTag: course,
            referenceLabel: prob.label,
            questionImageBlob: qMatch?.blob || null,
            questionPage: qMatch?.pageNumber || null,
            questionNormRect: qMatch?.normRect || null,
            solutionImageBlob: null,
            solutionPage: null,
            solutionNormRect: null,
            approved: false,
            });
        }

        setRawProblemList('');
        setActiveSlot('solution'); // Ready for manual solution snipping after review
        setReviewBatch({
            items: reviewItems,
            questionEngine: qResult.engineUsed,
            solutionEngine: 'none',
            fallbackReason: qResult.fallbackReason,
        });
        setIsReviewOpen(true);
        } catch (err) {
        console.error('Auto-extract failed:', err);
        alert(`Auto-extract encountered an error: ${err.message}`);
        } finally {
        setIsAutoExtracting(false);
        setExtractStatusText('');
        }
    };

  // Jump straight to the exact PDF page + pre-drawn box when user clicks "Adjust Crop" in Review Modal
  const handleJumpToFixCrop = ({ questionId, slot, pageNumber, normRect }) => {
    setIsReviewOpen(false);
    setActiveQuestionId(questionId);
    setActiveSlot(slot);
    pendingNormRectRef.current = normRect || null;

    const targetSource = slot === 'solution' && selectedTextbook?.solutionsPdfBlob ? 'solutions' : 'book';
    setPdfSource(targetSource);
    setPageNumbers((prev) => ({
      ...prev,
      [targetSource]: Math.max(1, pageNumber || 1),
    }));
  };

  const handleSaveApiKey = (val) => {
    setApiKey(val);
    if (val.trim()) {
      localStorage.setItem('gemini_api_key', val.trim());
    } else {
      localStorage.removeItem('gemini_api_key');
    }
  };

  const handleDeleteQuestion = async (id, e) => {
    e.stopPropagation();
    await db.questions.delete(id);
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] w-full overflow-hidden bg-slate-50 text-slate-900">
      {/* ==================== LEFT PANE: SMART QUEUE & AUTO-EXTRACTOR ==================== */}
      <aside className="flex w-96 shrink-0 flex-col border-r border-slate-200 bg-white">
        {/* 1. Textbook Selector Header */}
        <div className="border-b border-slate-200 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Active Textbook
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowApiKeyBox((prev) => !prev)}
                title="Configure Gemini Vision API Key"
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                  apiKey
                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <Key className="h-3 w-3" />
                {apiKey ? 'AI Ready' : 'API Key'}
              </button>

              <button
                type="button"
                onClick={() => setShowUploadForm((prev) => !prev)}
                className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
              >
                {showUploadForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                {showUploadForm ? 'Cancel' : 'Add PDF'}
              </button>
            </div>
          </div>

          {/* Optional Gemini API Key Drawer */}
          {showApiKeyBox && (
            <div className="mb-2.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
              <label className="mb-1 block font-semibold text-slate-700">
                Gemini API Key (Primary Vision-LLM)
              </label>
              <input
                type="password"
                placeholder="AIzaSy..."
                value={apiKey}
                onChange={(e) => handleSaveApiKey(e.target.value)}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Stored locally in your browser. If empty or offline, auto-crop automatically uses the local text-coordinate fallback.
              </p>
            </div>
          )}

          {showUploadForm ? (
            <form
              onSubmit={handleUploadTextbook}
              className="mt-2 space-y-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs"
            >
              <div>
                <label className="mb-1 block font-medium text-slate-700">
                  Textbook PDF *
                </label>
                <input
                  type="file"
                  accept="application/pdf"
                  required
                  onChange={(e) => setBookFile(e.target.files?.[0] || null)}
                  className="w-full text-slate-600 file:mr-2 file:rounded file:border-0 file:bg-indigo-600 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-indigo-700"
                />
              </div>

              <div>
                <label className="mb-1 block font-medium text-slate-700">
                  Solutions Manual PDF (Optional)
                </label>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setSolutionsFile(e.target.files?.[0] || null)}
                  className="w-full text-slate-600 file:mr-2 file:rounded file:border-0 file:bg-slate-600 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-slate-700"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="Book Title"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="text"
                  placeholder="Course (e.g. MATH 237)"
                  value={newCourseTag}
                  onChange={(e) => setNewCourseTag(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={!bookFile || isUploading}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-indigo-600 py-1.5 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {isUploading ? 'Saving...' : 'Save Textbook Locally'}
              </button>
            </form>
          ) : (
            <select
              value={selectedTextbookId || ''}
              onChange={(e) => setSelectedTextbookId(Number(e.target.value) || null)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 focus:border-indigo-500 focus:outline-none"
            >
              {!textbooks || textbooks.length === 0 ? (
                <option value="">No textbooks uploaded yet</option>
              ) : (
                textbooks.map((book) => (
                  <option key={book.id} value={book.id}>
                    [{book.courseTag}] {book.title}
                  </option>
                ))
              )}
            </select>
          )}
        </div>

        {/* 2. Syllabus Problem List + Hybrid Auto-Cropper */}
        <form onSubmit={handleAutoExtract} className="border-b border-slate-200 p-4">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Problem List
            </label>
            {structuredPreview.length > 0 && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                {structuredPreview.length} {structuredPreview.length === 1 ? 'problem' : 'problems'}
              </span>
            )}
          </div>

          <textarea
            rows={2}
            placeholder="e.g. Ch 3: 1, 4, 7-10, 15"
            value={rawProblemList}
            onChange={(e) => setRawProblemList(e.target.value)}
            className="w-full resize-none rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none"
          />

          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="Course Tag"
              value={queueCourseTag}
              onChange={(e) => setQueueCourseTag(e.target.value)}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="number"
              min="1"
              placeholder="Start PDF p. (Opt)"
              value={startPageHint}
              onChange={(e) => setStartPageHint(e.target.value)}
              title="Optional: starting PDF page number to speed up search"
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="mt-2.5 flex gap-2">
            <button
              type="submit"
              disabled={
                structuredPreview.length === 0 ||
                !selectedTextbook?.bookPdfBlob ||
                isAutoExtracting
              }
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isAutoExtracting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Extracting...
                </>
              ) : (
                <>
                  <Wand2 className="h-3.5 w-3.5" />
                  Auto-Find &amp; Crop
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleManualQueueOnly}
              disabled={structuredPreview.length === 0 || isAutoExtracting}
              title="Add empty slots to snip manually"
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              Manual Queue
            </button>
          </div>

          {extractStatusText && (
            <p className="mt-2 text-[11px] font-medium text-indigo-700">
              {extractStatusText}
            </p>
          )}

          {reviewBatch && !isReviewOpen && (
            <button
              type="button"
              onClick={() => setIsReviewOpen(true)}
              className="mt-2 w-full rounded-lg border border-emerald-300 bg-emerald-50 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              Re-open Verification Review ({reviewBatch.items.length})
            </button>
          )}
        </form>

        {/* 3. Target Capture Mode Toggle */}
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Manual Snip Slot
            </span>
            <div className="flex gap-1 text-[11px]">
              {['all', 'missing-q', 'missing-a'].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setQueueFilter(mode)}
                  className={`rounded px-1.5 py-0.5 font-medium ${
                    queueFilter === mode
                      ? 'bg-slate-200 text-slate-900'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {mode === 'all' ? 'All' : mode === 'missing-q' ? 'No Q' : 'No Sol'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-slate-200/80 p-1">
            <button
              type="button"
              onClick={() => setActiveSlot('question')}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition ${
                activeSlot === 'question'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BookOpen className="h-3.5 w-3.5" />
              Question
            </button>
            <button
              type="button"
              onClick={() => setActiveSlot('solution')}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition ${
                activeSlot === 'solution'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              Solution
            </button>
          </div>
        </div>

        {/* 4. Scrollable Queue Items */}
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {filteredQuestions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
              No queued problems here. Paste a syllabus list above and click Auto-Find &amp; Crop.
            </div>
          ) : (
            filteredQuestions.map((q) => {
              const isSelected = q.id === activeQuestionId;
              const hasQ = Boolean(q.questionImageBlob || q.questionText?.trim());
              const hasA = Boolean(q.solutionImageBlob || q.solutionText?.trim());

              return (
                <div
                  key={q.id}
                  onClick={() => setActiveQuestionId(q.id)}
                  className={`cursor-pointer rounded-lg border p-2.5 transition ${
                    isSelected
                      ? activeSlot === 'question'
                        ? 'border-indigo-500 bg-indigo-50/50 ring-1 ring-indigo-500'
                        : 'border-emerald-500 bg-emerald-50/50 ring-1 ring-emerald-500'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-900">
                          {q.referenceLabel || `Question #${q.id}`}
                        </span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                          {q.courseTag}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <span
                        className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          hasQ
                            ? 'bg-indigo-100 text-indigo-700'
                            : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        {hasQ && <Check className="h-2.5 w-2.5" />}Q
                      </span>
                      <span
                        className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          hasA
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        {hasA && <Check className="h-2.5 w-2.5" />}A
                      </span>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteQuestion(q.id, e)}
                        className="ml-1 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {isSelected && (q.questionImageBlob || q.solutionImageBlob) && (
                    <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-200/80 pt-2">
                      {q.questionImageBlob && (
                        <div>
                          <span className="mb-0.5 block text-[10px] font-medium text-indigo-700">
                            Question Snip
                          </span>
                          <BlobPreview
                            blob={q.questionImageBlob}
                            alt="Question preview"
                            className="max-h-20 w-full rounded border border-slate-200 bg-white object-contain"
                          />
                        </div>
                      )}
                      {q.solutionImageBlob && (
                        <div>
                          <span className="mb-0.5 block text-[10px] font-medium text-emerald-700">
                            Solution Snip
                          </span>
                          <BlobPreview
                            blob={q.solutionImageBlob}
                            alt="Solution preview"
                            className="max-h-20 w-full rounded border border-slate-200 bg-white object-contain"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ==================== RIGHT PANE: PDF VIEWER & CROPPER ==================== */}
      <main className="flex flex-1 flex-col overflow-hidden bg-slate-200/70">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 bg-white px-4 py-2.5 shadow-xs">
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setPdfSource('book')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                  pdfSource === 'book'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <FileText className="h-3.5 w-3.5" />
                Textbook PDF
              </button>

              {selectedTextbook?.solutionsPdfBlob ? (
                <button
                  type="button"
                  onClick={() => setPdfSource('solutions')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                    pdfSource === 'solutions'
                      ? 'bg-white text-emerald-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Solutions PDF
                </button>
              ) : (
                selectedTextbook && (
                  <label className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-200/70 hover:text-slate-800">
                    <Plus className="h-3.5 w-3.5" />
                    Attach Solutions PDF
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={(e) => handleAttachSolutionsLater(e.target.files?.[0])}
                    />
                  </label>
                )
              )}
            </div>
          </div>

          {pdfDoc && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                className="rounded-md border border-slate-300 p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = parseInt(pageInput, 10);
                  if (!Number.isNaN(parsed)) goToPage(parsed);
                }}
                className="flex items-center gap-1.5 text-xs font-medium text-slate-700"
              >
                <span>Page</span>
                <input
                  type="text"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  className="w-14 rounded border border-slate-300 py-1 text-center text-xs font-semibold focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-slate-500">of {numPages}</span>
              </form>

              <button
                type="button"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= numPages}
                className="rounded-md border border-slate-300 p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}

          {pdfDoc && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.15).toFixed(2)))}
                className="rounded-md border border-slate-300 p-1.5 text-slate-700 hover:bg-slate-100"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="w-12 text-center text-xs font-semibold text-slate-700">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.15).toFixed(2)))}
                className="rounded-md border border-slate-300 p-1.5 text-slate-700 hover:bg-slate-100"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
            </div>
          )}
        </header>

        {pdfDoc && (
          <div
            className={`flex items-center justify-between px-4 py-2 text-xs font-medium ${
              activeQuestion
                ? activeSlot === 'question'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-emerald-600 text-white'
                : 'bg-amber-100 text-amber-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <Scissors className="h-3.5 w-3.5" />
              {activeQuestion ? (
                <span>
                  Drag a box over the page to capture{' '}
                  <strong className="uppercase underline">{activeSlot}</strong> for{' '}
                  <strong>{activeQuestion.referenceLabel}</strong>
                </span>
              ) : (
                <span>
                  Add or select a problem in the left queue before snipping.
                </span>
              )}
            </div>

            {selectionRect && activeQuestion && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectionRect(null)}
                  className="rounded bg-black/20 px-2.5 py-1 text-xs font-semibold hover:bg-black/30"
                >
                  Cancel (Esc)
                </button>
                <button
                  type="button"
                  onClick={handleSaveSnip}
                  disabled={isSavingSnip}
                  className="inline-flex items-center gap-1 rounded bg-white px-3 py-1 text-xs font-bold text-slate-900 shadow-sm hover:bg-slate-100"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  {isSavingSnip ? 'Saving...' : 'Save Snip (Enter)'}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-auto p-6">
          {!selectedTextbook ? (
            <div className="mx-auto mt-16 max-w-md rounded-xl border border-slate-300 bg-white p-8 text-center shadow-xs">
              <BookOpen className="mx-auto mb-3 h-10 w-10 text-indigo-600" />
              <h2 className="text-base font-bold text-slate-900">
                Upload a Textbook PDF to Begin
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                Click <strong>+ Add PDF</strong> in the top-left panel to store your course textbook (and optional solutions manual) locally in your browser.
              </p>
            </div>
          ) : pdfLoading ? (
            <div className="flex h-full items-center justify-center text-sm font-medium text-slate-600">
              Loading PDF...
            </div>
          ) : (
            <div className="mx-auto w-fit rounded-lg bg-white p-2 shadow-md">
              <div className="relative select-none">
                <canvas ref={pdfCanvasRef} className="block" />
                <canvas
                  ref={overlayCanvasRef}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  className="absolute inset-0 cursor-crosshair"
                />
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Side-by-Side Verification Modal */}
      <AutoExtractReviewModal
        isOpen={isReviewOpen}
        onClose={() => setIsReviewOpen(false)}
        batchSummary={reviewBatch}
        onFixCrop={handleJumpToFixCrop}
      />
    </div>
  );
}