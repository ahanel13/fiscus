// SPDX-License-Identifier: AGPL-3.0-or-later
import { PASSWORD_RULES, passwordProblem } from '@fiscus/shared';
import { Check, Circle } from 'lucide-react';
import { useState } from 'react';
import { TextField } from './ui.js';

/**
 * A new password, with what it still needs ticked off as you type. The form won't submit until
 * it meets the policy; the server checks the same rules.
 */
export function NewPasswordField({
  label = 'Password',
  name = 'password',
}: {
  label?: string;
  name?: string;
}) {
  const [value, setValue] = useState('');
  return (
    <div className="space-y-2">
      <TextField
        label={label}
        name={name}
        type="password"
        autoComplete="new-password"
        isRequired
        value={value}
        onChange={setValue}
        validate={passwordProblem}
        // Read by screen readers; everyone else sees the checklist below, so it isn't said twice.
        description={
          <span className="sr-only">
            At least 15 characters, with uppercase and lowercase letters, a number, and a symbol.
          </span>
        }
      />
      <ul aria-hidden className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
        {PASSWORD_RULES.map((rule) => {
          const met = rule.test(value);
          return (
            <li
              key={rule.id}
              className={
                met
                  ? 'flex items-center gap-1.5 text-positive'
                  : 'flex items-center gap-1.5 text-muted'
              }
            >
              {met ? <Check className="size-3.5" /> : <Circle className="size-3.5" />}
              {rule.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
