/**
 * People: friends with a copy of Blue Everything each, on this PC.
 *
 * Plan A of "Blue Everything for friends". Shown on the host only, your own
 * copy, from any of your devices, so the whole thing can be run from a phone:
 * add someone, send them their sign-in link, start, stop and remove their
 * copy. The server side is `instances.ts`.
 *
 * Their data is theirs: this screen never shows what is in a copy, only that
 * it exists and whether it is running.
 */
import { useState } from 'react';
import { api, type Person, type PersonInvite } from '../api';
import { useAsync } from '../useAsync';

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function PeopleTab() {
  const people = useAsync(() => api.people.list(), [], ['all']);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  /** The last sign-in link made, shown until another is. */
  const [invite, setInvite] = useState<PersonInvite | null>(null);
  const [copied, setCopied] = useState(false);

  async function run(key: string, what: () => Promise<unknown>) {
    setProblem('');
    setBusy(key);
    try {
      await what();
      people.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const showInvite = (made: PersonInvite) => {
    setInvite(made);
    setCopied(false);
  };

  const typed = name.trim().toLowerCase();
  const list = people.data?.people ?? [];

  if (people.loading) return <div className="empty">loading…</div>;
  if (people.error) {
    return <div className="banner">Could not list people: {people.error.message}. A server older than this screen needs a restart.</div>;
  }

  const row = (p: Person) => (
    <div className="card" key={p.name}>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <strong>
          {p.displayName ?? p.name}
          {p.displayName && p.displayName !== p.name && <span className="meta"> ({p.name})</span>}
        </strong>
        <span className={p.running ? 'meta' : 'meta urgent'}>{p.running ? 'running' : 'stopped'}</span>
      </div>
      <p className="meta" style={{ wordBreak: 'break-all' }}>
        {p.address ?? `${p.localAddress} (on this PC only: Tailscale is not publishing it)`}
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button
          className="btn primary"
          disabled={busy !== null}
          onClick={() => run(`i:${p.name}`, async () => showInvite(await api.people.invite(p.name)))}
        >
          {busy === `i:${p.name}` ? '…' : 'Sign-in link'}
        </button>
        {p.running ? (
          <button className="btn" disabled={busy !== null} onClick={() => run(`s:${p.name}`, () => api.people.stop(p.name))}>
            {busy === `s:${p.name}` ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button className="btn" disabled={busy !== null} onClick={() => run(`s:${p.name}`, () => api.people.start(p.name))}>
            {busy === `s:${p.name}` ? 'Starting…' : 'Start'}
          </button>
        )}
        <button
          className="btn danger"
          disabled={busy !== null}
          onClick={() => {
            // Typed, not tapped: it stops somebody's copy and takes it off this list.
            const answer = window.prompt(
              `Remove ${p.name}'s copy? It stops, and their folder is moved to instances\\_removed, not deleted. Type ${p.name} to confirm.`
            );
            if (answer?.trim() !== p.name) return;
            void run(`r:${p.name}`, async () => {
              await api.people.remove(p.name);
              if (invite?.person.name === p.name) setInvite(null);
            });
          }}
        >
          {busy === `r:${p.name}` ? 'Removing…' : 'Remove'}
        </button>
      </div>
      {!p.running && !p.autostart && <p className="meta">Stopped by hand, so it stays stopped when this PC's copy restarts.</p>}
    </div>
  );

  return (
    <>
      <div className="card">
        <h3>People</h3>
        <p className="meta">
          Each person gets their own copy of Blue Everything on this PC, with their own tasks, habits, notes and manga
          library, and their own address on your Tailscale. They read manga through your Suwayomi and can ask you for
          sources. Their copy is stopped while this PC is off.
        </p>
        <p className="meta">
          Their data is on this PC, so you could read it; the vault is the one part you cannot. Worth telling them.
        </p>
        <form
          className="row"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!NAME.test(typed)) return;
            void run('add', async () => {
              showInvite(await api.people.create(typed));
              setName('');
            });
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="a name, like sam"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Their name"
          />
          <button className="btn primary" disabled={busy !== null || !NAME.test(typed)}>
            {busy === 'add' ? 'Making their copy…' : 'Add'}
          </button>
        </form>
        {typed !== '' && !NAME.test(typed) && (
          <p className="meta urgent">Lowercase letters, digits and hyphens, starting with a letter or digit.</p>
        )}
        {busy === 'add' && <p className="meta">Starting a server for them takes a few seconds.</p>}
        {problem && <p className="banner">{problem}</p>}
      </div>

      {invite && (
        <div className="card flash">
          <h3>Sign-in link for {invite.person.name}</h3>
          <p className="meta" style={{ wordBreak: 'break-all' }}>
            {invite.url}
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn primary"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(invite.url)
                  .then(() => setCopied(true))
                  .catch(() => {})
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a className="btn" href={invite.url} target="_blank" rel="noreferrer">
              Open it here
            </a>
          </div>
          <p className="meta">
            Works once, until{' '}
            {new Date(invite.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. Send it
            to them, or open it yourself to try their copy as they will see it. It signs in the browser that opens it.
            {!invite.person.address &&
              ' It is a this-PC address because Tailscale is not publishing their copy, so it will not open on a phone.'}
          </p>
        </div>
      )}

      {list.length === 0 ? <p className="empty">Nobody yet.</p> : list.map(row)}
    </>
  );
}
