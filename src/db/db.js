import Dexie from 'dexie';

export const db = new Dexie('InterleavedStudyDB');

db.version(1).stores({
  // Stores uploaded textbook and solution manual PDFs
  textbooks: '++id, title, courseTag, createdAt',
  
  // Stores both draft (queued from textbook list) and ready questions
  // status: 'draft' | 'ready'
  // confidence: 'new' | 'again' | 'hard' | 'good'
  questions: '++id, courseTag, textbookId, status, confidence, createdAt'
});

/**
 * Helper to create a batch of draft questions from a parsed problem list
 */
export async function queueDraftQuestions({ courseTag, textbookId = null, labels }) {
  const now = Date.now();
  const records = labels.map((label) => ({
    courseTag: courseTag.trim() || 'General',
    textbookId,
    referenceLabel: label,
    status: 'draft',
    questionText: '',
    questionImageBlob: null,
    solutionText: '',
    solutionImageBlob: null,
    confidence: 'new',
    timesReviewed: 0,
    createdAt: now,
  }));

  return await db.questions.bulkAdd(records);
}

/**
 * Attaches a cropped image Blob (or text) to either the 'question' or 'solution' slot
 * and automatically marks the card 'ready' once at least the question is populated.
 */
export async function updateQuestionSlot(id, slot, { imageBlob = undefined, text = undefined }) {
  const existing = await db.questions.get(id);
  if (!existing) return;

  const updates = {};
  if (slot === 'question') {
    if (imageBlob !== undefined) updates.questionImageBlob = imageBlob;
    if (text !== undefined) updates.questionText = text;
  } else if (slot === 'solution') {
    if (imageBlob !== undefined) updates.solutionImageBlob = imageBlob;
    if (text !== undefined) updates.solutionText = text;
  }

  const hasQuestion =
    (updates.questionImageBlob ?? existing.questionImageBlob) ||
    (updates.questionText ?? existing.questionText)?.trim();

  if (hasQuestion) {
    updates.status = 'ready';
  }

  return await db.questions.update(id, updates);
}