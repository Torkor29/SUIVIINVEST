import { useId, useState, type InputHTMLAttributes } from 'react';
import { passwordStrength } from '../../lib/password.ts';

type NativeInput = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'>;

export interface TextFieldProps extends NativeInput {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly type?: 'text' | 'email';
}

/** Champ texte libellé, avec aide facultative sous le champ. */
export function TextField({ label, value, onChange, hint, type = 'text', ...rest }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        {...rest}
        id={id}
        className="input"
        type={type}
        value={value}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint !== undefined && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

export interface PasswordFieldProps extends NativeInput {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Affiche la jauge de robustesse (création / changement de mot de passe). */
  readonly showStrength?: boolean;
  readonly hint?: string;
}

/** Champ mot de passe avec bouton « Afficher » et jauge de robustesse. */
export function PasswordField({ label, value, onChange, showStrength = false, hint, ...rest }: PasswordFieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(value);
  const hintText = showStrength && value !== '' ? strength.label : hint;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="input-password">
        <input
          {...rest}
          id={id}
          className="input"
          type={visible ? 'text' : 'password'}
          value={value}
          aria-describedby={hintText === undefined ? undefined : `${id}-hint`}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="input-reveal"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Masquer la saisie' : 'Afficher la saisie'}
          aria-pressed={visible}
        >
          {visible ? 'Masquer' : 'Afficher'}
        </button>
      </div>
      {showStrength && (
        <div className="strength" data-level={strength.level} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
      {hintText !== undefined && hintText !== '' && (
        <span className="field-hint" id={`${id}-hint`}>
          {hintText}
        </span>
      )}
    </div>
  );
}
