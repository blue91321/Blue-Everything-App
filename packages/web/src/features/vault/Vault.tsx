import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ImportResult, type VaultSecret, type VaultStatus, type VaultSummary } from '../../api';
import { useAsync } from '../../useAsync';
import { relative } from '../../format';

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
  return <OpenVault status={state} onLocked={status.reload} onShares={setPendingShares} />;
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

        {/* The failure this warns about is a real one: a browser's "save
            password?" prompt appears at exactly the wrong moment and looks
            like the thing you were trying to do. */}
        <div className="banner" style={{ borderLeftColor: 'var(--danger)', marginTop: 12 }}>
          <strong>A "save password?" prompt from your browser is not this.</strong> Dismissing or accepting
          that prompt does <em>not</em> store a share. Go to{' '}
          <code>passwords.google.com</code>, add a note or entry yourself, and paste share 1 in by hand.
          Then come back and check you can actually see it there.
        </div>

        <div className="meta" style={{ marginTop: 10 }}>
          Both are needed together. Either one on its own reveals nothing at all — not "is hard to crack",
          but carries no information about the code. Keeping them in the same place defeats the point.
        </div>

        <label className="row" style={{ marginTop: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ width: 'auto' }} />
          <span className="grow title">
            I have stored both in two different places, and checked I can see them there
          </span>
        </label>

        <div className="meta" style={{ marginTop: 6 }}>
          If you lose one later, open the vault and make a new kit — you don't need the old one to do it.
        </div>

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

function OpenVault({
  status,
  onLocked,
  onShares,
}: {
  status: VaultStatus;
  onLocked: () => void;
  onShares: (shares: { a: string; b: string }) => void;
}) {
  const items = useAsync(() => api.vault.items());
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

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
          <button className="btn" onClick={() => setImporting((v) => !v)}>
            Import
          </button>
        </div>
      </section>

      {importing && <ImportPanel onClose={() => setImporting(false)} onImported={items.reload} />}

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

      <VaultDanger status={status} onShares={onShares} onDestroyed={onLocked} />
    </>
  );
}

/**
 * Recovery kit and deletion.
 *
 * Below the entries and behind confirmations, because both are things you want
 * once a year and never want to hit by accident.
 */
function VaultDanger({
  status,
  onShares,
  onDestroyed,
}: {
  status: VaultStatus;
  onShares: (shares: { a: string; b: string }) => void;
  onDestroyed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingKit, setConfirmingKit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');

  async function regenerate() {
    setBusy(true);
    setError('');
    try {
      const result = await api.vault.regenerateRecovery();
      setConfirmingKit(false);
      // Handed to the parent so a background refresh cannot unmount the only
      // screen these codes appear on.
      onShares(result.recoveryShares);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not make a new kit');
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    setBusy(true);
    setError('');
    try {
      await api.vault.destroy(deletePassword);
      setDeletePassword('');
      setDeleting(false);
      onDestroyed();
    } catch {
      setError('That password is wrong. Nothing was deleted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="done-area">
      <h2>Recovery kit</h2>
      <div className="card">
        <div className="meta">
          {status.hasRecovery
            ? 'This vault has a recovery kit. If you have lost either share, make a new one — a half-lost kit is worse than none, because whoever finds the surviving half is one step away instead of two.'
            : 'This vault has no recovery kit. Without one, forgetting the master password is final.'}
        </div>

        {confirmingKit ? (
          <>
            <div className="banner" style={{ borderLeftColor: 'var(--accent)' }}>
              The old shares stop working immediately. You will be shown two new ones, once.
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={regenerate} disabled={busy}>
                {busy ? 'creating…' : 'Yes, make a new kit'}
              </button>
              <button className="btn" onClick={() => setConfirmingKit(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => setConfirmingKit(true)}>
              {status.hasRecovery ? 'Replace recovery kit' : 'Create a recovery kit'}
            </button>
          </div>
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>Delete the vault</h2>
      <div className="card">
        <div className="meta">
          Deletes {status.itemCount} {status.itemCount === 1 ? 'entry' : 'entries'} and the vault itself.
          This cannot be undone by anyone — the entries are encrypted under a key that only exists inside
          what gets deleted, so no password or recovery kit brings them back.
        </div>

        {deleting ? (
          <>
            <div className="meta" style={{ marginTop: 10 }}>Type your master password to confirm.</div>
            <input
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder="Master password"
              aria-label="Master password to delete the vault"
              autoComplete="current-password"
              style={{ marginTop: 6 }}
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn subtle danger" onClick={destroy} disabled={busy || !deletePassword}>
                {busy ? 'deleting…' : 'Delete everything'}
              </button>
              <button className="btn" onClick={() => { setDeleting(false); setDeletePassword(''); }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn subtle danger" onClick={() => setDeleting(true)}>
              Delete vault
            </button>
          </div>
        )}
      </div>

      {error && <div className="banner">{error}</div>}
    </section>
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

/**
 * Bringing in a browser's saved passwords.
 *
 * Previews before it writes, because a mis-read layout would otherwise dump a
 * thousand mangled entries into the vault, and untangling that by hand is
 * worse than not importing at all.
 *
 * The file is read in the browser and posted to the server on this same
 * machine. It is never stored — but it is still every password Blake owns
 * sitting in his Downloads folder, which is why the last thing this screen
 * does is tell him to delete it.
 */
function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    setDone(null);
    setFileName(file.name);

    const text = await file.text();
    setCsv(text);
    setBusy(true);
    try {
      setPreview(await api.vault.importCsv(text, false));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : 'could not read that file');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError('');
    try {
      const result = await api.vault.importCsv(csv, true, includeDuplicates);
      setDone(result);
      // Drop the file contents from memory the moment they're no longer needed.
      setCsv('');
      setPreview(null);
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'import failed');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card">
        <div className="title">Imported {done.imported} {done.imported === 1 ? 'login' : 'logins'}</div>
        <div className="meta" style={{ marginTop: 4 }}>
          Read as {done.format}.
          {done.duplicates > 0 && ` ${done.duplicates} already existed and were left alone.`}
          {done.skippedWithoutPassword > 0 && ` ${done.skippedWithoutPassword} had no password and were ignored.`}
        </div>

        <div className="banner" style={{ borderLeftColor: 'var(--danger)', marginTop: 12 }}>
          <strong>Delete {fileName || 'the export file'} now.</strong> It holds every one of those passwords
          in plain text, and it is sitting in your Downloads folder where any program on this PC can read it.
          Empty the Recycle Bin too.
        </div>

        <div className="meta" style={{ marginTop: 8 }}>
          Worth doing next: turn off the browser's own password saving, so it stops collecting a second copy.
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row between">
        <div className="title">Import saved passwords</div>
        <button className="btn subtle" onClick={onClose}>
          close
        </button>
      </div>

      <div className="meta" style={{ marginTop: 6 }}>
        In Brave: <code>brave://password-manager/passwords</code> → Settings → Export. Chrome, Edge, Firefox,
        Bitwarden, Safari and KeePass exports all work.
      </div>

      <div style={{ marginTop: 10 }}>
        <input type="file" accept=".csv,text/csv" onChange={choose} aria-label="Password export file" />
      </div>

      {busy && <div className="meta" style={{ marginTop: 8 }}>reading…</div>}
      {error && <div className="banner">{error}</div>}

      {preview && (
        <>
          {/* `found` already excludes rows without a password, so importing
              duplicates too means importing exactly `found`. */}
          <div className="meta" style={{ marginTop: 10 }}>
            Read as <strong>{preview.format}</strong> — found {preview.found}, will add{' '}
            <strong>{includeDuplicates ? preview.found : preview.wouldImport}</strong>.
            {preview.duplicates > 0 && ` ${preview.duplicates} already in the vault.`}
            {preview.skippedWithoutPassword > 0 && ` ${preview.skippedWithoutPassword} had no password.`}
          </div>

          {preview.sample && preview.sample.length > 0 && (
            <div className="meta" style={{ marginTop: 6 }}>
              First few: {preview.sample.join(', ')}
              {/* Names only. A preview that showed passwords would just be a
                  second way to read the file. */}
            </div>
          )}

          {preview.duplicates > 0 && (
            <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeDuplicates}
                onChange={(e) => setIncludeDuplicates(e.target.checked)}
                style={{ width: 'auto' }}
              />
              <span className="meta grow">Add the {preview.duplicates} duplicates as well</span>
            </label>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={commit} disabled={busy || preview.wouldImport === 0}>
              {busy ? 'importing…' : `Import ${includeDuplicates ? preview.found : preview.wouldImport}`}
            </button>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
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
