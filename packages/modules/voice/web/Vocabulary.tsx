/**
 * Everything the recogniser is allowed to say.
 *
 * Worth a screen because of what a closed grammar *is*: it can only ever emit
 * words it contains, and most of the confusing things this feature has done came
 * straight from that. A stored "drink water" left it unable to say "drank", so
 * "I drank water" came back as "resume water" and paused the music. A phrase
 * containing "go" put "went" into the grammar, where it then turned up in an
 * unrelated sentence. None of that is guessable from the commands screen, and
 * all of it is obvious here.
 *
 * Its own file rather than another six hundred lines in `Voice.tsx`, and its own
 * fetch rather than a field on the status poll — this is a list somebody opens
 * occasionally, and the status call runs every few seconds.
 */
import { api } from '@app/api';
import { useAsync } from '@app/useAsync';

export function Vocabulary({ unknown }: { unknown: string[] }) {
  const vocabulary = useAsync(() => api.voice.vocabulary(), [], ['settings']);
  const data = vocabulary.data;

  /*
   * A server older than this endpoint answers 404, which `useAsync` reports as
   * an error. Rendering nothing is right: the rest of the tab is unaffected and
   * a banner would suggest something had broken — the same treatment the voice
   * settings already give a stale server.
   */
  if (vocabulary.error || !data) return null;

  const missing = new Set(unknown.map((word) => word.toLowerCase()));
  const missingHere = data.groups.flatMap((group) => group.words.filter((word) => missing.has(word)));

  return (
    <details className="card">
      <summary>
        <span className="title">Everything it can hear</span>
        <span className="meta"> · {data.total} words</span>
      </summary>

      <div className="meta" style={{ marginTop: 8 }}>
        The recogniser may only answer with words on this list. Anything else you say has to be mapped onto
        one of them — which is why a word missing from here can never be heard, and why one you did not
        expect can turn up in a transcript.
      </div>

      {data.groups.map((group) => (
        <div key={group.id} style={{ marginTop: 14 }}>
          <div className="title" style={{ fontSize: '0.95rem' }}>
            {group.label}
            <span className="meta"> · {group.words.length}</span>
          </div>
          <div className="meta" style={{ marginTop: 2 }}>
            {group.why}
          </div>
          <div className="row wrap" style={{ gap: '.3rem', marginTop: 6 }}>
            {group.words.map((word) => (
              <span
                key={word}
                className={missing.has(word) ? 'chip urgent' : 'chip'}
                title={
                  missing.has(word)
                    ? `"${word}" is not in the speech model's dictionary, so it can never be heard`
                    : undefined
                }
              >
                {word}
                {missing.has(word) ? ' ⚠' : ''}
              </span>
            ))}
          </div>
        </div>
      ))}

      {/*
        The one actionable thing here, spelled out at the foot rather than left
        as a symbol somebody has to hover over to understand.
      */}
      {missingHere.length > 0 && (
        <div className="meta urgent" style={{ marginTop: 14 }}>
          ⚠ marks a word the speech model cannot pronounce. Vosk drops those without a murmur, so they sit
          in the grammar doing nothing at all — a compound or an invented name is the usual cause, and
          separating it into two ordinary words almost always fixes it.
        </div>
      )}
    </details>
  );
}
