/**
 * Plain controls shared between screens.
 *
 * Not a component library — this exists because Settings and Voice both need a
 * switch, and two copies of one would eventually drift apart on the part that
 * matters least visually and most otherwise (the ARIA role).
 */

export function Toggle({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  );
}

/**
 * Whether one task or habit may reach the phone, in three states.
 *
 * A plain switch would have to pick a side for "I haven't decided", and picking
 * either loses something real: stamped-on it stops following the default the
 * moment you change your mind about the default, and left off it makes the
 * common case look deliberately refused. So *Default* is a value you can see and
 * come back to, and it says what the default currently is rather than making
 * you go and look.
 *
 * Three buttons rather than a dropdown because there are three of them and they
 * are the whole choice — a `<select>` hides two thirds of an answer behind a
 * click, on a control most people set once and never touch.
 */
export function PushChoice({
  value,
  fallback,
  onChange,
}: {
  /** null follows `fallback`. */
  value: boolean | null;
  /** What Settings currently says, for labelling the Default option. */
  fallback: boolean;
  onChange: (next: boolean | null) => void;
}) {
  const options: { key: string; label: string; value: boolean | null }[] = [
    { key: 'default', label: `Default (${fallback ? 'yes' : 'no'})`, value: null },
    { key: 'yes', label: 'Yes', value: true },
    { key: 'no', label: 'No', value: false },
  ];

  return (
    <div className="row wrap" role="group" aria-label="Send this to my phone when I am away">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={`btn${option.value === value ? ' primary' : ' subtle'}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
