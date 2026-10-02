import { formatMoney } from '@fiscus/shared';

// Placeholder until the app shell lands in #30.
export function App() {
  return (
    <main>
      <h1>Fiscus</h1>
      <p>Scaffold is running. Sample amount: {formatMoney(-4580, 'USD')}</p>
    </main>
  );
}
