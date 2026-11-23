/**
 * Parses syllabus problem lists into structured problem descriptors:
 * [{ label: "Ch 3 #4", chapter: "3", chapterRaw: "Ch 3", problemNumber: "4" }, ...]
 */
export function parseStructuredProblems(rawInput) {
  if (!rawInput || !rawInput.trim()) return [];

  const segments = rawInput
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const results = [];

  for (const segment of segments) {
    let prefix = '';
    let listPart = segment;

    const colonIndex = segment.indexOf(':');
    if (colonIndex !== -1) {
      prefix = segment.slice(0, colonIndex).trim();
      listPart = segment.slice(colonIndex + 1).trim();
    }

    // Extract numeric chapter/section identifier if present (e.g. "Ch 3" -> "3", "4.2" -> "4.2")
    const chapterMatch = prefix.match(/(\d+(?:\.\d+)?)/);
    const chapter = chapterMatch ? chapterMatch[1] : '';

    const tokens = listPart
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    for (const token of tokens) {
      const rangeMatch = token.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        if (end >= start && end - start <= 60) {
          for (let n = start; n <= end; n++) {
            const numStr = String(n);
            results.push({
              label: prefix ? `${prefix} #${numStr}` : `#${numStr}`,
              chapter,
              chapterRaw: prefix,
              problemNumber: numStr,
            });
          }
          continue;
        }
      }

      results.push({
        label: prefix ? `${prefix} #${token}` : `#${token}`,
        chapter,
        chapterRaw: prefix,
        problemNumber: token,
      });
    }
  }

  return results;
}

/**
 * Backward-compatible string list helper
 */
export function parseProblemList(rawInput) {
  return parseStructuredProblems(rawInput).map((item) => item.label);
}