/**
 * Word-level diff via Myers' shortest-edit-script (LCS-based).
 *
 * Tokens are words separated by whitespace; whitespace is preserved as its
 * own token so paragraph breaks survive. Output is a list of segments
 * tagged 'eq' / 'add' / 'del' suitable for rendering inline.
 */

export type DiffSeg = { type: 'eq' | 'add' | 'del'; text: string };

export function tokenize(text: string): string[] {
  // split on whitespace boundaries but keep the whitespace as its own tokens
  const out: string[] = [];
  const re = /(\s+)|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0]);
  }
  return out;
}

export function diffWords(a: string, b: string): DiffSeg[] {
  const at = tokenize(a);
  const bt = tokenize(b);
  const m = at.length;
  const n = bt.length;
  // LCS table (number-of-matching-tokens dynamic-programming).
  // For typical paragraph-sized inputs (~few hundred tokens) the m*n cost is
  // negligible; if a future selection ever blows past 10k tokens we can
  // swap in Myers' O((m+n)D) algorithm.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (at[i] === bt[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs: DiffSeg[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (at[i] === bt[j]) {
      pushSeg(segs, 'eq', at[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSeg(segs, 'del', at[i]);
      i++;
    } else {
      pushSeg(segs, 'add', bt[j]);
      j++;
    }
  }
  while (i < m) pushSeg(segs, 'del', at[i++]);
  while (j < n) pushSeg(segs, 'add', bt[j++]);
  return segs;
}

function pushSeg(segs: DiffSeg[], type: DiffSeg['type'], text: string) {
  if (segs.length > 0 && segs[segs.length - 1].type === type) {
    segs[segs.length - 1].text += text;
  } else {
    segs.push({ type, text });
  }
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(segs: DiffSeg[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const s of segs) {
    if (s.type === 'add') added += s.text.trim().length > 0 ? wordCount(s.text) : 0;
    else if (s.type === 'del') removed += s.text.trim().length > 0 ? wordCount(s.text) : 0;
  }
  return { added, removed };
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}
