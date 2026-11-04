// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StrategyRegistry } from './budget.js';
import { categoryLimits } from './category-limits.js';
import { flex } from './flex.js';
import { zeroBased } from './zero-based.js';

/** Every strategy that's built, for computeBudgetMonth(): the api, the recap and reminders. */
export const STRATEGY_REGISTRY: StrategyRegistry = {
  category: categoryLimits,
  flex,
  zero_based: zeroBased,
};
