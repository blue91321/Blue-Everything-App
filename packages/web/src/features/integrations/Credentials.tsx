/**
 * The client id and secret for one provider, as text boxes.
 *
 * These used to be environment variables and nothing else, which meant setting
 * a provider up read "open a terminal, edit a file, restart the app" — exactly
 * the friction the three double-clickable files in the repo root exist to
 * remove. Nobody should need a terminal to use their own app.
 *
 * Three things here are deliberate:
 *
 *   - **A stored value is never sent back.** The box for a field that is already
 *     set renders *empty*, with a placeholder saying so. Round-tripping a secret
 *     through the page would put it in the DOM, the response cache and any
 *     devtools left open, to save one paste when changing it.
 *   - **Blank means "leave it".** Following from the above: a blank box is the
 *     normal state for a field that is set, so it cannot mean "erase". Clearing
 *     is its own button.
 *   - **The redirect URI comes from the server.** It depends on the port and on
 *     OAUTH_REDIRECT_BASE, so writing it into the instructions would be wrong
 *     for anyone who changed either — and wrong in a way whose only symptom is a
 *     rejected login with an error page that does not say why.
 */
import { useState } from 'react';
import { api, type CredentialFieldInfo, type ProviderInfo } from '../../api';

export function Credentials({ provider, reload }: { provider: ProviderInfo; reload: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  if (provider.credentialFields.length === 0) return null;

  const edited = Object.entries(values).filter(([, v]) => v.trim() !== '');

  const save = async () => {
    setBusy(true);
    setProblem('');
    setSaved(false);
    try {
      // Only what was actually typed. Untouched fields are omitted rather than
      // sent blank, which is what keeps a set secret from being wiped by
      // somebody correcting the id above it.
      await api.integrations.saveCredentials(provider.id, Object.fromEntries(edited));
      setValues({});
      setSaved(true);
      reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async (key: string) => {
    setBusy(true);
    setProblem('');
    try {
      // Explicit empty string, which the route reads as "clear it" — as
      // distinct from omitting the key, which means "leave it".
      await api.integrations.saveCredentials(provider.id, { [key]: '' });
      setValues((v) => ({ ...v, [key]: '' }));
      reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyRedirect = async () => {
    if (!provider.redirectUri) return;
    try {
      await navigator.clipboard.writeText(provider.redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the URI is selectable text either way,
      // so this is a convenience failing rather than the step failing.
      setProblem('Could not copy — select the address above and copy it by hand.');
    }
  };

  return (
    <div style={{ marginTop: '.75rem', display: 'grid', gap: '.6rem' }}>
      {provider.redirectUri && (
        <div>
          <div className="meta">
            Paste this into the provider as the redirect URI, exactly — a trailing slash is a rejected
            login.
          </div>
          <div className="row" style={{ alignItems: 'center', gap: '.4rem', marginTop: '.25rem' }}>
            <code className="snippet grow" style={{ margin: 0, wordBreak: 'break-all' }}>
              {provider.redirectUri}
            </code>
            <button type="button" className="btn subtle" onClick={copyRedirect}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {provider.credentialFields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={values[field.key] ?? ''}
          disabled={busy}
          onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
          onClear={() => clear(field.key)}
        />
      ))}

      <div className="row wrap row-actions">
        <button type="button" className="btn primary" disabled={busy || edited.length === 0} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="meta ok-text">Saved. No restart needed.</span>}
      </div>

      {problem && <div className="banner">{problem}</div>}
    </div>
  );
}

function Field({
  field,
  value,
  disabled,
  onChange,
  onClear,
}: {
  field: CredentialFieldInfo;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <label style={{ display: 'grid', gap: '.25rem' }}>
      <span className="meta">
        {field.label}
        {!field.required && ' (optional)'}
        {/*
          Where the current value came from. "Set in the environment" is worth
          saying out loud: it explains why the box is blank yet everything works,
          and why typing here will now take precedence.
        */}
        {field.source === 'env' && (
          <>
            {' '}— currently from <code>{field.envVar}</code>. Typing here overrides it.
          </>
        )}
        {field.source === 'app' && ' — saved here.'}
        {field.help && <> {field.help}</>}
      </span>

      <div className="row" style={{ gap: '.4rem' }}>
        <input
          className="grow"
          // `password` only for the genuinely secret one. Masking a client id
          // helps nobody and makes it impossible to check what you pasted.
          type={field.secret ? 'password' : 'text'}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.set ? 'Already set — type to replace' : `Paste the ${field.label.toLowerCase()}`}
          aria-label={field.label}
          autoComplete="off"
          spellCheck={false}
        />
        {/* Only offered for a value stored here. An env var is not ours to
            clear, and a button that silently did nothing would be worse. */}
        {field.source === 'app' && (
          <button type="button" className="btn subtle" disabled={disabled} onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    </label>
  );
}
