// SPDX-License-Identifier: AGPL-3.0-or-later
import { categories, categoryGroups, type Executor, tags, transactions } from '@fiscus/db';
import type {
  Category,
  CategoryGroup,
  createCategoryGroupSchema,
  createCategorySchema,
  createTagSchema,
  Tag,
  updateCategoryGroupSchema,
  updateCategorySchema,
  updateTagSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { violatedConstraint } from '../common/db-errors.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type CategoryRow = typeof categories.$inferSelect;

const toCategory = (c: CategoryRow): Category => ({
  id: c.id,
  groupId: c.groupId,
  name: c.name,
  icon: c.icon,
  systemKey: c.systemKey as Category['systemKey'],
  archived: c.archivedAt !== null,
  sortOrder: c.sortOrder,
});

const duplicateTag = (err: unknown): never => {
  if (violatedConstraint(err) === 'tags_name') {
    throw new Problem(409, 'duplicate_tag', 'A tag with that name already exists');
  }
  throw err;
};

/**
 * The household's categories, groups, and tags (CAT-01–04): everyone reads them; owners and
 * members change them (the controller checks roles).
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly scope: HouseholdScope) {}

  async list(ctx: HouseholdContext): Promise<CategoryGroup[]> {
    return this.scope.run(ctx, async (tx) => {
      const groups = await tx.select().from(categoryGroups).orderBy(asc(categoryGroups.sortOrder));
      const cats = await tx
        .select()
        .from(categories)
        .orderBy(asc(categories.sortOrder), asc(categories.name));
      return groups.map((g) => ({
        id: g.id,
        name: g.name,
        kind: g.kind,
        sortOrder: g.sortOrder,
        categories: cats.filter((c) => c.groupId === g.id).map(toCategory),
      }));
    });
  }

  async createGroup(ctx: HouseholdContext, input: z.infer<typeof createCategoryGroupSchema>) {
    return this.scope.run(ctx, async (tx, activity) => {
      const [{ n }] = (await tx.select({ n: count() }).from(categoryGroups)) as [{ n: number }];
      const [group] = await tx
        .insert(categoryGroups)
        .values({ householdId: ctx.householdId, ...input, sortOrder: n + 1 })
        .returning();
      await activity.record({
        action: 'category_group.created',
        targetType: 'category_group',
        targetId: group!.id,
        metadata: { kind: input.kind },
      });
      return {
        id: group!.id,
        name: group!.name,
        kind: group!.kind,
        sortOrder: group!.sortOrder,
        categories: [],
      };
    });
  }

  async updateGroup(
    ctx: HouseholdContext,
    id: string,
    patch: z.infer<typeof updateCategoryGroupSchema>,
  ) {
    await this.scope.run(ctx, async (tx, activity) => {
      const [updated] = await tx
        .update(categoryGroups)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(categoryGroups.id, id))
        .returning({ id: categoryGroups.id });
      if (!updated) throw problems.notFound();
      await activity.record({
        action: 'category_group.updated',
        targetType: 'category_group',
        targetId: id,
        metadata: { fields: Object.keys(patch) },
      });
    });
  }

  /** Only empty groups can be deleted: move or delete their categories first. */
  async deleteGroup(ctx: HouseholdContext, id: string) {
    await this.scope.run(ctx, async (tx, activity) => {
      const [group] = await tx.select().from(categoryGroups).where(eq(categoryGroups.id, id));
      if (!group) throw problems.notFound();
      const [{ n }] = (await tx
        .select({ n: count() })
        .from(categories)
        .where(eq(categories.groupId, id))) as [{ n: number }];
      if (n > 0)
        throw new Problem(409, 'group_not_empty', 'Move or delete this group’s categories first');
      await tx.delete(categoryGroups).where(eq(categoryGroups.id, id));
      await activity.record({
        action: 'category_group.deleted',
        targetType: 'category_group',
        targetId: id,
      });
    });
  }

  async createCategory(
    ctx: HouseholdContext,
    input: z.infer<typeof createCategorySchema>,
  ): Promise<Category> {
    return this.scope.run(ctx, async (tx, activity) => {
      await this.#group(tx, input.groupId);
      const [{ n }] = (await tx
        .select({ n: count() })
        .from(categories)
        .where(eq(categories.groupId, input.groupId))) as [{ n: number }];
      const [row] = await tx
        .insert(categories)
        .values({
          householdId: ctx.householdId,
          groupId: input.groupId,
          name: input.name,
          icon: input.icon ?? null,
          sortOrder: n + 1,
        })
        .returning();
      await activity.record({
        action: 'category.created',
        targetType: 'category',
        targetId: row!.id,
        changes: { after: { name: input.name } },
      });
      return toCategory(row!);
    });
  }

  async updateCategory(
    ctx: HouseholdContext,
    id: string,
    patch: z.infer<typeof updateCategorySchema>,
  ): Promise<Category> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [row] = await tx.select().from(categories).where(eq(categories.id, id));
      if (!row) throw problems.notFound();
      if (patch.groupId) await this.#group(tx, patch.groupId);
      if (patch.archived && row.systemKey) {
        throw new Problem(
          409,
          'system_category',
          'This category is built in and can’t be archived',
        );
      }
      const { archived, ...columns } = patch;
      const [updated] = await tx
        .update(categories)
        .set({
          ...columns,
          ...(archived !== undefined
            ? { archivedAt: archived ? (row.archivedAt ?? new Date()) : null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(categories.id, id))
        .returning();
      await activity.record({
        action: 'category.updated',
        targetType: 'category',
        targetId: id,
        metadata: { fields: Object.keys(patch) },
        changes: { before: { name: row.name }, after: { name: updated!.name } },
      });
      return toCategory(updated!);
    });
  }

  /**
   * CAT-03/04: deleting a category in use moves its transactions to `replaceWith`, including
   * ones the caller can't see. The reply counts only the moved transactions they can see.
   */
  async deleteCategory(
    ctx: HouseholdContext,
    id: string,
    replaceWith: string | undefined,
  ): Promise<{ moved: number }> {
    const { row, visible } = await this.scope.run(ctx, async (tx) => {
      const [row] = await tx.select().from(categories).where(eq(categories.id, id));
      if (!row) throw problems.notFound();
      if (row.systemKey)
        throw new Problem(409, 'system_category', 'This category is built in and can’t be deleted');
      if (replaceWith) {
        const [target] = await tx
          .select()
          .from(categories)
          .where(
            and(
              eq(categories.id, replaceWith),
              ne(categories.id, id),
              isNull(categories.archivedAt),
            ),
          );
        if (!target)
          throw new Problem(422, 'invalid_category', 'Choose another existing category to move to');
      }
      const [{ n }] = (await tx
        .select({ n: count() })
        .from(transactions)
        .where(eq(transactions.categoryId, id))) as [{ n: number }];
      return { row, visible: n };
    });
    // Reassigning everything reaches rows hidden from the caller, through definer functions that
    // check they're a member who may (#271). The activity records the caller as the actor.
    await this.scope.run(ctx, async (tx, activity) => {
      const { rows } = await tx.execute<{ used: boolean }>(
        sql`SELECT fiscus_category_in_use(${id}) AS used`,
      );
      if (rows[0]?.used && !replaceWith) {
        throw new Problem(
          409,
          'category_in_use',
          'Choose a category to move its transactions to',
          undefined,
          undefined,
          {},
          { visibleTransactions: visible },
        );
      }
      if (rows[0]?.used) {
        await tx.execute(sql`SELECT fiscus_reassign_category(${id}, ${replaceWith!})`);
      }
      await tx.delete(categories).where(eq(categories.id, id));
      await activity.record({
        action: 'category.deleted',
        targetType: 'category',
        targetId: id,
        metadata: { replacedWith: replaceWith ?? null },
        changes: { before: { name: row.name } },
      });
    });
    return { moved: visible };
  }

  async listTags(ctx: HouseholdContext): Promise<Tag[]> {
    return this.scope.run(ctx, async (tx) =>
      (await tx.select().from(tags).orderBy(asc(tags.name))).map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
      })),
    );
  }

  async createTag(ctx: HouseholdContext, input: z.infer<typeof createTagSchema>): Promise<Tag> {
    return this.scope
      .run(ctx, async (tx, activity) => {
        const [t] = await tx
          .insert(tags)
          .values({ householdId: ctx.householdId, ...input })
          .returning();
        await activity.record({
          action: 'tag.created',
          targetType: 'tag',
          targetId: t!.id,
          changes: { after: input },
        });
        return { id: t!.id, name: t!.name, color: t!.color };
      })
      .catch(duplicateTag);
  }

  async updateTag(
    ctx: HouseholdContext,
    id: string,
    patch: z.infer<typeof updateTagSchema>,
  ): Promise<Tag> {
    return this.scope
      .run(ctx, async (tx, activity) => {
        const [t] = await tx
          .update(tags)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(tags.id, id))
          .returning();
        if (!t) throw problems.notFound();
        await activity.record({
          action: 'tag.updated',
          targetType: 'tag',
          targetId: id,
          metadata: { fields: Object.keys(patch) },
        });
        return { id: t.id, name: t.name, color: t.color };
      })
      .catch(duplicateTag);
  }

  /** Removes the tag from every transaction, including ones the caller can't see. */
  async deleteTag(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [t] = await tx.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id });
      if (!t) throw problems.notFound();
      await activity.record({ action: 'tag.deleted', targetType: 'tag', targetId: id });
    });
  }

  async #group(tx: Executor, groupId: string) {
    const [g] = await tx
      .select({ id: categoryGroups.id })
      .from(categoryGroups)
      .where(eq(categoryGroups.id, groupId));
    if (!g) throw new Problem(422, 'invalid_group', 'Choose an existing group');
  }
}
