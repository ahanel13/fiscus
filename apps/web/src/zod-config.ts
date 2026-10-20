// SPDX-License-Identifier: AGPL-3.0-or-later
import { config } from 'zod';

// Zod compiles object schemas with `new Function` when it can, probing for that as each schema is
// built. The Content-Security-Policy forbids it (#378), so turn it off; parsing is the same without.
// Its own module, imported first by main.tsx, so this runs before any module builds a schema.
config({ jitless: true });
