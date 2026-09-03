import { forwardRef, useState, type InputHTMLAttributes } from 'react';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Stretches to the full width of its row (see App.css's .settings-wide-input) — pass this alongside that class in `className`. */
  wide?: boolean;
}

/**
 * A password `<input>` with an eye button to reveal it — every other prop
 * (value, onChange, placeholder, className for the input itself…) passes
 * straight through, same as a plain `<input type="password">` would.
 */
const PasswordInput = forwardRef<HTMLInputElement, Props>(function PasswordInput(
  { wide, className, ...rest },
  ref,
) {
  const [visible, setVisible] = useState(false);

  return (
    <span className={`password-field${wide ? ' password-field-wide' : ''}`}>
      <input ref={ref} type={visible ? 'text' : 'password'} className={className} {...rest} />
      <button
        type="button"
        className={`password-eye-toggle${visible ? ' active' : ''}`}
        title={visible ? 'Hide password' : 'Show password'}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        👁
      </button>
    </span>
  );
});

export default PasswordInput;
