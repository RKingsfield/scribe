import { type ReactNode, useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, BookOpen, Download, Pencil, SunMoon } from 'lucide-react';
import { ProjectTree } from '../lib/api';

interface PaletteCommand {
  id: string;
  title: string;
  hint?: string;
  icon?: ReactNode;
  group: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  slug: string;
  tree: ProjectTree | null;
  onToggleTypewriter?: () => void;
  onToggleSidebar?: () => void;
  onToggleInspector?: () => void;
  onToggleTheme?: () => void;
  onOpenRag?: () => void;
  onOpenExport?: () => void;
  onPrefetch?: () => void;
}

export function CommandPalette({
  open,
  onClose,
  slug,
  tree,
  onToggleTypewriter,
  onToggleSidebar,
  onToggleInspector,
  onToggleTheme,
  onOpenRag,
  onOpenExport,
  onPrefetch,
}: Props) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  if (!open) return null;

  const goToFile = (path: string) => {
    navigate(`/p/${encodeURIComponent(slug)}/write?path=${encodeURIComponent(path)}`);
    onClose();
  };

  const navCmds: PaletteCommand[] = [
    {
      id: 'go-write',
      title: 'Go to Write',
      icon: <Pencil size={14} />,
      group: 'Navigation',
      hint: 'tab',
      run: () => { navigate(`/p/${encodeURIComponent(slug)}/write`); onClose(); },
    },
    {
      id: 'go-plan',
      title: 'Go to Plan (corkboard)',
      icon: '▦',
      group: 'Navigation',
      run: () => { navigate(`/p/${encodeURIComponent(slug)}/plan`); onClose(); },
    },
    {
      id: 'go-chat',
      title: 'Go to Chat',
      icon: '◯',
      group: 'Navigation',
      run: () => { navigate(`/p/${encodeURIComponent(slug)}/chat`); onClose(); },
    },
    {
      id: 'go-review',
      title: 'Go to Review',
      icon: '◯',
      group: 'Navigation',
      run: () => { navigate(`/p/${encodeURIComponent(slug)}/review`); onClose(); },
    },
    {
      id: 'go-projects',
      title: 'Back to projects',
      icon: <ArrowLeft size={14} />,
      group: 'Navigation',
      run: () => { navigate('/'); onClose(); },
    },
  ];

  const viewCmds: PaletteCommand[] = [
    onToggleTypewriter && {
      id: 'toggle-typewriter',
      title: 'Toggle typewriter mode',
      group: 'View',
      icon: 'T',
      run: () => { onToggleTypewriter(); onClose(); },
    },
    onToggleSidebar && {
      id: 'toggle-sidebar',
      title: 'Toggle sidebar',
      group: 'View',
      icon: '◧',
      run: () => { onToggleSidebar(); onClose(); },
    },
    onToggleInspector && {
      id: 'toggle-inspector',
      title: 'Toggle inspector',
      group: 'View',
      icon: '◨',
      run: () => { onToggleInspector(); onClose(); },
    },
    onToggleTheme && {
      id: 'toggle-theme',
      title: 'Toggle light / dark theme',
      group: 'View',
      icon: <SunMoon size={14} />,
      run: () => { onToggleTheme(); onClose(); },
    },
    onOpenRag && {
      id: 'open-rag',
      title: 'Project RAG (recipe + ingest)',
      group: 'Project',
      icon: <BookOpen size={14} />,
      hint: 'M13',
      run: () => { onOpenRag(); onClose(); },
    },
    onOpenExport && {
      id: 'open-export',
      title: 'Export project (docx / epub / html / md)',
      group: 'Project',
      icon: <Download size={14} />,
      hint: 'M14',
      run: () => { onOpenExport(); onClose(); },
    },
    onPrefetch && {
      id: 'prefetch-offline',
      title: 'Download project for offline',
      group: 'Project',
      icon: '☁',
      run: () => { onPrefetch(); onClose(); },
    },
  ].filter(Boolean) as PaletteCommand[];

  const chapterCmds: PaletteCommand[] = (tree?.chapters ?? []).flatMap((c) => {
    const items: PaletteCommand[] = [
      {
        id: `chapter-${c.path}`,
        title: c.title || c.slug,
        hint: c.chapter !== null ? `Ch. ${c.chapter}` : c.slug,
        icon: '§',
        group: 'Chapters',
        run: () => goToFile(c.scenes.length === 1 ? c.scenes[0].path : c.meta_path),
      },
    ];
    if (c.scenes.length > 1) {
      for (const s of c.scenes) {
        items.push({
          id: `scene-${s.path}`,
          title: s.title || `Scene ${s.scene ?? ''}`,
          hint: c.chapter !== null && s.scene !== null ? `${c.chapter}.${s.scene}` : '',
          icon: '·',
          group: 'Scenes',
          run: () => goToFile(s.path),
        });
      }
    }
    return items;
  });

  const catCmds: PaletteCommand[] = (tree?.categories ?? []).flatMap((cat) =>
    cat.entries.map((r) => ({
      id: `cat-${cat.folder}-${r.path}`,
      title: r.title || r.path.split('/').pop() || r.path,
      hint: r.aliases.length ? r.aliases.slice(0, 2).join(', ') : '',
      icon: cat.codex ? '◉' : '◇',
      group: cat.name,
      run: () => goToFile(r.path),
    })),
  );

  const all = [...navCmds, ...viewCmds, ...chapterCmds, ...catCmds];
  const groups = Array.from(new Set(all.map((c) => c.group)));

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <Command
        className="cmdk"
        onClick={(e) => e.stopPropagation()}
        loop
        shouldFilter
      >
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder="Search chapters, characters, commands…"
          className="cmdk-input"
        />
        <Command.List className="cmdk-list">
          <Command.Empty className="cmdk-empty">No matches.</Command.Empty>
          {groups.map((g) => (
            <Command.Group key={g} heading={g} className="cmdk-group">
              {all
                .filter((c) => c.group === g)
                .map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`${c.group} ${c.title} ${c.hint ?? ''}`}
                    onSelect={c.run}
                    className="cmdk-item"
                  >
                    <span className="cmdk-icon">{c.icon ?? ''}</span>
                    <span className="cmdk-title">{c.title}</span>
                    {c.hint && <span className="cmdk-meta">{c.hint}</span>}
                  </Command.Item>
                ))}
            </Command.Group>
          ))}
        </Command.List>
        <div className="cmdk-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </Command>
    </div>
  );
}
