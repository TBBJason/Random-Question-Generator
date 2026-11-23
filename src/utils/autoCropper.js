import { pdfjsLib } from './pdfConfig';

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds acceptable numbering variants for a problem inside a chapter.
 * Example: chapter "3", problemNumber "4" -> canonical "4", variants ["4", "3.4"]
 */
function buildTargetLookup(chapter, problemNumbers) {
  const variantToCanonical = new Map();
  const allVariants = [];

  for (const raw of problemNumbers) {
    const clean = String(raw).trim();
    if (!clean) continue;

    variantToCanonical.set(clean, clean);
    allVariants.push(clean);

    if (chapter && !clean.includes('.')) {
      const prefixed = `${chapter}.${clean}`;
      variantToCanonical.set(prefixed, clean);
      allVariants.push(prefixed);
    }
  }

  return { variantToCanonical, allVariants };
}

/**
 * Finds the starting page of the back-of-book Answers / Solutions section
 * inside a full textbook PDF.
 */
async function locateSolutionsDividerPage(pdfDoc) {
  const numPages = pdfDoc.numPages;
  // Back-of-book solutions always appear in the second half of a textbook
  const earliestSearchPage = Math.max(1, Math.floor(numPages * 0.45));

  const strongHeaderRegex =
    /^(?:answers?\s+to\s+(?:selected\s+|odd[- ]numbered\s+)?(?:exercises?|problems?|review)|solutions?\s+to\s+(?:selected\s+|odd[- ]numbered\s+)?(?:exercises?|problems?)|answer\s+key|answers?|solutions?)\b/i;

  let bestDividerPage = null;
  let bestScore = 0;

  for (let pageNum = earliestSearchPage; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const strings = textContent.items.map((it) => it.str.trim()).filter(Boolean);
    const fullText = strings.join(' ');

    let score = 0;

    // Check top lines of the page for a major Solutions / Answers section title
    const topSlice = strings.slice(0, 12).join(' ');
    if (strongHeaderRegex.test(topSlice)) {
      score += 25;
    } else if (
      /\b(?:answers?\s+to\s+(?:selected|odd)|solutions?\s+to\s+(?:selected|odd)|answers?\s+and\s+solutions?)\b/i.test(
        fullText
      )
    ) {
      score += 18;
    }

    // Back-of-book answer pages typically start with Chapter 1 / Section 1.1 answers
    if (/\b(?:chapter|ch\.?)\s*1\b/i.test(fullText) && score > 0) {
      score += 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestDividerPage = pageNum;
    }
  }

  // Fallback: if the divider title was an unsearchable graphic, start at the last 35% of the PDF
  return bestDividerPage || Math.max(1, Math.floor(numPages * 0.65));
}

/**
 * Public helper so the UI can jump directly to the back-of-book Solutions page
 */
export async function findSolutionsStartPage(pdfBlob) {
  if (!pdfBlob) return 1;
  const arrayBuffer = await pdfBlob.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;
  try {
    return await locateSolutionsDividerPage(pdfDoc);
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Scans ONLY the back-of-book Solutions section (from the Solutions divider page to the end
 * of the textbook) to locate the target Chapter's answer pages.
 */
async function findBackOfBookSolutionsPages(
  pdfDoc,
  { chapter, problemNumbers, startPageHint = null, maxPages = 5 }
) {
  const numPages = pdfDoc.numPages;

  if (startPageHint && startPageHint >= 1 && startPageHint <= numPages) {
    const pages = [];
    for (
      let p = startPageHint;
      p <= Math.min(numPages, startPageHint + maxPages - 1);
      p++
    ) {
      pages.push(p);
    }
    return pages;
  }

  const solutionsStart = await locateSolutionsDividerPage(pdfDoc);
  const { allVariants } = buildTargetLookup(chapter, problemNumbers);
  const variantSet = new Set(allVariants);

  const chapterHeaderRegex = chapter
    ? new RegExp(
        `(?:^|\\s)(?:chapter|ch\\.?|section|sec\\.?)\\s*${escapeRegExp(chapter)}\\b|(?:^|\\s)${escapeRegExp(chapter)}\\.\\d+\\b`,
        'i'
      )
    : null;
  const nextChapterNum =
    chapter && /^\d+$/.test(chapter) ? String(Number(chapter) + 1) : null;
  const nextChapterRegex = nextChapterNum
    ? new RegExp(
        `(?:^|\\s)(?:chapter|ch\\.?|section|sec\\.?)\\s*${escapeRegExp(nextChapterNum)}\\b|(?:^|\\s)${escapeRegExp(nextChapterNum)}\\.\\d+\\b`,
        'i'
      )
    : null;

  const pageMeta = [];
  let inTargetChapter = false;

  for (let pageNum = solutionsStart; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const strings = textContent.items.map((it) => it.str.trim()).filter(Boolean);
    const fullText = strings.join(' ');

    if (chapterHeaderRegex && chapterHeaderRegex.test(fullText)) {
      inTargetChapter = true;
    } else if (
      inTargetChapter &&
      nextChapterRegex &&
      nextChapterRegex.test(fullText) &&
      !(chapterHeaderRegex && chapterHeaderRegex.test(fullText))
    ) {
      inTargetChapter = false;
    }

    const matchedTargets = new Set();
    let answerNumberCount = 0;

    for (const s of strings) {
      const m = s.match(/^(\d{1,3}(?:\.\d{1,3})?)[a-zA-Z]?[\.\)\:]?$/);
      if (!m) continue;
      answerNumberCount++;
      if (variantSet.has(m[1])) {
        matchedTargets.add(m[1]);
      }
    }

    let score = 0;
    if (chapterHeaderRegex && chapterHeaderRegex.test(fullText)) score += 22;
    if (inTargetChapter) score += 14;
    if (answerNumberCount >= 5) score += 6;
    score += matchedTargets.size * 6;

    pageMeta.push({
      pageNum,
      score,
      matchedCount: matchedTargets.size,
      inTargetChapter,
    });
  }

  const sorted = [...pageMeta].sort((a, b) => b.score - a.score);
  const relevant = sorted.filter((p) => p.score > 0);
  const pool = relevant.length > 0 ? relevant : sorted;

  const selectedSet = new Set();
  for (const cand of pool) {
    if (selectedSet.size >= maxPages) break;
    if (cand.score <= 0 && selectedSet.size > 0) break;
    selectedSet.add(cand.pageNum);
  }

  if (selectedSet.size === 0) {
    selectedSet.add(solutionsStart);
  }

  return Array.from(selectedSet).sort((a, b) => a - b);
}

/**
 * Scans a PDF's text layer to find the Exercises/Problems pages (or separate Solutions PDF pages),
 * actively penalizing body pages full of "Figure 3.4", "Example 3.5", etc.
 */
async function findCandidatePages(
  pdfDoc,
  { chapter, problemNumbers, startPageHint = null, maxPages = 5, stopBeforeBackSolutions = false }
) {
  const numPages = pdfDoc.numPages;

  if (startPageHint && startPageHint >= 1 && startPageHint <= numPages) {
    const pages = [];
    for (
      let p = startPageHint;
      p <= Math.min(numPages, startPageHint + maxPages - 1);
      p++
    ) {
      pages.push(p);
    }
    return pages;
  }

  // When searching the main textbook for QUESTIONS, stop before the back-of-book Solutions section
  const maxSearchPage = stopBeforeBackSolutions
    ? Math.max(1, (await locateSolutionsDividerPage(pdfDoc)) - 1)
    : numPages;

  const { allVariants } = buildTargetLookup(chapter, problemNumbers);
  const variantSet = new Set(allVariants);

  const chapterStartRegex = chapter
    ? new RegExp(`(?:chapter|ch\\.?)\\s*${escapeRegExp(chapter)}\\b`, 'i')
    : null;
  const nextChapterNum =
    chapter && /^\d+$/.test(chapter) ? String(Number(chapter) + 1) : null;
  const nextChapterRegex = nextChapterNum
    ? new RegExp(`(?:chapter|ch\\.?)\\s*${escapeRegExp(nextChapterNum)}\\b`, 'i')
    : null;

  const exerciseHeaderRegex =
    /\b(?:exercises?|problems?|review\s+exercises?|practice\s+problems?|homework\s+problems?|solutions?|answers?)\b/i;
  const nonExerciseCalloutRegex =
    /\b(?:figure|fig\.?|table|example|ex\.?|theorem|lemma|corollary|definition|def\.?|section|sec\.?|eq\.?|equation)\s*\d+(?:\.\d+)?/gi;
  const tocRegex = /\btable\s+of\s+contents\b|\.{5,}/i;

  const pageMeta = [];
  let chapterStartPage = null;
  let nextChapterPage = null;

  for (let pageNum = 1; pageNum <= maxSearchPage; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const strings = textContent.items.map((item) => item.str.trim()).filter(Boolean);
    const fullText = strings.join(' ');

    if (tocRegex.test(fullText) && pageNum < Math.min(25, numPages * 0.1)) {
      pageMeta.push({ pageNum, score: -20, matchedCount: 0, hasExerciseHeader: false });
      continue;
    }

    if (chapterStartRegex && !chapterStartPage && chapterStartRegex.test(fullText)) {
      chapterStartPage = pageNum;
    } else if (
      chapterStartPage &&
      nextChapterRegex &&
      !nextChapterPage &&
      pageNum > chapterStartPage + 1 &&
      nextChapterRegex.test(fullText)
    ) {
      nextChapterPage = pageNum;
    }

    const hasExerciseHeader = exerciseHeaderRegex.test(fullText);
    const calloutMatches = fullText.match(nonExerciseCalloutRegex) || [];

    const scrubbedText = fullText.replace(nonExerciseCalloutRegex, ' ');
    const tokens = scrubbedText.split(/\s+/);

    const matchedTargets = new Set();
    let exerciseListDensity = 0;

    for (const tok of tokens) {
      const m = tok.match(/^(\d{1,3}(?:\.\d{1,3})?)[a-zA-Z]?[\.\)\:]?$/);
      if (!m) continue;
      const numStr = m[1];
      exerciseListDensity++;
      if (variantSet.has(numStr)) {
        matchedTargets.add(numStr);
      }
    }

    let score = 0;
    if (hasExerciseHeader) score += 18;
    if (exerciseListDensity >= 6) score += 8;
    score += matchedTargets.size * 6;

    if (!hasExerciseHeader && calloutMatches.length >= 2) {
      score -= calloutMatches.length * 4;
    }

    pageMeta.push({
      pageNum,
      score,
      matchedCount: matchedTargets.size,
      hasExerciseHeader,
    });
  }

  if (chapterStartPage) {
    const endBound = nextChapterPage || Math.min(maxSearchPage, chapterStartPage + 60);
    const span = Math.max(1, endBound - chapterStartPage);

    for (const pm of pageMeta) {
      if (pm.pageNum >= chapterStartPage && pm.pageNum <= endBound) {
        pm.score += 8;
        const progressInChapter = (pm.pageNum - chapterStartPage) / span;
        if (progressInChapter >= 0.65) {
          pm.score += 8;
        }
      }
    }
  }

  const sorted = [...pageMeta].sort((a, b) => b.score - a.score);
  const exercisePages = sorted.filter(
    (p) => p.score > 0 && (p.hasExerciseHeader || p.matchedCount > 0)
  );
  const pool = exercisePages.length > 0 ? exercisePages : sorted;

  const selectedSet = new Set();
  for (const candidate of pool) {
    if (selectedSet.size >= maxPages) break;
    if (candidate.score <= 0 && selectedSet.size > 0) break;
    selectedSet.add(candidate.pageNum);
  }

  if (selectedSet.size === 0 && sorted[0]) {
    selectedSet.add(sorted[0].pageNum);
  }

  return Array.from(selectedSet).sort((a, b) => a - b);
}

/**
 * Renders a PDF page onto a high-DPI offscreen canvas, captures pixel buffer for
 * connected-ink edge snapping, and prepares a crisp JPEG for Vision-LLM inspection.
 */
async function renderPageForDetection(pdfDoc, pageNum, scale = 2.0) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const jpegBase64 = jpegDataUrl.split(',')[1];

  return { pageNum, page, viewport, canvas, imageData, jpegBase64 };
}

/**
 * Extracts reconstructed visual lines, N-column layout boundaries (1, 2, or 3+ columns),
 * problem anchors, and section-divider headers from a rendered PDF page.
 */
async function extractPageLayout(rp, { chapter = '', problemNumbers = [] } = {}) {
  const { page, viewport } = rp;
  const textContent = await page.getTextContent();
  const { variantToCanonical, allVariants } = buildTargetLookup(chapter, problemNumbers);
  const variantSet = new Set(allVariants);

  const nonExerciseLinePrefix =
    /^(?:figure|fig\.?|table|example|ex\.?|theorem|lemma|corollary|definition|def\.?|proof|remark|note)\b/i;
  const sectionDividerRegex =
    /^(?:chapter|ch\.?|section|sec\.?|exercises?|problems?|review\s+exercises?|in\s+exercises?|for\s+exercises?)\b/i;

  const rawItems = textContent.items
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const [vx, vy] = viewport.convertToViewportPoint(
        it.transform[4],
        it.transform[5]
      );
      const fontHeight = Math.max(10, (it.height || 12) * viewport.scale);
      return {
        str: it.str.trim(),
        x: vx,
        y: vy,
        topY: vy - fontHeight,
        bottomY: vy + fontHeight * 0.35,
        rightX: vx + Math.max(10, (it.width || 8) * viewport.scale),
      };
    })
    .filter(
      (it) => it.topY > viewport.height * 0.04 && it.bottomY < viewport.height * 0.96
    );

  if (rawItems.length === 0) {
    return {
      lines: [],
      anchors: [],
      dividers: [],
      colBounds: [{ minX: 0, maxX: viewport.width }],
      variantToCanonical,
    };
  }

  // 1. Discover column left-margins dynamically (handles 1, 2, or 3-column layouts)
  const numberStarts = rawItems.filter((it) =>
    /^(?:\d{1,3}(?:\.\d{1,3})?)[a-zA-Z]?(?:[\.\)\:]|$)/.test(it.str)
  );

  const xBuckets = [];
  for (const item of numberStarts) {
    const existing = xBuckets.find((b) => Math.abs(b.avgX - item.x) <= 26);
    if (existing) {
      existing.items.push(item);
      existing.avgX =
        existing.items.reduce((s, x) => s + x.x, 0) / existing.items.length;
    } else {
      xBuckets.push({ avgX: item.x, items: [item] });
    }
  }

  const validColumns = xBuckets
    .filter((b) => b.items.length >= 2)
    .sort((a, b) => a.avgX - b.avgX);

  const colBounds =
    validColumns.length > 0
      ? validColumns.map((col, idx) => ({
          marginX: col.avgX,
          minX: idx === 0 ? 0 : col.avgX - 16,
          maxX:
            idx < validColumns.length - 1
              ? validColumns[idx + 1].avgX - 14
              : viewport.width * 0.97,
        }))
      : [{ marginX: viewport.width * 0.06, minX: 0, maxX: viewport.width * 0.97 }];

  const getColIndex = (x) => {
    for (let i = colBounds.length - 1; i >= 0; i--) {
      if (x >= colBounds[i].minX) return i;
    }
    return 0;
  };

  // 2. Reconstruct full visual lines within each column
  const lines = [];
  for (let col = 0; col < colBounds.length; col++) {
    const colItems = rawItems
      .filter((it) => getColIndex(it.x) === col)
      .sort((a, b) => (Math.abs(a.y - b.y) <= 3.5 ? a.x - b.x : a.y - b.y));

    for (const it of colItems) {
      const lastLine = lines[lines.length - 1];
      if (
        lastLine &&
        lastLine.col === col &&
        Math.abs(lastLine.y - it.y) <= 3.5 &&
        it.x - lastLine.rightX < 45
      ) {
        lastLine.text += ` ${it.str}`;
        lastLine.rightX = Math.max(lastLine.rightX, it.rightX);
        lastLine.topY = Math.min(lastLine.topY, it.topY);
        lastLine.bottomY = Math.max(lastLine.bottomY, it.bottomY);
      } else {
        lines.push({
          col,
          x: it.x,
          y: it.y,
          topY: it.topY,
          bottomY: it.bottomY,
          rightX: it.rightX,
          text: it.str,
        });
      }
    }
  }

  // 3. Extract aligned problem anchors & section dividers per column
  const anchors = [];
  const dividers = [];

  for (const line of lines) {
    if (sectionDividerRegex.test(line.text)) {
      dividers.push({ col: line.col, topY: line.topY, text: line.text });
      continue;
    }
    if (nonExerciseLinePrefix.test(line.text)) continue;

    const match = line.text.match(
      /^(\d{1,3}(?:\.\d{1,3})?)[a-zA-Z]?(?:[\.\)\:]\s+|\s+(?=[A-Za-z\(\[\\$\-\d])|$)/
    );
    if (!match) continue;

    const token = match[1];
    const trailingPart = token.includes('.') ? token.split('.')[1] : token;
    const numVal = parseInt(trailingPart, 10);
    if (numVal <= 0 || numVal > 300) continue;

    const colMargin = colBounds[line.col]?.marginX ?? line.x;
    if (Math.abs(line.x - colMargin) <= 18 || variantSet.has(token)) {
      anchors.push({
        numToken: token,
        canonical: variantToCanonical.get(token) || null,
        x: line.x,
        topY: line.topY,
        bottomY: line.bottomY,
        col: line.col,
      });
    }
  }

  anchors.sort((a, b) => (a.col !== b.col ? a.col - b.col : a.topY - b.topY));

  return { lines, anchors, dividers, colBounds, variantToCanonical };
}

/**
 * CONNECTED-INK EDGE SNAPPER:
 * Expands outward if non-white ink touches a crop border (preventing clipped fraction bars
 * or diagrams) without crossing minTopNorm / maxBottomNorm guardrails.
 */
function snapBoxToInk(
  imageData,
  normRect,
  { minTopNorm = 0.02, maxBottomNorm = 0.97 } = {}
) {
  const { width: W, height: H, data } = imageData;

  const isDarkPixel = (x, y) => {
    const idx = (y * W + x) * 4;
    return data[idx] < 232 || data[idx + 1] < 232 || data[idx + 2] < 232;
  };

  const rowHasInk = (y, x1, x2) => {
    if (y < 0 || y >= H) return false;
    let darkCount = 0;
    for (let x = x1; x <= x2; x += 2) {
      if (isDarkPixel(x, y)) {
        darkCount++;
        if (darkCount >= 2) return true;
      }
    }
    return false;
  };

  const colHasInk = (x, y1, y2) => {
    if (x < 0 || x >= W) return false;
    let darkCount = 0;
    for (let y = y1; y <= y2; y += 2) {
      if (isDarkPixel(x, y)) {
        darkCount++;
        if (darkCount >= 2) return true;
      }
    }
    return false;
  };

  const hardMinY = Math.max(2, Math.floor(minTopNorm * H));
  const hardMaxY = Math.min(H - 3, Math.floor(maxBottomNorm * H));

  let x1 = Math.max(2, Math.floor(normRect.x * W));
  let y1 = Math.max(hardMinY, Math.floor(normRect.y * H));
  let x2 = Math.min(W - 3, Math.ceil((normRect.x + normRect.width) * W));
  let y2 = Math.min(hardMaxY, Math.ceil((normRect.y + normRect.height) * H));

  if (x2 <= x1 + 10 || y2 <= y1 + 10) return normRect;

  let whiteStreak = 0;
  const minY = Math.max(hardMinY, y1 - Math.floor(H * 0.035));
  while (y1 > minY && whiteStreak < 5) {
    if (rowHasInk(y1 - 1, x1, x2)) {
      whiteStreak = 0;
      y1--;
    } else {
      whiteStreak++;
      y1--;
    }
  }

  whiteStreak = 0;
  const maxY = Math.min(hardMaxY, y2 + Math.floor(H * 0.065));
  while (y2 < maxY && whiteStreak < 8) {
    if (rowHasInk(y2 + 1, x1, x2)) {
      whiteStreak = 0;
      y2++;
    } else {
      whiteStreak++;
      y2++;
    }
  }

  whiteStreak = 0;
  const minX = Math.max(2, x1 - Math.floor(W * 0.03));
  while (x1 > minX && whiteStreak < 5) {
    if (colHasInk(x1 - 1, y1, y2)) {
      whiteStreak = 0;
      x1--;
    } else {
      whiteStreak++;
      x1--;
    }
  }

  whiteStreak = 0;
  const maxX = Math.min(W - 3, x2 + Math.floor(W * 0.04));
  while (x2 < maxX && whiteStreak < 6) {
    if (colHasInk(x2 + 1, y1, y2)) {
      whiteStreak = 0;
      x2++;
    } else {
      whiteStreak++;
      x2++;
    }
  }

  while (y1 < y2 - 20 && !rowHasInk(y1, x1, x2)) y1++;
  while (y2 > y1 + 20 && !rowHasInk(y2, x1, x2)) y2--;
  while (x1 < x2 - 20 && !colHasInk(x1, y1, y2)) x1++;
  while (x2 > x1 + 20 && !colHasInk(x2, y1, y2)) x2--;

  const padX = Math.floor(W * 0.01);
  const padY = Math.floor(H * 0.008);

  x1 = Math.max(0, x1 - padX);
  y1 = Math.max(hardMinY, y1 - padY);
  x2 = Math.min(W, x2 + padX);
  y2 = Math.min(hardMaxY, y2 + padY);

  return {
    x: x1 / W,
    y: y1 / H,
    width: (x2 - x1) / W,
    height: (y2 - y1) / H,
  };
}

async function cropCanvasNormalized(canvas, normRect) {
  const srcX = Math.max(0, Math.floor(normRect.x * canvas.width));
  const srcY = Math.max(0, Math.floor(normRect.y * canvas.height));
  const srcW = Math.max(
    12,
    Math.min(canvas.width - srcX, Math.floor(normRect.width * canvas.width))
  );
  const srcH = Math.max(
    12,
    Math.min(canvas.height - srcY, Math.floor(normRect.height * canvas.height))
  );

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = srcW;
  cropCanvas.height = srcH;
  const ctx = cropCanvas.getContext('2d');
  ctx.drawImage(canvas, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

  return await new Promise((resolve) => cropCanvas.toBlob(resolve, 'image/png'));
}

async function querySinglePageVision({ rp, promptText, cleanKey }) {
  let rawText = '';

  if (cleanKey.startsWith('sk-or-')) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cleanKey}`,
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        temperature: 0.1,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${rp.jpegBase64}` },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OpenRouter error (${res.status}): ${err.slice(0, 120)}`);
    }
    const data = await res.json();
    rawText = data?.choices?.[0]?.message?.content || '';
  } else if (cleanKey.startsWith('sk-ant-')) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cleanKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: rp.jpegBase64,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Anthropic error (${res.status}): ${err.slice(0, 120)}`);
    }
    const data = await res.json();
    rawText = data?.content?.[0]?.text || '';
  } else if (cleanKey.startsWith('sk-')) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cleanKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        temperature: 0.1,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${rp.jpegBase64}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OpenAI error (${res.status}): ${err.slice(0, 120)}`);
    }
    const data = await res.json();
    rawText = data?.choices?.[0]?.message?.content || '';
  } else {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(cleanKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: promptText },
                {
                  inlineData: {
                    mimeType: 'image/jpeg',
                    data: rp.jpegBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Gemini API error (${res.status}): ${err.slice(0, 120)}`);
    }
    const data = await res.json();
    rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (!rawText) return [];
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  return Array.isArray(parsed.detections) ? parsed.detections : [];
}

/**
 * PRIMARY ENGINE: Per-Page Vision-LLM clamped by exact pdf.js Problem Anchors + Ink Snapping
 */
async function detectWithVisionLLM({
  renderedPages,
  problemNumbers,
  chapter,
  mode,
  apiKey,
  onProgress = () => {},
}) {
  const cleanKey = (apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('No API key configured');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Browser is offline');
  }

  const { variantToCanonical } = buildTargetLookup(chapter, problemNumbers);
  const results = new Map();
  const remainingCanonical = new Set(problemNumbers.map((n) => n.trim()));

  for (let idx = 0; idx < renderedPages.length; idx++) {
    if (remainingCanonical.size === 0) break;
    const rp = renderedPages[idx];
    const layout = await extractPageLayout(rp, { chapter, problemNumbers });

    const targetLabels = [];
    for (const cNum of remainingCanonical) {
      targetLabels.push(
        chapter && !cNum.includes('.') ? `${cNum} (or ${chapter}.${cNum})` : cNum
      );
    }

    onProgress(
      `Vision AI scanning ${mode} page ${rp.pageNum} (${idx + 1}/${renderedPages.length})...`
    );

    const promptText = `You are a precision textbook layout detector.
Inspect this page and locate ONLY numbered ${mode === 'solution' ? 'SOLUTIONS / ANSWERS' : 'END-OF-CHAPTER / END-OF-SECTION EXERCISES or PROBLEMS'}${chapter ? ` for Chapter ${chapter}` : ''}.
Target problem numbers: ${JSON.stringify(targetLabels)}

CRITICAL EXCLUSION RULES:
- NEVER select "Figure ${chapter ? chapter + '.' : ''}X", "Fig. X", "Table X", "Example X", "Theorem X", "Section X", or equation numbers "(X)" from chapter reading prose!
- If this page is regular chapter reading prose and does NOT contain numbered Exercises/Problems/Solutions, return {"detections": []}.
- Return "problemNumber" using the exact label printed on the item (e.g. "${chapter ? chapter + '.4' : '4'}" or "4").
- Return "box_2d" as [ymin, xmin, ymax, xmax] normalized from 0 to 1000, tightly enclosing the ENTIRE ${mode === 'solution' ? 'solution/answer (including multi-line derivations, final answers, and graphs)' : 'exercise prompt (including all sub-parts a, b, c and any diagram belonging to that exercise)'}, stopping strictly BEFORE the next problem number begins.

Respond strictly with valid JSON:
{
  "detections": [
    {
      "problemNumber": "${chapter ? chapter + '.4' : '4'}",
      "startText": "${chapter ? chapter + '.4' : '4.'} ...",
      "box_2d": [120, 75, 285, 490]
    }
  ]
}`;

    const detections = await querySinglePageVision({ rp, promptText, cleanKey });

    for (const det of detections) {
      const rawLabel = String(det.problemNumber || '').trim();
      const canonical =
        variantToCanonical.get(rawLabel) ||
        (chapter && rawLabel.startsWith(`${chapter}.`)
          ? variantToCanonical.get(rawLabel.slice(chapter.length + 1))
          : null);

      if (!canonical || !remainingCanonical.has(canonical)) continue;
      if (!Array.isArray(det.box_2d) || det.box_2d.length !== 4) continue;

      const [ymin, xmin, ymax, xmax] = det.box_2d.map(Number);
      if ([ymin, xmin, ymax, xmax].some(Number.isNaN) || ymax <= ymin || xmax <= xmin) {
        continue;
      }

      let rawNormRect = {
        x: Math.max(0, xmin / 1000),
        y: Math.max(0, ymin / 1000),
        width: Math.min(1, (xmax - xmin) / 1000),
        height: Math.min(1, (ymax - ymin) / 1000),
      };

      // Cross-check VLM box against exact pdf.js anchor coordinates so it never cuts off
      // the top problem number or bleeds into the next problem below!
      let minTopNorm = 0.03;
      let maxBottomNorm = 0.96;
      const anchorIdx = layout.anchors.findIndex((a) => a.canonical === canonical);
      if (anchorIdx !== -1) {
        const curAnchor = layout.anchors[anchorIdx];
        const anchorTopNorm = Math.max(0.02, (curAnchor.topY - 6) / rp.viewport.height);
        minTopNorm = anchorTopNorm;
        if (rawNormRect.y > anchorTopNorm + 0.01) {
          const bottomBefore = rawNormRect.y + rawNormRect.height;
          rawNormRect.y = anchorTopNorm;
          rawNormRect.height = Math.max(0.02, bottomBefore - anchorTopNorm);
        }

        const nextAnchor = layout.anchors
          .slice(anchorIdx + 1)
          .find((a) => a.col === curAnchor.col && a.topY > curAnchor.topY + 12);

        if (nextAnchor) {
          maxBottomNorm = Math.min(0.96, (nextAnchor.topY - 4) / rp.viewport.height);
          if (rawNormRect.y + rawNormRect.height > maxBottomNorm) {
            rawNormRect.height = Math.max(0.02, maxBottomNorm - rawNormRect.y);
          }
        }
      }

      const snappedRect = snapBoxToInk(rp.imageData, rawNormRect, {
        minTopNorm,
        maxBottomNorm,
      });
      const blob = await cropCanvasNormalized(rp.canvas, snappedRect);

      if (blob) {
        results.set(canonical, {
          pageNumber: rp.pageNum,
          normRect: snappedRect,
          blob,
          method: 'vision-llm',
        });
        remainingCanonical.delete(canonical);
      }
    }
  }

  return results;
}

/**
 * OFFLINE ENGINE: N-Column Line-Reconstructed Text Cropper + Ink Edge Snapping
 */
async function detectWithLocalHeuristic({ renderedPages, problemNumbers, chapter = '' }) {
  const results = new Map();

  for (const rp of renderedPages) {
    const { viewport, canvas, imageData, pageNum } = rp;
    const { lines, anchors, dividers, colBounds } = await extractPageLayout(rp, {
      chapter,
      problemNumbers,
    });

    for (let i = 0; i < anchors.length; i++) {
      const current = anchors[i];
      if (!current.canonical || results.has(current.canonical)) continue;

      let nextInCol = null;
      let nextRightSameRow = null;

      for (let j = i + 1; j < anchors.length; j++) {
        const cand = anchors[j];
        if (cand.col !== current.col) continue;

        if (Math.abs(cand.topY - current.topY) <= 10 && cand.x > current.x + 25) {
          if (!nextRightSameRow || cand.x < nextRightSameRow.x) {
            nextRightSameRow = cand;
          }
        } else if (cand.topY > current.topY + 12) {
          nextInCol = cand;
          break;
        }
      }

      // Also check for section/chapter headers below current item in the same column
      const nextDivider = dividers
        .filter((d) => d.col === current.col && d.topY > current.topY + 12)
        .sort((a, b) => a.topY - b.topY)[0];

      const stopCandidateY = Math.min(
        nextInCol ? nextInCol.topY - 5 : Infinity,
        nextDivider ? nextDivider.topY - 6 : Infinity
      );

      const startY = Math.max(0, current.topY - 5);
      const colInfo = colBounds[current.col] || { minX: 0, maxX: viewport.width * 0.96 };

      const endX = nextRightSameRow
        ? Math.max(current.x + 40, nextRightSameRow.x - 8)
        : colInfo.maxX;

      const maxBandY = Number.isFinite(stopCandidateY)
        ? Math.min(viewport.height * 0.95, stopCandidateY)
        : Math.min(viewport.height * 0.95, startY + viewport.height * 0.35);

      const bandLines = lines.filter(
        (ln) =>
          ln.col === current.col &&
          ln.x <= endX + 10 &&
          ln.topY >= startY - 2 &&
          ln.bottomY <= maxBandY + 4
      );

      const contentBottomY =
        bandLines.length > 0
          ? Math.max(...bandLines.map((ln) => ln.bottomY))
          : current.bottomY + 24;

      // Stop tightly below the last line of this item (plus room for any diagram below it)
      const endY = Number.isFinite(stopCandidateY)
        ? Math.min(maxBandY, contentBottomY + 42)
        : Math.min(viewport.height * 0.95, contentBottomY + 28);

      const startX = Math.max(0, current.x - 10);

      if (endY - startY < 14 || endX - startX < 25) continue;

      const rawNormRect = {
        x: startX / viewport.width,
        y: startY / viewport.height,
        width: (endX - startX) / viewport.width,
        height: (endY - startY) / viewport.height,
      };

      const minTopNorm = Math.max(0.02, startY / viewport.height);
      const maxBottomNorm = Number.isFinite(stopCandidateY)
        ? Math.min(0.96, stopCandidateY / viewport.height)
        : 0.96;

      const snappedRect = snapBoxToInk(imageData, rawNormRect, {
        minTopNorm,
        maxBottomNorm,
      });
      const blob = await cropCanvasNormalized(canvas, snappedRect);

      if (blob) {
        results.set(current.canonical, {
          pageNumber: pageNum,
          normRect: snappedRect,
          blob,
          method: 'local-heuristic',
        });
      }
    }
  }

  return results;
}

/**
 * Orchestrates extraction on a single PDF Blob:
 * - mode: 'question' -> searches Exercises/Problems (excluding back-of-book Solutions)
 * - mode: 'solution' -> if isBackOfBook is true, scans the back-of-book Solutions section;
 *                       otherwise scans a dedicated Solutions Manual PDF.
 */
export async function autoExtractFromPdf({
  pdfBlob,
  structuredProblems,
  mode = 'question',
  isBackOfBook = false,
  apiKey = '',
  startPageHint = null,
  onProgress = () => {},
}) {
  if (!pdfBlob || !structuredProblems.length) {
    return { matches: new Map(), engineUsed: 'none', fallbackReason: null };
  }

  const arrayBuffer = await pdfBlob.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;

  try {
    const chapter = structuredProblems[0]?.chapter || '';
    const problemNumbers = structuredProblems.map((p) => p.problemNumber);

    onProgress(
      mode === 'solution' && isBackOfBook
        ? `Scanning back of textbook for Chapter ${chapter || ''} solutions...`
        : `Scanning ${mode} PDF for Chapter ${chapter || 'exercises'}...`
    );

    const candidatePageNums =
      mode === 'solution' && isBackOfBook
        ? await findBackOfBookSolutionsPages(pdfDoc, {
            chapter,
            problemNumbers,
            startPageHint,
            maxPages: 5,
          })
        : await findCandidatePages(pdfDoc, {
            chapter,
            problemNumbers,
            startPageHint,
            maxPages: 5,
            stopBeforeBackSolutions: mode === 'question',
          });

    onProgress(
      `Rendering ${candidatePageNums.length} candidate ${mode} page(s) (p. ${candidatePageNums.join(', ')})...`
    );
    const renderedPages = [];
    for (const pNum of candidatePageNums) {
      renderedPages.push(await renderPageForDetection(pdfDoc, pNum, 2.0));
    }

    if (apiKey && apiKey.trim()) {
      try {
        const matches = await detectWithVisionLLM({
          renderedPages,
          problemNumbers,
          chapter,
          mode,
          apiKey,
          onProgress,
        });

        const missing = problemNumbers.filter((n) => !matches.has(n.trim()));
        if (missing.length > 0) {
          onProgress(`Filling ${missing.length} remaining ${mode}(s) locally...`);
          const localFill = await detectWithLocalHeuristic({
            renderedPages,
            problemNumbers: missing,
            chapter,
          });
          for (const [k, v] of localFill.entries()) {
            if (!matches.has(k)) matches.set(k, v);
          }
        }

        return { matches, engineUsed: 'vision-llm', fallbackReason: null };
      } catch (visionErr) {
        const reason = visionErr?.message || 'Vision API unavailable';
        onProgress(`Using offline local cropper (${reason})...`);
        const matches = await detectWithLocalHeuristic({
          renderedPages,
          problemNumbers,
          chapter,
        });

        return {
          matches,
          engineUsed: 'local-heuristic',
          fallbackReason: reason,
        };
      }
    }

    onProgress(`Auto-cropping ${mode}s locally...`);
    const matches = await detectWithLocalHeuristic({
      renderedPages,
      problemNumbers,
      chapter,
    });

    return {
      matches,
      engineUsed: 'local-heuristic',
      fallbackReason: null,
    };
  } finally {
    await loadingTask.destroy();
  }
}