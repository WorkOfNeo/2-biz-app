'use client';
import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Badge } from './ui/badge';

// Strict email regex (RFC 5322 simplified)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/** Parse raw input/paste into candidate tokens (comma, semicolon, whitespace, newline) */
function tokenize(raw: string): string[] {
  return raw
    .split(/[,;\s\n]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export interface EmailPillsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  label?: string;
  helpText?: string;
  disabled?: boolean;
  className?: string;
}

export function EmailPillsInput({
  value,
  onChange,
  placeholder = 'Add email…',
  label,
  helpText,
  disabled = false,
  className,
}: EmailPillsInputProps) {
  const [inputValue, setInputValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const addEmails = React.useCallback(
    (raw: string) => {
      const tokens = tokenize(raw);
      if (tokens.length === 0) return;

      const invalid: string[] = [];
      const toAdd: string[] = [];

      for (const token of tokens) {
        if (!isValidEmail(token)) {
          invalid.push(token);
        } else if (!value.includes(token) && !toAdd.includes(token)) {
          toAdd.push(token);
        }
      }

      if (invalid.length > 0) {
        setError(`Invalid: ${invalid.join(', ')}`);
      } else {
        setError(null);
      }

      if (toAdd.length > 0) {
        onChange([...value, ...toAdd]);
      }

      setInputValue('');
    },
    [value, onChange]
  );

  const removeEmail = React.useCallback(
    (email: string) => {
      onChange(value.filter((e) => e !== email));
    },
    [value, onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addEmails(inputValue);
    } else if (e.key === 'Backspace' && inputValue === '' && value.length > 0) {
      // Remove last pill on backspace when input is empty
      const lastEmail = value[value.length - 1];
      if (lastEmail) removeEmail(lastEmail);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData('text');
    addEmails(pasted);
  };

  const handleBlur = () => {
    if (disabled) return;
    if (inputValue.trim()) {
      addEmails(inputValue);
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      {/* Label + Input row */}
      <div className="flex items-center gap-3">
        {label && <div className="text-sm text-gray-600 shrink-0">{label}</div>}
        <input
          ref={inputRef}
          type="text"
          className={cn(
            'h-8 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2',
            error && 'border-red-400',
            disabled && 'opacity-60 pointer-events-none bg-slate-50'
          )}
          placeholder={placeholder}
          value={inputValue}
          disabled={disabled}
          onChange={(e) => {
            setInputValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={handleBlur}
        />
      </div>

      {/* Error / Help text */}
      {error && <div className="text-xs text-red-500">{error}</div>}
      {helpText && !error && <div className="text-xs text-gray-500">{helpText}</div>}

      {/* Pills below */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((email) => (
            <Badge
              key={email}
              className="inline-flex items-center gap-1 rounded-full border-slate-200 bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
            >
              {email}
              <button
                type="button"
                onClick={() => removeEmail(email)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-slate-300 focus:outline-none transition-colors"
                aria-label={`Remove ${email}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

