import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, MatchDecorator } from '@codemirror/view';

export interface CodexEntry {
  path: string;
  title: string;
  aliases: string[];
}

export interface CodexClickHandler {
  (entry: CodexEntry, name: string): void;
}

const decoCache = new WeakMap<readonly CodexEntry[], { regex: RegExp; lookup: Map<string, CodexEntry> }>();

function buildIndex(entries: readonly CodexEntry[]) {
  const cached = decoCache.get(entries);
  if (cached) return cached;
  const lookup = new Map<string, CodexEntry>();
  const names: string[] = [];
  for (const e of entries) {
    if (e.title && e.title.trim()) {
      names.push(e.title);
      lookup.set(e.title.toLowerCase(), e);
    }
    for (const a of e.aliases || []) {
      if (a && a.trim()) {
        names.push(a);
        lookup.set(a.toLowerCase(), e);
      }
    }
  }
  if (names.length === 0) {
    const empty = { regex: /(?!)/g, lookup };
    decoCache.set(entries, empty);
    return empty;
  }
  // Longest first so "Old Tarn" wins over "Tarn".
  names.sort((a, b) => b.length - a.length);
  const escaped = names.map(escapeRegExp).join('|');
  const regex = new RegExp(`\\b(?:${escaped})\\b`, 'gi');
  const result = { regex, lookup };
  decoCache.set(entries, result);
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectCharacters(
  text: string,
  codex: readonly CodexEntry[],
): CodexEntry[] {
  const { regex, lookup } = buildIndex(codex);
  const seen = new Set<string>();
  const out: CodexEntry[] = [];
  for (const m of text.matchAll(regex)) {
    const entry = lookup.get(m[0].toLowerCase());
    if (!entry) continue;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry);
  }
  return out;
}

export function codexHighlightExtension(
  getEntries: () => readonly CodexEntry[],
  onClick: CodexClickHandler,
) {
  const decorator = (view: EditorView): DecorationSet => {
    const entries = getEntries();
    if (entries.length === 0) return Decoration.none;
    const { regex, lookup } = buildIndex(entries);
    const md = new MatchDecorator({
      regexp: regex,
      decoration: (match) => {
        const entry = lookup.get(match[0].toLowerCase());
        if (!entry) return Decoration.mark({ class: 'cm-codex-link' });
        return Decoration.mark({
          class: 'cm-codex-link',
          attributes: {
            'data-codex-path': entry.path,
            'data-codex-name': match[0],
            title: `${entry.title}${entry.aliases.length ? ' (' + entry.aliases.join(', ') + ')' : ''}`,
          },
        });
      },
    });
    return md.createDeco(view);
  };

  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = decorator(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged) {
            this.decorations = decorator(u.view);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.domEventHandlers({
      click(event) {
        const target = event.target as HTMLElement | null;
        if (!target) return false;
        const link = target.closest<HTMLElement>('.cm-codex-link');
        if (!link) return false;
        const path = link.getAttribute('data-codex-path');
        const name = link.getAttribute('data-codex-name');
        if (!path || !name) return false;
        const entries = getEntries();
        const entry = entries.find((e) => e.path === path);
        if (!entry) return false;
        // Modifier-click navigates; plain click does nothing so the user can edit text.
        if (!event.metaKey && !event.ctrlKey) return false;
        event.preventDefault();
        onClick(entry, name);
        return true;
      },
    }),
  ];
}
