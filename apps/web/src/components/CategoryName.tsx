// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Category } from '@fiscus/shared';

/** A category's icon (an emoji, #423) before its name, as Monarch shows it. */
export function CategoryName({ c }: { c: Pick<Category, 'name' | 'icon'> }) {
  return (
    <>
      {c.icon ? (
        <span aria-hidden className="mr-1.5 inline-block w-[1.25em] text-center">
          {c.icon}
        </span>
      ) : null}
      {c.name}
    </>
  );
}
