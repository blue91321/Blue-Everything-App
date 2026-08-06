import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type VaultSecret, type VaultStatus, type VaultSummary } from '../api';
import { useAsync } from '../useAsync';
import { relative } from '../format';

/** Long beats complex — length is where the strength is. */
const MIN_MASTER_PASSWORD = 12;

export function Vault() {
  const status = useAsync(() => api.vault.status());
  const [pendingShares, setPendingShares] = useState<{ a: string; b: string } | null>(null);
  const state = status.data;

  /**
   * The recovery kit outranks every other state, deliberately.
   *
   * It is displayed exactly once and the server keeps no copy, so anything that
   * can navigate away from it destroys it. Holding it here rather than inside
   * the setup form matters: creating the vault broadcasts a change, every
   * loader refetches, and the parent would otherwise re-render straight past
   * this screen into the unlocked vault — which is precisely what happened the
   * first time this ran.
   */
  if (pendingShares) {
    return (
      <RecoveryShares
        shares={pendingShares}
        onDone={() => {
          setPendingShares(null);
          status.reload();
        }}
      />
    );
  }

  if (status.loading && !state) return <div className="empty">loading…</div>;
  if (status.error) return <div className="banner">{status.error.message}</div>;
  if (!state) return null;

  if (!state.configured) return <SetUpVault onShares={setPendingShares} onDone={status.reload} />;
  if (!state.unlocked) return <UnlockVault status={state} onDone={status.reload} />;
  return <OpenVault status={state} onLocked={status.reload} />;
}

/* ------------------------------------------------------------------ */
/* First run                                                           */
/* ------------------------------------------------------------------ */

function SetUpVault({
  onShares,
  onDone,
}: {
  onShares: (shares: { a: string; b: string }) => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [withRecovery, setWithRecovery] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const tooShort = password.length > 0 && password.length < MIN_MASTER_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= MIN_MASTER_PASSWORD && confirm === password;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.vault.setup(password, withRecovery);
      // Clear the password from state the moment it is no longer needed.
      setPassword('');
      setConfirm('');
      // Handed upward rather than rendered here — see the note in Vault().
      if (result.recoveryShares) onShares(result.recoveryShares);
      else onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not create the vault');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Set up your vault</h2>
      <form className="card" onSubmit={create}>
        <div className="meta" style={{ marginBottom: 10 }}>
          This password is the only thing protecting your passwords, and it is never stored anywhere. Pick
          a long passphrase you will not forget — several words beat a short jumble of symbols.
        </div>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Master password"
          aria-label="Master password"
          autoComplete="new-password"
        />
        <div style={{ height: 8 }} />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type it again"
          aria-label="Confirm master password"
          autoComplete="new-password"
        />

        {tooShort && <div className="meta urgent" style={{ marginTop: 6 }}>At least {MIN_MASTER_PASSWORD} characters.</div>}
        {mismatch && <div className="meta urgent" style={{ marginTop: 6 }}>These do not match.</div>}

        <label className="row" style={{ marginTop: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={withRecovery}
            onChange={(e) => setWithRecovery(e.target.checked)}
            style={{ width: 'auto' }}
          />
          <span className="grow">
            <span className="title">Create a recovery kit</span>
            <span className="meta" style={{ display: 'block' }}>
              Two codes, split so that neither one alone is any use. Keep one in your password manager and
              one on paper. Without this, forgetting the master password is final.
            </span>
          </span>
        </label>

        {error && <div className="banner">{error}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" type="submit" disabled={!ready || busy}>
            {busy ? 'creating…' : 'Create vault'}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * The one screen that cannot be shown twice.
 *
 * The server keeps only the wrapping, never the code, so these two strings are
 * the sole copy in existence. Continuing is gated on an explicit tick rather
 * than a button you can reflexively click past.
 */
function RecoveryShares({ shares, onDone }: { shares: { a: string; b: string }; onDone: () => void }) {
  const [saved, setSaved] = useState(false);

  return (
    <section>
      <h2>Your recovery kit</h2>
      <div className="card">
        <div className="banner" style={{ borderLeftColor: 'var(--accent)' }}>
          Shown once. There is no copy on the server — if you lose both of these and forget your master
          password, the vault cannot be opened by anyone, including me.
        </div>

        <ShareBlock label="Share 1 — put this in Google Password Manager" value={shares.a} />
        <ShareBlock label="Share 2 — print this, or keep it on your phone" value={shares.b} />

        <div className="meta" style={{ marginTop: 10 }}>
          Both are needed together. Either one on its own reveals nothing at all — not "is hard to crack",
          but carries no information about the code. Keeping them in the same place defeats the point.
        </div>

        <label className="row" style={{ marginTop: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ width: 'auto' }} />
          <span className="grow title">I have stored both, in two different places</span>
        </label>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={!saved} onClick={onDone}>
            Done
          </button>
          <button className="btn" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>
    </section>
  );
}

function ShareBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="meta">{label}</div>
      <code className="snippet" style={{ userSelect: 'all', fontSize: 14 }}>
        {value}
      </code>
      <button
        className="btn subtle"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            },
            () => {}
          );
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Unlocking                                                           */
/* ------------------------------------------------------------------ */

function UnlockVault({ status, onDone }: { status: VaultStatus; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovering, setRecovering] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.vault.unlock(password);
      setPassword('');
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not unlock');
    } finally {
      setBusy(false);
    }
  }

  if (recovering) return <RecoverVault onDone={onDone} onCancel={() => setRecovering(false)} />;

  return (
    <section>
      <h2>Vault locked</h2>
      <form className="card" onSubmit={submit}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Master password"
          aria-label="Master password"
          autoComplete="current-password"
          autoFocus
        />
        {error && <div className="banner">{error}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" type="submit" disabled={!password || busy}>
            {busy ? 'unlocking…' : 'Unlock'}
          </button>
          {status.hasRecovery && (
            <button className="btn subtle" type="button" onClick={() => setRecovering(true)}>
              forgotten it?
            </button>
          )}
        </div>
        <div className="meta" style={{ marginTop: 10 }}>
          Unlocking takes about a second — that delay is deliberate, and it is what makes guessing the
          password impractical. {status.itemCount} {status.itemCount === 1 ? 'entry' : 'entries'} inside.
        </div>
      </form>
    </section>
  );
}

function RecoverVault({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [shareA, setShareA] = useState('');
  const [shareB, setShareB] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.vault.recover(shareA, shareB, next);
      onDone();
    } catch {
      setError('Those two shares did not open the vault. Check for typos — they are not case sensitive.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Recover with your kit</h2>
      <form className="card" onSubmit={submit}>
        <div className="meta" style={{ marginBottom: 10 }}>
          Enter both shares. You will set a new master password at the same time — recovering without
          replacing it would leave the vault open to whoever found the codes.
        </div>
        <input value={shareA} onChange={(e) => setShareA(e.target.value)} placeholder="Share 1" aria-label="Share 1" autoCapitalize="characters" spellCheck={false} />
        <div style={{ height: 8 }} />
        <input value={shareB} onChange={(e) => setShareB(e.target.value)} placeholder="Share 2" aria-label="Share 2" autoCapitalize="characters" spellCheck={false} />
        <div style={{ height: 8 }} />
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New master password" aria-label="New master password" autoComplete="new-password" />
        {error && <div className="banner">{error}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" type="submit" disabled={busy || next.length < MIN_MASTER_PASSWORD || !shareA || !shareB}>
            {busy ? 'recovering…' : 'Recover'}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Open                                                                */
/* ------------------------------------------------------------------ */

function OpenVault({ status, onLocked }: { status: VaultStatus; onLocked: () => void }) {
  const items = useAsync(() => api.vault.items());
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const lock = useCallback(async () => {
    await api.vault.lock();
    onLocked();
  }, [onLocked]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items.data ?? [];
    return (items.data ?? []).filter((item) =>
      [item.title, item.username, item.url].some((field) => field.toLowerCase().includes(needle))
    );
  }, [items.data, query]);

  return (
    <>
      <section>
        <div className="row between">
          <AutoLockCountdown expiresAt={status.expiresAt} onExpired={onLocked} />
          <button className="btn" onClick={lock}>
            Lock now
          </button>
        </div>
      </section>

      <section>
        <div className="row">
          <div className="grow">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search the vault" />
          </div>
          <button className="btn primary" onClick={() => setAdding(true)}>
            Add
          </button>
        </div>
      </section>

      {adding && (
        <EntryEditor
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            items.reload();
          }}
        />
      )}

      <section>
        {items.loading && <div className="empty">loading…</div>}
        {items.error && <div className="banner">{items.error.message}</div>}
        {!items.loading && filtered.length === 0 && (
          <div className="empty">{query ? 'Nothing matches.' : 'The vault is empty.'}</div>
        )}
        {filtered.map((item) =>
          openId === item.id ? (
            <EntryDetail key={item.id} item={item} onClose={() => setOpenId(null)} onChanged={items.reload} />
          ) : (
            <button
              key={item.id}
              className="card"
              style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => setOpenId(item.id)}
            >
              <div className="title">{item.title}</div>
              <div className="meta">
                {item.username || 'no username'}
                {item.url && ` · ${hostOf(item.url)}`}
              </div>
            </button>
          )
        )}
      </section>
    </>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Shows how long the vault stays open, because a silent auto-lock is startling. */
function AutoLockCountdown({ expiresAt, onExpired }: { expiresAt: number | null; onExpired: () => void }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (expiresAt && now >= expiresAt) onExpired();
  }, [now, expiresAt, onExpired]);

  if (!expiresAt) return <span className="meta">Unlocked</span>;
  const left = Math.max(0, expiresAt - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);

  return (
    <span className={`meta${left < 60_000 ? ' urgent' : ''}`}>
      Locks in {minutes}:{String(seconds).padStart(2, '0')}
    </span>
  );
}

function EntryDetail({ item, onClose, onChanged }: { item: VaultSummary; onClose: () => void; onChanged: () => void }) {
  const [secret, setSecret] = useState<VaultSecret | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState('');

  // Fetched on open, and dropped on close — secrets live in memory only as long
  // as the panel showing them.
  useEffect(() => {
    let live = true;
    api.vault.secret(item.id).then((value) => {
      if (live) setSecret(value);
    }, () => {});
    return () => {
      live = false;
      setSecret(null);
    };
  }, [item.id]);

  function copy(what: 'password' | 'username', value: string) {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied(''), 2000);
      },
      () => {}
    );
  }

  if (editing) {
    return (
      <EntryEditor
        item={item}
        secret={secret}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  return (
    <div className="card">
      <div className="row between">
        <div className="grow">
          <div className="title">{item.title}</div>
          {item.url && <div className="meta">{hostOf(item.url)}</div>}
        </div>
        <button className="btn subtle" onClick={onClose}>
          close
        </button>
      </div>

      {item.username && (
        <div className="row between" style={{ marginTop: 10 }}>
          <span className="meta grow">{item.username}</span>
          <button className="btn subtle" onClick={() => copy('username', item.username)}>
            {copied === 'username' ? 'copied' : 'copy user'}
          </button>
        </div>
      )}

      <div className="row between" style={{ marginTop: 6 }}>
        <code className="snippet grow" style={{ margin: 0 }}>
          {!secret ? '…' : revealed ? secret.password || '(none)' : '••••••••••••'}
        </code>
        <button className="btn subtle" onClick={() => setRevealed((v) => !v)} disabled={!secret}>
          {revealed ? 'hide' : 'show'}
        </button>
        <button className="btn" onClick={() => secret && copy('password', secret.password)} disabled={!secret}>
          {copied === 'password' ? 'copied' : 'copy'}
        </button>
      </div>

      {secret?.notes && (
        <div className="meta" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          {secret.notes}
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn subtle" onClick={() => setEditing(true)}>
          edit
        </button>
        <div className="grow" />
        {confirming ? (
          <>
            <span className="meta">delete for good?</span>
            <button
              className="btn subtle danger"
              onClick={() => api.vault.remove(item.id).then(() => { onChanged(); onClose(); })}
            >
              yes
            </button>
            <button className="btn subtle" onClick={() => setConfirming(false)}>
              no
            </button>
          </>
        ) : (
          <button className="btn subtle danger" onClick={() => setConfirming(true)}>
            delete
          </button>
        )}
      </div>
      <div className="meta" style={{ marginTop: 8 }}>changed {relative(item.updatedAt)}</div>
    </div>
  );
}

/** Uses the browser's CSPRNG, not Math.random. */
function generatePassword(length = 24): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  // Modulo bias is negligible against a 32-bit draw and a 69-character set.
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
}

function EntryEditor({
  item,
  secret,
  onClose,
  onSaved,
}: {
  item?: VaultSummary;
  secret?: VaultSecret | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [username, setUsername] = useState(item?.username ?? '');
  const [url, setUrl] = useState(item?.url ?? '');
  const [password, setPassword] = useState(secret?.password ?? '');
  const [notes, setNotes] = useState(secret?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (item) await api.vault.update(item.id, { title, username, url, password, notes });
      else await api.vault.create({ title, username, url, password, notes });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name" aria-label="Name" autoFocus />
      <div style={{ height: 8 }} />
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username or email" aria-label="Username" autoComplete="off" />
      <div style={{ height: 8 }} />
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" aria-label="Website" autoComplete="off" />
      <div style={{ height: 8 }} />
      <div className="row">
        <div className="grow">
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" autoComplete="off" />
        </div>
        <button className="btn" type="button" onClick={() => setPassword(generatePassword())}>
          Generate
        </button>
      </div>
      <div style={{ height: 8 }} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" aria-label="Notes" />

      <div className="meta" style={{ marginTop: 8 }}>
        The website address is what lets the browser extension offer this entry on the right page.
      </div>

      {error && <div className="banner">{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={save} disabled={!title.trim() || busy}>
          {busy ? 'saving…' : 'Save'}
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
