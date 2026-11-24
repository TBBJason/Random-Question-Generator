import { useState, useEffect } from 'react';
import Dexie from 'dexie';
import { supabase } from '../lib/supabase';

// Local-only IndexedDB for large textbook PDFs on your laptop
export const db = new Dexie('InterleavedStudyDB');

db.version(1).stores({
  textbooks: '++id, title, courseTag, createdAt',
});

const STORAGE_BUCKET = 'question-images';

// --- Reactive Question Store (keeps App, Study, Library & Snipper in sync) ---
let cachedQuestions = [];
let hasLoadedOnce = false;
const listeners = new Set();

function notifyListeners() {
  for (const listener of listeners) {
    listener([...cachedQuestions]);
  }
}

function mapRowFromDb(row) {
  return {
    id: row.id,
    userId: row.user_id,
    courseTag: row.course_tag || 'General',
    referenceLabel: row.reference_label || '',
    status: row.status || 'ready',
    questionText: row.question_text || '',
    questionImagePath: row.question_image_path || null,
    questionImageUrl: row.question_image_url || null,
    solutionText: row.solution_text || '',
    solutionImagePath: row.solution_image_path || null,
    solutionImageUrl: row.solution_image_url || null,
    confidence: row.confidence || 'new',
    timesReviewed: row.times_reviewed || 0,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

export async function refreshQuestions() {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    cachedQuestions = [];
    hasLoadedOnce = true;
    notifyListeners();
    return [];
  }

  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching questions from Supabase:', error);
    return cachedQuestions;
  }

  cachedQuestions = (data || []).map(mapRowFromDb);
  hasLoadedOnce = true;
  notifyListeners();
  return cachedQuestions;
}

export function clearQuestionsCache() {
  cachedQuestions = [];
  hasLoadedOnce = false;
  notifyListeners();
}

/**
 * React hook replacing Dexie's useLiveQuery for cloud-synced questions
 */
export function useQuestions() {
  const [questions, setQuestions] = useState(() =>
    hasLoadedOnce ? cachedQuestions : []
  );
  const [loading, setLoading] = useState(!hasLoadedOnce);

  useEffect(() => {
    const handleUpdate = (next) => {
      setQuestions(next);
      setLoading(false);
    };
    listeners.add(handleUpdate);

    if (!hasLoadedOnce) {
      refreshQuestions().finally(() => setLoading(false));
    } else {
      setQuestions(cachedQuestions);
      setLoading(false);
    }

    return () => {
      listeners.delete(handleUpdate);
    };
  }, []);

  return { questions, loading, refresh: refreshQuestions };
}

// --- Image Compression & Supabase Storage Helpers ---

/**
 * Compresses any image Blob/File to WebP (0.85 quality) to save storage & mobile bandwidth
 */
export async function compressToWebP(blob, quality = 0.85) {
  if (!blob) return null;
  if (blob.type === 'image/webp' && blob.size < 180 * 1024) {
    return blob;
  }

  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const webpBlob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality)
    );
    return webpBlob || blob;
  } catch {
    return blob;
  }
}

async function uploadImageToStorage(blob) {
  if (!blob) return { path: null, url: null };

  const { data: authData } = await supabase.auth.getUser();
  const userId = authData?.user?.id;
  if (!userId) throw new Error('You must be signed in to upload images.');

  const compressed = await compressToWebP(blob, 0.85);
  const ext = compressed.type === 'image/webp' ? 'webp' : 'png';
  const filePath = `${userId}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, compressed, {
      contentType: compressed.type || 'image/webp',
      upsert: false,
    });

  if (uploadError) throw uploadError;

  const { data: publicData } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(filePath);

  return {
    path: filePath,
    url: publicData.publicUrl,
  };
}

async function removeStoragePaths(paths) {
  const valid = paths.filter(Boolean);
  if (valid.length === 0) return;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(valid);
  if (error) {
    console.warn('Could not clean up old image(s) from storage:', error.message);
  }
}

// --- Cloud Question CRUD Operations ---

/**
 * Creates a single question (with optional question/solution image Blobs)
 */
export async function addQuestion({
  courseTag = 'General',
  referenceLabel = '',
  status = 'ready',
  questionText = '',
  questionImageBlob = null,
  solutionText = '',
  solutionImageBlob = null,
  confidence = 'new',
  timesReviewed = 0,
}) {
  const [qImg, sImg] = await Promise.all([
    uploadImageToStorage(questionImageBlob),
    uploadImageToStorage(solutionImageBlob),
  ]);

  const hasQuestion = Boolean(qImg.url || questionText?.trim());

  const { data, error } = await supabase
    .from('questions')
    .insert({
      course_tag: courseTag.trim() || 'General',
      reference_label: referenceLabel || '',
      status: hasQuestion ? 'ready' : status,
      question_text: questionText || '',
      question_image_path: qImg.path,
      question_image_url: qImg.url,
      solution_text: solutionText || '',
      solution_image_path: sImg.path,
      solution_image_url: sImg.url,
      confidence,
      times_reviewed: timesReviewed,
    })
    .select()
    .single();

  if (error) throw error;

  const mapped = mapRowFromDb(data);
  cachedQuestions = [mapped, ...cachedQuestions];
  notifyListeners();
  return mapped;
}

/**
 * Batch-creates draft slots from a parsed syllabus problem list
 */
export async function queueDraftQuestions({ courseTag, labels }) {
  if (!labels || labels.length === 0) return [];

  const rows = labels.map((label) => ({
    course_tag: (courseTag || 'General').trim() || 'General',
    reference_label: label,
    status: 'draft',
    question_text: '',
    solution_text: '',
    confidence: 'new',
    times_reviewed: 0,
  }));

  const { data, error } = await supabase
    .from('questions')
    .insert(rows)
    .select();

  if (error) throw error;

  const mapped = (data || []).map(mapRowFromDb);
  cachedQuestions = [...mapped.reverse(), ...cachedQuestions];
  notifyListeners();
  return mapped;
}

/**
 * Attaches a cropped/pasted image Blob or text to 'question' or 'solution'
 * and cleans up any replaced image from Supabase Storage.
 */
export async function updateQuestionSlot(
  id,
  slot,
  { imageBlob = undefined, text = undefined }
) {
  const existing = cachedQuestions.find((q) => q.id === id);
  const updates = {};
  let oldPathToDelete = null;

  if (slot === 'question') {
    if (imageBlob !== undefined) {
      if (imageBlob === null) {
        oldPathToDelete = existing?.questionImagePath || null;
        updates.question_image_path = null;
        updates.question_image_url = null;
      } else {
        const uploaded = await uploadImageToStorage(imageBlob);
        oldPathToDelete = existing?.questionImagePath || null;
        updates.question_image_path = uploaded.path;
        updates.question_image_url = uploaded.url;
      }
    }
    if (text !== undefined) {
      updates.question_text = text;
    }
  } else if (slot === 'solution') {
    if (imageBlob !== undefined) {
      if (imageBlob === null) {
        oldPathToDelete = existing?.solutionImagePath || null;
        updates.solution_image_path = null;
        updates.solution_image_url = null;
      } else {
        const uploaded = await uploadImageToStorage(imageBlob);
        oldPathToDelete = existing?.solutionImagePath || null;
        updates.solution_image_path = uploaded.path;
        updates.solution_image_url = uploaded.url;
      }
    }
    if (text !== undefined) {
      updates.solution_text = text;
    }
  }

  const nextQuestionUrl =
    updates.question_image_url !== undefined
      ? updates.question_image_url
      : existing?.questionImageUrl;
  const nextQuestionText =
    updates.question_text !== undefined
      ? updates.question_text
      : existing?.questionText;

  if (nextQuestionUrl || nextQuestionText?.trim()) {
    updates.status = 'ready';
  }

  const { data, error } = await supabase
    .from('questions')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  if (oldPathToDelete) {
    await removeStoragePaths([oldPathToDelete]);
  }

  const mapped = mapRowFromDb(data);
  cachedQuestions = cachedQuestions.map((q) => (q.id === id ? mapped : q));
  notifyListeners();
  return mapped;
}

/**
 * Updates metadata fields like confidence rating, timesReviewed, or status
 */
export async function updateQuestionMeta(id, fields) {
  const dbUpdates = {};
  if (fields.courseTag !== undefined) dbUpdates.course_tag = fields.courseTag;
  if (fields.referenceLabel !== undefined)
    dbUpdates.reference_label = fields.referenceLabel;
  if (fields.status !== undefined) dbUpdates.status = fields.status;
  if (fields.confidence !== undefined) dbUpdates.confidence = fields.confidence;
  if (fields.timesReviewed !== undefined)
    dbUpdates.times_reviewed = fields.timesReviewed;

  const { data, error } = await supabase
    .from('questions')
    .update(dbUpdates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  const mapped = mapRowFromDb(data);
  cachedQuestions = cachedQuestions.map((q) => (q.id === id ? mapped : q));
  notifyListeners();
  return mapped;
}

/**
 * Updates an existing question's metadata, text, and/or images in Supabase
 */
export async function updateQuestion(
  id,
  {
    courseTag,
    referenceLabel,
    questionText,
    questionImageBlob,
    clearQuestionImage = false,
    solutionText,
    solutionImageBlob,
    clearSolutionImage = false,
  }
) {
  const existing = cachedQuestions.find((q) => q.id === id);
  const dbUpdates = {};
  const oldPathsToDelete = [];

  if (courseTag !== undefined) {
    dbUpdates.course_tag = courseTag.trim() || 'General';
  }
  if (referenceLabel !== undefined) {
    dbUpdates.reference_label = referenceLabel.trim();
  }
  if (questionText !== undefined) {
    dbUpdates.question_text = questionText;
  }
  if (solutionText !== undefined) {
    dbUpdates.solution_text = solutionText;
  }

  if (clearQuestionImage) {
    if (existing?.questionImagePath) {
      oldPathsToDelete.push(existing.questionImagePath);
    }
    dbUpdates.question_image_path = null;
    dbUpdates.question_image_url = null;
  } else if (questionImageBlob) {
    if (existing?.questionImagePath) {
      oldPathsToDelete.push(existing.questionImagePath);
    }
    const qImg = await uploadImageToStorage(questionImageBlob);
    dbUpdates.question_image_path = qImg.path;
    dbUpdates.question_image_url = qImg.url;
  }

  if (clearSolutionImage) {
    if (existing?.solutionImagePath) {
      oldPathsToDelete.push(existing.solutionImagePath);
    }
    dbUpdates.solution_image_path = null;
    dbUpdates.solution_image_url = null;
  } else if (solutionImageBlob) {
    if (existing?.solutionImagePath) {
      oldPathsToDelete.push(existing.solutionImagePath);
    }
    const sImg = await uploadImageToStorage(solutionImageBlob);
    dbUpdates.solution_image_path = sImg.path;
    dbUpdates.solution_image_url = sImg.url;
  }

  const finalQuestionText =
    dbUpdates.question_text !== undefined
      ? dbUpdates.question_text
      : existing?.questionText || '';
  const finalQuestionImageUrl =
    dbUpdates.question_image_url !== undefined
      ? dbUpdates.question_image_url
      : existing?.questionImageUrl || null;

  dbUpdates.status =
    finalQuestionImageUrl || finalQuestionText.trim() ? 'ready' : 'draft';

  const { data, error } = await supabase
    .from('questions')
    .update(dbUpdates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  if (oldPathsToDelete.length > 0) {
    await removeStoragePaths(oldPathsToDelete);
  }

  const mapped = mapRowFromDb(data);
  cachedQuestions = cachedQuestions.map((q) => (q.id === id ? mapped : q));
  notifyListeners();
  return mapped;
}

/**
 * Deletes a question row and removes its associated WebP images from Storage
 */
export async function deleteQuestion(id) {
  const existing = cachedQuestions.find((q) => q.id === id);

  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) throw error;

  if (existing) {
    await removeStoragePaths([
      existing.questionImagePath,
      existing.solutionImagePath,
    ]);
  }

  cachedQuestions = cachedQuestions.filter((q) => q.id !== id);
  notifyListeners();
}