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
  className?: string;
}

export function EmailPillsInput({
  value,
  onChange,
  placeholder = 'Add email…',
  label,
  helpText,
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
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addEmails(inputValue);
    } else if (e.key === 'Backspace' && inputValue === '' && value.length > 0) {
      // Remove last pill on backspace when input is empty
      removeEmail(value[value.length - 1]);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text');
    addEmails(pasted);
  };

  const handleBlur = () => {
    if (inputValue.trim()) {
      addEmails(inputValue);
    }
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      {label && <div className="text-sm text-gray-600">{label}</div>}
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus-within:ring-2 focus-within:ring-slate-400 focus-within:ring-offset-2',
          error && 'border-red-400'
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((email) => (
          <Badge
            key={email}
            className="inline-flex items-center gap-1 rounded-full border-slate-200 bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
          >
            {email}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeEmail(email);
              }}
              className="ml-0.5 rounded-full p-0.5 hover:bg-slate-200 focus:outline-none"
              aria-label={`Remove ${email}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="min-w-[120px] flex-1 border-none bg-transparent p-0 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-0"
          placeholder={value.length === 0 ? placeholder : ''}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={handleBlur}
        />
      </div>
      {error && <div className="text-xs text-red-500">{error}</div>}
      {helpText && !error && <div className="text-xs text-gray-500">{helpText}</div>}
    </div>
  );
}

