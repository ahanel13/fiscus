// SPDX-License-Identifier: AGPL-3.0-or-later
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  redirect,
  type ToOptions,
  useRouter,
} from '@tanstack/react-router';
import { RouterProvider as AriaRouterProvider } from 'react-aria-components';
import { ApiError } from './api/client.js';
import { householdQuery, meQuery } from './api/queries.js';
import { AppShell } from './components/AppShell.js';
import { AuthLayout } from './components/AuthLayout.js';
import { Toaster } from './components/ui.js';
import { lastHousehold } from './lib/last-household.js';
import { type SectionId, SECTIONS } from './lib/nav.js';
import { AccountDetailPage, AccountsPage } from './routes/accounts.js';
import { DashboardPage } from './routes/dashboard.js';
import { TransactionsPage } from './routes/transactions.js';
import { InvitePage, LoginPage, ResetPasswordPage, SetupPage, SignupPage } from './routes/auth.js';
import { SectionPage } from './routes/section.js';
import { ImportPage } from './routes/import.js';
import { HouseholdSettingsPage, PersonalSettingsPage } from './routes/settings.js';
import { WelcomePage } from './routes/welcome.js';

interface Context {
  queryClient: QueryClient;
}

function NotFound() {
  return (
    <AuthLayout title="Not found">
      <p className="text-sm text-muted">
        This page doesn't exist, or you don't have access to it.{' '}
        <Link to="/" className="font-medium text-accent-text">
          Go home
        </Link>
      </p>
    </AuthLayout>
  );
}

declare module 'react-aria-components' {
  interface RouterConfig {
    href: ToOptions['to'];
    routerOptions: Omit<ToOptions, 'to'>;
  }
}

/** Lets React Aria links and menu items navigate with the router, without a page load. */
function Root() {
  const router = useRouter();
  return (
    <AriaRouterProvider
      navigate={(to, options) => void router.navigate({ to, ...options })}
      useHref={(to) => router.buildLocation({ to }).href}
    >
      <Outlet />
      <Toaster />
    </AriaRouterProvider>
  );
}

const rootRoute = createRootRouteWithContext<Context>()({
  component: Root,
  notFoundComponent: NotFound,
});

const loginSearch = (s: Record<string, unknown>) => ({
  redirect: typeof s.redirect === 'string' ? s.redirect : undefined,
});
const publicRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    validateSearch: loginSearch,
    component: LoginPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/signup', component: SignupPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/invite', component: InvitePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/reset-password',
    component: ResetPasswordPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/styleguide',
    // Loaded on demand: contributors and design review use it, households don't.
    component: lazyRouteComponent(() => import('./routes/styleguide.js'), 'StyleGuidePage'),
  }),
];

/** Everything below requires a session; a 401 sends you to login and back afterwards. */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async ({ context, location }) => {
    try {
      return { me: await context.queryClient.ensureQueryData(meQuery) };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw err;
    }
  },
  component: Outlet,
});

/** Land in the last household you used, else your first, else create one. */
const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  beforeLoad: ({ context }) => {
    const ids = context.me.memberships.map((m) => m.householdId);
    const last = lastHousehold();
    const target = last && ids.includes(last) ? last : ids[0];
    throw target ? redirect({ to: `/h/${target}` }) : redirect({ to: '/welcome' });
  },
});

const welcomeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/welcome',
  component: WelcomePage,
});
const personalSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/settings',
  component: PersonalSettingsPage,
});

const householdRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/h/$householdId',
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(householdQuery(params.householdId)),
  component: AppShell,
  errorComponent: NotFound,
});

/** Sections that have shipped; the rest show their "on the way" page. */
const SECTION_PAGES: Partial<Record<SectionId, () => React.JSX.Element>> = {
  dashboard: DashboardPage,
  accounts: AccountsPage,
  transactions: TransactionsPage,
};

const sectionRoutes = SECTIONS.map((section) =>
  createRoute({
    getParentRoute: () => householdRoute,
    path: section.path || '/',
    component: SECTION_PAGES[section.id] ?? (() => <SectionPage section={section} />),
  }),
);
const accountDetailRoute = createRoute({
  getParentRoute: () => householdRoute,
  path: '/accounts/$accountId',
  component: AccountDetailPage,
});
const importRoute = createRoute({
  getParentRoute: () => householdRoute,
  path: '/import',
  component: ImportPage,
});
const householdSettingsRoute = createRoute({
  getParentRoute: () => householdRoute,
  path: '/settings',
  component: HouseholdSettingsPage,
});

const routeTree = rootRoute.addChildren([
  ...publicRoutes,
  authedRoute.addChildren([
    homeRoute,
    welcomeRoute,
    personalSettingsRoute,
    householdRoute.addChildren([
      ...sectionRoutes,
      accountDetailRoute,
      importRoute,
      householdSettingsRoute,
    ]),
  ]),
]);

export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });
