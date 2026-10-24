import { h } from '../../../vendor/preact.js';
import { useMemo, useState } from '../../../vendor/preact-hooks.js';
import { Avatar, PresenceTag, TypingDots, liveTone } from './Presence.js';
import type { Person, PersonId, Thread, ThreadKind } from './types.js';

const KIND_LABEL: Record<ThreadKind, string> = {
  note: 'Note',
  concern: 'Concern',
  avoid: 'Avoid',
  constraint: 'Constraint',
  question: 'Open question',
  goal: 'Goal',
};

interface Props {
  threads: Thread[];
  people: Record<PersonId, Person>;
  meId: PersonId;
  onReply?: (threadId: string, body: string) => void;
  onShowAnchor?: (anchorId: string) => void;
}

/**
 * Open threads as comments, stacked by the part they are pinned to.
 *
 * A group starts as a pile: the most active comment on top (anyone present
 * sorts it up), the rest peeking out as plates. Clicking the group or the top
 * card fans it out; clicking a comment opens its replies and a reply field.
 * Comments from Vowe are ordinary comments with the orb as avatar: nothing to
 * keep or dismiss, they can simply be left.
 *
 * Open groups, the open thread and reply drafts are view state, so they live
 * here; the threads themselves come from props.
 */
export function ThreadStacks({ threads, people, meId, onReply, onShowAnchor }: Props) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const groups = useMemo(() => {
    const order: string[] = [];
    const by = new Map<string, Thread[]>();
    for (const t of threads) {
      if (!by.has(t.anchor.id)) {
        by.set(t.anchor.id, []);
        order.push(t.anchor.id);
      }
      by.get(t.anchor.id)!.push(t);
    }
    return order.map((id) => {
      const list = [...by.get(id)!].sort((a, b) => Number(!!b.presence) - Number(!!a.presence));
      return { id, name: list[0]!.anchor.name, list };
    });
  }, [threads]);

  const send = (threadId: string): void => {
    const body = draft.trim();
    if (!body) return;
    onReply?.(threadId, body);
    setDraft('');
  };

  return (
    <div class="rp-tgroups">
      {groups.map((g) => {
        const open = !!openGroups[g.id] || g.list.length === 1;
        const many = g.list.length > 1;
        const openGroup = (): void => setOpenGroups((m) => ({ ...m, [g.id]: true }));
        return (
          <div key={g.id} class={`rp-tg${open ? ' rp-open' : ' rp-closed'}${many ? ' rp-many' : ''}`}>
            <button
              class="rp-tg-head"
              type="button"
              aria-expanded={open}
              onClick={() => setOpenGroups((m) => ({ ...m, [g.id]: !open }))}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <rect x="2.5" y="3.5" width="11" height="9" rx="2.2" />
              </svg>
              <span class="rp-tg-name">{g.name}</span>
              <span class="rp-tg-n">
                {g.list.length} {g.list.length === 1 ? 'thread' : 'threads'}
              </span>
              <span class="rp-tg-chev" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M5 6.5l3 3 3-3" />
                </svg>
              </span>
            </button>

            <div class="rp-tstack">
              {g.list.map((t, i) => {
                if (!open && i > 2) return null;
                const peek = !open && i > 0;
                const expanded = open && openThread === t.id;
                const author = people[t.root.authorId];
                const repliers = [...new Set(t.replies.map((r) => r.authorId))];
                const last = t.replies[t.replies.length - 1];
                // Closed: every card gets a z-index so the top one sits over the plates.
                const style = (!open
                  ? { '--i': i, zIndex: 10 - i }
                  : { animationDelay: `${i * 45}ms` }) as Record<string, string | number>;
                const cls =
                  'rp-cm' + (peek ? ' rp-peek' : '') + (expanded ? ' rp-expanded' : '') + liveTone(t.presence, people);

                return (
                  <div key={t.id} class={cls} style={style} aria-hidden={peek || undefined}>
                    <button
                      class="rp-cm-main"
                      type="button"
                      aria-expanded={expanded}
                      tabIndex={peek ? -1 : undefined}
                      onClick={() => {
                        if (!open) return openGroup();
                        setOpenThread(expanded ? null : t.id);
                        setDraft('');
                      }}
                    >
                      <span class="rp-cm-head">
                        <Avatar person={author} />
                        <b>{t.root.authorId === meId ? 'You' : (author?.name ?? 'Someone')}</b>
                        <span class="rp-cm-time">{t.root.ago}</span>
                        <span class="rp-cm-kind">{KIND_LABEL[t.kind]}</span>
                      </span>
                      <span class="rp-cm-body">{t.root.body}</span>
                    </button>

                    <div class="rp-cm-foot">
                      {t.replies.length ? (
                        <span class="rp-cm-replies">
                          <span class="rp-avstack">
                            {repliers.map((id) => (
                              <Avatar key={id} person={people[id]} size={16} />
                            ))}
                          </span>
                          {t.replies.length} {t.replies.length === 1 ? 'reply' : 'replies'} · {last!.ago}
                        </span>
                      ) : (
                        <span class="rp-cm-replies rp-quiet">No replies</span>
                      )}
                      {t.presence ? <PresenceTag presence={t.presence} people={people} /> : null}
                    </div>

                    {expanded ? (
                      <div class="rp-cm-thread">
                        {t.replies.map((r) => (
                          <div key={r.id} class={`rp-cm-r${r.fresh ? ' rp-fresh' : ''}`}>
                            <span class="rp-cm-head">
                              <Avatar person={people[r.authorId]} size={18} />
                              <b>{r.authorId === meId ? 'You' : (people[r.authorId]?.name ?? 'Someone')}</b>
                              <span class="rp-cm-time">{r.ago}</span>
                            </span>
                            <span class="rp-cm-body">{r.body}</span>
                          </div>
                        ))}
                        {t.presence?.mode === 'typing' ? (
                          <div class="rp-cm-typing">
                            <Avatar person={people[t.presence.personId]} size={18} />
                            <span class="rp-bubble">
                              <TypingDots />
                            </span>
                          </div>
                        ) : null}
                        <label class="rp-cm-reply">
                          <Avatar person={people[meId]} size={18} />
                          <span class="rp-sr">Reply</span>
                          <input
                            type="text"
                            placeholder="Reply, or just say it on the call"
                            value={draft}
                            onInput={(e) => setDraft(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') send(t.id);
                            }}
                          />
                        </label>
                        <button class="rp-link" type="button" onClick={() => onShowAnchor?.(t.anchor.id)}>
                          Show on canvas
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
