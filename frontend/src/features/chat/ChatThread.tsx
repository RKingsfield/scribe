import { ChatTurn } from '../../lib/db';

interface Props {
  turns: ChatTurn[];
  streaming?: { content: string; meta?: { scope_label: string; estimated_tokens: number } } | null;
  error?: string | null;
}

export function ChatThreadView({ turns, streaming, error }: Props) {
  if (turns.length === 0 && !streaming && !error) {
    return (
      <div className="chat-thread-empty">
        <p>Start a conversation about your manuscript.</p>
        <p className="dim">
          Pick a scope on the right — Everything, an Act, a Chapter, the current
          Scene, or just the Codex — and ask anything. Replies stream from the
          local orchestrator.
        </p>
      </div>
    );
  }
  return (
    <div className="chat-thread">
      {turns.map((t, i) => (
        <Turn key={i} turn={t} />
      ))}
      {streaming && (
        <div className="chat-turn assistant streaming">
          {streaming.meta && (
            <div className="chat-turn-scope">{streaming.meta.scope_label}</div>
          )}
          <div className="chat-turn-body">
            {streaming.content}
            <span className="chat-cursor" />
          </div>
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
    </div>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  return (
    <div className={`chat-turn ${turn.role}`}>
      <div className="chat-turn-role">{turn.role === 'user' ? 'You' : 'scribe'}</div>
      <div className="chat-turn-body">{turn.content}</div>
    </div>
  );
}
