import { MEMBER_COLORS } from '@fiscus/shared';
import { ArrowLeftRight, Landmark, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Amount } from '../components/Amount.js';
import { Alert, Button, Card, Field, Input } from '../components/ui.js';
import { applyDensity, type Density, storedDensity } from '../lib/density.js';
import { applyTheme } from '../lib/theme.js';
import { contrast } from '../styles/contrast.js';

// The living style guide (docs/design/style-guide.md): renders the real tokens and components, so
// it can't drift from the code. Public and data-free, for contributors and design review.

const COLOR_TOKENS = [
  ['Canvas', 'bg'],
  ['Surface', 'surface'],
  ['Surface 2', 'surface-2'],
  ['Border', 'border'],
  ['Text', 'fg'],
  ['Muted text', 'muted'],
  ['Subtle', 'subtle'],
  ['Accent', 'accent'],
  ['Accent soft', 'accent-soft'],
  ['Money in', 'positive'],
  ['Danger', 'danger'],
  ['Warning', 'warning'],
] as const;

function useTokenValues(names: readonly string[]) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      setValues(Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()])));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [names]);
  return values;
}

const CHARTS = Array.from({ length: 8 }, (_, i) => `chart-${i + 1}`);
const ALL = [...COLOR_TOKENS.map(([, t]) => t), ...CHARTS];

export function StyleGuidePage() {
  const v = useTokenValues(ALL);
  const [density, setDensity] = useState<Density>(storedDensity);
  const section = 'space-y-4';
  return (
    <main className="mx-auto max-w-5xl space-y-12 px-4 py-10 md:px-8">
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <p className="text-sm font-semibold text-accent-text">Fiscus</p>
          <h1 className="text-3xl font-semibold tracking-tight">Style guide</h1>
          <p className="mt-1 text-muted">
            Calm, trustworthy, and clear about money. Tokens live in{' '}
            <code>src/styles/tokens.css</code>.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() =>
            applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark')
          }
        >
          Toggle theme
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            const d = density === 'compact' ? 'comfortable' : 'compact';
            setDensity(d);
            applyDensity(d);
          }}
        >
          {density === 'compact' ? 'Comfortable' : 'Compact'} density
        </Button>
      </header>

      <section className={section}>
        <h2 className="text-xl font-semibold">Color</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {COLOR_TOKENS.map(([label, token]) => (
            <div key={token} className="overflow-hidden rounded-lg border border-border bg-surface">
              <div className="h-14" style={{ background: `var(--${token})` }} />
              <div className="p-2 text-xs">
                <p className="font-medium">{label}</p>
                <p className="text-muted">
                  --{token} · {v[token]}
                </p>
                {v[token] && v.surface && token !== 'surface' ? (
                  <p className="text-muted">
                    {contrast(v[token]!, v.surface).toFixed(1)}:1 on surface
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Typography</h2>
        <p className="text-sm text-muted">
          Inter (bundled, never loaded from a third party). Figures are tabular wherever amounts
          align.
        </p>
        <Card className="space-y-3">
          <p className="text-3xl font-semibold tracking-tight">Display · 30 / semibold</p>
          <p className="text-2xl font-semibold">Page title · 24 / semibold</p>
          <p className="text-lg font-semibold">Section title · 18 / semibold</p>
          <p className="text-base">Body · 16 / regular. Clear, calm sentences in plain language.</p>
          <p className="text-sm text-muted">Secondary · 14 / regular, muted.</p>
          <p className="text-xs text-muted">Caption · 12 / regular, muted.</p>
          <p className="amount text-2xl font-semibold">$1,234,567.89 · $8,901.10 · $11.11</p>
        </Card>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Money</h2>
        <Card>
          <ul className="divide-y divide-border">
            {[
              [ArrowLeftRight, 'Paycheck', 'Income · Alex', 241000, 'flow'],
              [ArrowLeftRight, "Trader Joe's", 'Groceries · Ours', -8412, 'flow'],
              [Landmark, 'Joint checking', 'Balance', 513206, 'balance'],
              [Wallet, 'Dining out', 'Over budget', -12000, 'balance'],
            ].map(([Icon, title, meta, minor, kind]) => {
              const I = Icon as typeof Landmark;
              return (
                <li
                  key={title as string}
                  className="flex items-center gap-3"
                  style={{ minHeight: 'var(--row-h)', paddingInline: 'var(--cell-px)' }}
                >
                  <I aria-hidden className="size-4 text-muted" strokeWidth={1.75} />
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{title as string}</span>
                    <span className="block text-xs text-muted">{meta as string}</span>
                  </span>
                  <Amount
                    minor={minor as number}
                    currency="USD"
                    kind={kind as 'flow' | 'balance'}
                    className="text-sm font-medium"
                  />
                </li>
              );
            })}
          </ul>
        </Card>
        <p className="text-sm text-muted">
          Money in is green with "+". Money out is plain text with "−". Red is reserved for problems
          (overdraft, overspending). The sign and a screen-reader label always carry the meaning
          too.
        </p>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Members</h2>
        <div className="flex flex-wrap gap-4">
          {MEMBER_COLORS.map((c, i) => (
            <div key={c} className="flex items-center gap-2 text-sm">
              <span
                className="flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white"
                style={{ background: c }}
              >
                {'ABCDEFGH'[i]}
              </span>
              <code className="text-xs text-muted">{c}</code>
            </div>
          ))}
        </div>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Charts</h2>
        <p className="text-sm text-muted">
          Okabe–Ito based, safe for common color-vision deficiencies. Always paired with labels or
          legends.
        </p>
        <div className="flex h-40 items-end gap-2 rounded-lg border border-border bg-surface p-4">
          {CHARTS.map((c, i) => (
            <div key={c} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <div
                className="w-full rounded-t-md"
                style={{ background: `var(--${c})`, height: `${30 + ((i * 37) % 60)}%` }}
              />
              <span className="text-[10px] text-muted">{i + 1}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Controls</h2>
        <Card className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Remove</Button>
            <Button busy>Saving</Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Merchant" hint="As it appears on statements.">
              {(p) => <Input {...p} placeholder="Trader Joe's" />}
            </Field>
            <Field label="Amount" error="Enter an amount greater than zero.">
              {(p) => <Input {...p} defaultValue="0" />}
            </Field>
          </div>
          <Alert tone="info">Your bank needs you to sign in again to keep syncing.</Alert>
          <Alert tone="success">Split saved.</Alert>
          <Alert>Couldn't save: someone else changed this first.</Alert>
        </Card>
      </section>

      <section className={section}>
        <h2 className="text-xl font-semibold">Shape and depth</h2>
        <div className="flex flex-wrap gap-4">
          {/* Full class names, so Tailwind can see them at build time. */}
          {[
            ['radius sm', 'rounded-sm border border-border'],
            ['radius md', 'rounded-md border border-border'],
            ['radius lg', 'rounded-lg border border-border'],
            ['radius xl', 'rounded-xl border border-border'],
            ['shadow sm', 'rounded-lg shadow-sm'],
            ['shadow md', 'rounded-lg shadow-md'],
            ['shadow lg', 'rounded-lg shadow-lg'],
          ].map(([label, cls]) => (
            <div
              key={label}
              className={`flex size-20 items-center justify-center bg-surface text-xs text-muted ${cls}`}
            >
              {label}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
