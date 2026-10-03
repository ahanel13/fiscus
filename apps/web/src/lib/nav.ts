import {
  ArrowLeftRight,
  BarChart3,
  Bot,
  Calendar,
  Goal,
  Home,
  Landmark,
  type LucideIcon,
  PieChart,
  Scale,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import type { Household } from '@fiscus/shared';

export type SectionId =
  | 'dashboard'
  | 'accounts'
  | 'transactions'
  | 'recurring'
  | 'budget'
  | 'goals'
  | 'planning'
  | 'reports'
  | 'investments'
  | 'shared'
  | 'assistant';

export interface Section {
  id: SectionId;
  label: string;
  /** Path under /h/:householdId ('' for the dashboard). */
  path: string;
  icon: LucideIcon;
  group: 'overview' | 'money' | 'plan' | 'analyze' | 'together' | 'tools';
  /** Second key of the `g <key>` jump shortcut. */
  shortcut?: string;
  /** Whether the page header shows a time range (ADR 0011). */
  hasRange: boolean;
  /** One-sentence empty-state explanation until the feature ships. */
  blurb: string;
  milestone: string;
}

// The information architecture (docs/design/information-architecture.md), in nav order.
export const SECTIONS: Section[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: '',
    icon: Home,
    group: 'overview',
    shortcut: 'd',
    hasRange: true,
    blurb: 'Where you stand: net worth, cash flow, budget, upcoming bills, and what needs review.',
    milestone: 'M1',
  },
  {
    id: 'accounts',
    label: 'Accounts',
    path: 'accounts',
    icon: Landmark,
    group: 'money',
    shortcut: 'a',
    hasRange: true,
    blurb: 'Every account with balances and history, who owns it, and who can see it.',
    milestone: 'M1',
  },
  {
    id: 'transactions',
    label: 'Transactions',
    path: 'transactions',
    icon: ArrowLeftRight,
    group: 'money',
    shortcut: 't',
    hasRange: true,
    blurb:
      'Review, categorize, split, and attribute every transaction. Receipts wait here to be matched.',
    milestone: 'M1',
  },
  {
    id: 'recurring',
    label: 'Bills & recurring',
    path: 'recurring',
    icon: Calendar,
    group: 'money',
    hasRange: false,
    blurb: 'Upcoming bills, subscriptions, and credit card due dates in one calendar.',
    milestone: 'M4',
  },
  {
    id: 'budget',
    label: 'Budget',
    path: 'budget',
    icon: Wallet,
    group: 'plan',
    shortcut: 'b',
    hasRange: false,
    blurb: 'Zero-based, 50/30/20, flex, or per-category budgets, shared or personal.',
    milestone: 'M3',
  },
  {
    id: 'goals',
    label: 'Goals',
    path: 'goals',
    icon: Goal,
    group: 'plan',
    shortcut: 'g',
    hasRange: false,
    blurb: 'Save up or pay down, with progress and contributions from each person.',
    milestone: 'M5',
  },
  {
    id: 'planning',
    label: 'Planning',
    path: 'planning',
    icon: TrendingUp,
    group: 'plan',
    shortcut: 'p',
    hasRange: false,
    blurb: 'Cash-flow forecast, retirement, FIRE, and side-by-side scenarios.',
    milestone: 'M8',
  },
  {
    id: 'reports',
    label: 'Reports',
    path: 'reports',
    icon: BarChart3,
    group: 'analyze',
    shortcut: 'r',
    hasRange: true,
    blurb: 'Cash flow, spending, net worth, Sankey, and treemaps, with drill-down.',
    milestone: 'M7',
  },
  {
    id: 'investments',
    label: 'Investments',
    path: 'investments',
    icon: PieChart,
    group: 'analyze',
    shortcut: 'i',
    hasRange: true,
    blurb: 'Holdings, performance, allocation, and equity compensation.',
    milestone: 'M6',
  },
  {
    id: 'shared',
    label: 'Shared costs',
    path: 'shared',
    icon: Scale,
    group: 'together',
    shortcut: 's',
    hasRange: true,
    blurb: 'Who owes whom, split rules, joint-account funding, and allowances.',
    milestone: 'M3',
  },
  {
    id: 'assistant',
    label: 'Assistant',
    path: 'assistant',
    icon: Bot,
    group: 'tools',
    hasRange: false,
    blurb: 'Ask about your money and let the assistant propose changes you review.',
    milestone: 'M10',
  },
];

export const GROUP_LABELS: Record<Section['group'], string | null> = {
  overview: null,
  money: 'Money',
  plan: 'Plan',
  analyze: 'Analyze',
  together: 'Together',
  tools: null,
};

/** Which sections a household sees (information architecture §5). */
export function visibleSections(
  household: Pick<Household, 'financeStyle'>,
  memberCount: number,
  { assistantEnabled = false } = {},
): Section[] {
  const shared = memberCount > 1 && household.financeStyle !== 'combined';
  const sections = SECTIONS.filter(
    (s) => (s.id !== 'shared' || shared) && (s.id !== 'assistant' || assistantEnabled),
  );
  // Roommates: Shared costs leads the nav.
  if (household.financeStyle === 'roommates' && shared) {
    const idx = sections.findIndex((s) => s.id === 'shared');
    const [item] = sections.splice(idx, 1);
    sections.splice(1, 0, { ...item!, group: 'overview' });
  }
  return sections;
}

/** Phone bottom tabs (information architecture §3): Roommates swap Accounts for Shared costs. */
export function phoneTabs(
  household: Pick<Household, 'financeStyle'>,
  memberCount: number,
): SectionId[] {
  const roommates = household.financeStyle === 'roommates' && memberCount > 1;
  return ['dashboard', 'transactions', 'budget', roommates ? 'shared' : 'accounts'];
}

export const sectionPath = (householdId: string, section: Pick<Section, 'path'>) =>
  `/h/${householdId}${section.path ? `/${section.path}` : ''}`;
