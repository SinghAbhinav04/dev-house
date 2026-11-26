/**
 * Models often put `<br>` in markdown, mostly inside table cells, where a real
 * newline would end the row. Raw HTML is never rendered (no rehype-raw: plan
 * text is model output), so the tags are turned into what they mean instead:
 * a separator inside a table row, a line break anywhere else.
 */
export function softenBreaks(markdown: string): string {
  if (!/<br\s*\/?>/i.test(markdown)) return markdown;
  return markdown
    .split('\n')
    .map((line) => (/^\s*\|/.test(line) ? line.replace(/\s*<br\s*\/?>\s*/gi, ' · ') : line.replace(/\s*<br\s*\/?>\s*/gi, '\n')))
    .join('\n');
}

/**
 * Markdown as you would write it on a whiteboard: no emphasis marks or
 * backticks, a table header and divider dropped, and each row as
 * "first cell: rest · of · the · cells". Headings and bullets stay.
 */
export function markdownForBoard(markdown: string): string {
  const out: string[] = [];
  let inTable = false;
  for (const raw of softenBreaks(markdown).split('\n')) {
    const line = raw.trim();
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // divider
      if (!inTable) {
        inTable = true; // header row: the columns explain themselves on a board
        continue;
      }
      const [first, ...rest] = cells.filter((c) => c && c !== '—' && c !== '-');
      if (first) out.push(`- ${first}${rest.length ? `: ${rest.join(' · ')}` : ''}`);
      continue;
    }
    inTable = false;
    out.push(raw);
  }
  return out
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
