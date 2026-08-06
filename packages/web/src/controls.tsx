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
