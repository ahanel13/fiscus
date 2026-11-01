// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, useContext, useEffect } from 'react';

/** Sets the phone's top bar title; null gives it back to the section's name. */
export const ShellTitleContext = createContext<(title: string | null) => void>(() => undefined);

/** A page's title, shown in the phone's top bar while the page is. */
export function useShellTitle(title: string) {
  const set = useContext(ShellTitleContext);
  useEffect(() => {
    set(title);
    return () => set(null);
  }, [set, title]);
}
