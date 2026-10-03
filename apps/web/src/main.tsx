import './app.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, onUnauthenticated, resetCsrf } from './api/client.js';
import { createAppRouter } from './router.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Auth and "not found" answers won't change on retry.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});
const router = createAppRouter(queryClient);

// Session expired or revoked elsewhere: clear cached data and go to login, then come back.
onUnauthenticated(() => {
  const here = router.state.location;
  if (['/login', '/setup', '/signup', '/invite', '/reset-password'].includes(here.pathname)) return;
  queryClient.clear();
  resetCsrf();
  void router.navigate({ to: '/login', search: { redirect: here.href } });
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
