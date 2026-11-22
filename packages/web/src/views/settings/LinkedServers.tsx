/**
 * Linked servers, on People: another person's own Blue Everything, on their
 * PC, linked with this one on purpose over Tailscale. The server side is
 * `peers.ts`; what is shared is the manga package's (its Local collection,
 * chapter catalogue and ratings), read on Manga → Browse.
 *
 * One side makes a link code here and sends it; the other pastes it into this
 * same card on their own server. Each side then chooses what it shares, and
 * either can unlink.
 */
import { useState } from 'react';
import { api, type PeerLink, type PeerShare } from '../../api';
import { useAsync } from '../../useAsync';

const SHARES: Array<{ key: keyof PeerShare; label: string; hint: string }> = [
  { key: 'collection', label: 'My Local collection, to read', hint: 'The series kept in your Local collection, and their pages.' },
  { key: 'copy', label: 'Copying from it', hint: 'They may keep a copy of a series in their own Local collection.' },
  { key: 'catalogue', label: 'The chapter catalogue', hint: 'Which sources have which series, and how many chapters each copy has. Spares both of you asking the sites.' },
  { key: 'ratings', label: 'My ratings', hint: 'What you rated each series. Off unless you choose.' },
];

const when = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function LinkedServers({ manga }: { manga: boolean }) {
  const peers = useAsync(() => api.peers.list(), [], ['all']);
  const [pasted, setPasted] = useState('');
  const [code, setCode] = useState<{ link: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState('');

  async function run(key: string, what: () => Promise<unknown>) {
    setProblem('');
    setBusy(key);
    try {
      await what();
      peers.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (peers.loading) return null;
  if (peers.error) return <div className="banner">Could not list linked servers: {peers.error.message}. A server older than this screen needs a restart.</div>;
  const data = peers.data!;
  const looksLikeCode = /^https:\/\/[^\s#]+\/?#link=[A-Za-z0-9_-]{20,}$/.test(pasted.trim()) || /^http:\/\/127\.0\.0\.1:\d+\/?#link=/.test(pasted.trim());

  const row = (l: PeerLink) => (
    <div className="card" key={l.id}>
      <div className="row between" style={{ alignItems: 'baseline', gap: 8 }}>
        <strong>{l.name}</strong>
        <span className={l.problem ? 'meta urgent' : 'meta'}>{l.problem ? 'not answering' : l.theirs ? 'linked' : 'linked, not reached yet'}</span>
      </div>
      <p className="meta" style={{ wordBreak: 'break-all' }}>
        {l.url} · linked {when(l.linkedAt)}
      </p>
      {l.problem && (
        <p className="meta urgent">
          Asking it: {l.problem}. For this server to reach theirs, their machine has to be shared with your tailnet in Tailscale (and yours with theirs, for
          them to reach you).
        </p>
      )}
      {manga && (
        <>
          <p className="meta" style={{ marginTop: 8 }}>
            <strong>What you share with {l.name}</strong>
          </p>
          {SHARES.map((s) => (
            <label key={s.key} className="meta" style={{ display: 'block' }} title={s.hint}>
              <input
                type="checkbox"
                checked={l.share[s.key]}
                disabled={busy !== null || (s.key === 'copy' && !l.share.collection)}
                onChange={(e) => void run(`s:${l.id}`, () => api.peers.share(l.id, { [s.key]: e.target.checked }))}
              />{' '}
              {s.label}
            </label>
          ))}
          <p className="meta" style={{ marginTop: 8 }}>
            <strong>What {l.name} shares with you</strong>:{' '}
            {l.theirs
              ? SHARES.filter((s) => l.theirs!.share[s.key])
                  .map((s) => s.label.replace(/^My /, 'their ').replace(/^The /, 'the ').toLowerCase())
                  .join(', ') || 'nothing yet'
              : 'not known yet'}
            {l.theirs?.share.collection ? '. Read it on Manga → Browse.' : '.'}
          </p>
        </>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="btn" disabled={busy !== null} onClick={() => void run(`c:${l.id}`, () => api.peers.check(l.id))}>
          {busy === `c:${l.id}` ? 'Asking…' : 'Ask it again'}
        </button>
        <button
          className="btn danger"
          disabled={busy !== null}
          onClick={() => {
            if (!window.confirm(`Unlink ${l.name}'s server? Its key here stops working at once, and theirs is told to forget this one. Linking again takes a new code.`)) return;
            void run(`u:${l.id}`, () => api.peers.unlink(l.id));
          }}
        >
          {busy === `u:${l.id}` ? 'Unlinking…' : 'Unlink'}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="card">
        <h3>Linked servers</h3>
        <p className="meta">
          For a friend who runs their own Blue Everything on their own PC. Linking lets the two servers read each other's Local collection, and share the
          chapter catalogue and, if you choose, ratings. Only over Tailscale: each of you shares your machine with the other's tailnet (Tailscale's admin
          console, Machines, Share), and nothing is opened to the internet.
        </p>
        <p className="meta">
          A linked server's key reaches only what servers share, read-only, and only what you tick below. Never your tasks, notes, vault, settings or
          Suwayomi. Either of you can unlink at any time.
        </p>
        {!data.own && (
          <p className="banner">
            Tailscale is not publishing this server, so no other server could reach it. Turn on <code>tailscale serve</code> first (Devices → Add a
            device says how).
          </p>
        )}

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn primary"
            disabled={busy !== null || !data.own}
            onClick={() =>
              void run('code', async () => {
                setCode(await api.peers.code());
                setCopied(false);
              })
            }
          >
            {busy === 'code' ? '…' : 'Make a link code'}
          </button>
          {data.codes > 0 && (
            <button className="btn subtle" disabled={busy !== null} onClick={() => void run('forget', async () => (await api.peers.forgetCodes(), setCode(null)))}>
              Cancel {data.codes === 1 ? 'the unused code' : `${data.codes} unused codes`}
            </button>
          )}
        </div>

        {code && (
          <div className="card flash" style={{ marginTop: 8 }}>
            <p className="meta" style={{ wordBreak: 'break-all' }}>
              {code.link}
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn primary"
                onClick={() =>
                  navigator.clipboard
                    ?.writeText(code.link)
                    .then(() => setCopied(true))
                    .catch(() => {})
                }
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="meta">
              Send it to them. They paste it into People → Linked servers on <em>their</em> Blue Everything, not into a browser. It works once, until{' '}
              {when(code.expiresAt)}.
            </p>
          </div>
        )}

        <form
          className="row"
          style={{ gap: 8, marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!looksLikeCode) return;
            void run('link', async () => {
              await api.peers.link(pasted.trim());
              setPasted('');
            });
          }}
        >
          <input
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="paste a link code from their server"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="A link code from another server"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="btn primary" disabled={busy !== null || !looksLikeCode || !data.own}>
            {busy === 'link' ? 'Linking…' : 'Link'}
          </button>
        </form>
        {pasted.trim() !== '' && !looksLikeCode && <p className="meta urgent">A link code starts https:// and has #link= in it.</p>}
        {problem && <p className="banner">{problem}</p>}
      </div>

      {data.links.length === 0 ? <p className="empty">No linked servers.</p> : data.links.map(row)}
    </>
  );
}
