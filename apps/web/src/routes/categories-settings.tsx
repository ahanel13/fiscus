// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Category, CategoryGroup, Tag } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { categoriesQuery, tagsQuery } from '../api/queries.js';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogTrigger,
  Form,
  Select,
  SelectItem,
  SelectSection,
  TextField,
  toast,
  Tooltip,
} from '../components/ui.js';

const base = (householdId: string) => `/api/v1/households/${householdId}`;
const TAG_COLORS = [
  '#2f6fdb',
  '#c2410c',
  '#7c4dcc',
  '#be3d86',
  '#0e7490',
  '#6b7d1f',
  '#9a5b34',
  '#5d6f8a',
];

/** Categories and tags (CAT-01–04), in household settings. Viewers see them read-only. */
export function CategoriesSettings({
  householdId,
  canEdit,
}: {
  householdId: string;
  canEdit: boolean;
}) {
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  const tags = useQuery(tagsQuery(householdId)).data ?? [];
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['households', householdId, 'categories'] }),
      queryClient.invalidateQueries({ queryKey: ['households', householdId, 'tags'] }),
      queryClient.invalidateQueries({ queryKey: ['households', householdId, 'transactions'] }),
    ]);
  const onError = (e: unknown) =>
    toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' });
  const call = useMutation({
    mutationFn: ({
      method,
      path,
      body,
    }: {
      method: 'POST' | 'PATCH' | 'DELETE';
      path: string;
      body?: unknown;
    }) =>
      api<{ data?: { moved?: number } }>(
        method,
        `${base(householdId)}${path}`,
        body === undefined ? {} : { body },
      ),
    onSuccess: refresh,
    onError,
  });

  return (
    <>
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Categories</h2>
        </div>
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`group-${g.id}`}>
              <div className="mb-1 flex items-center gap-2">
                <h3 id={`group-${g.id}`} className="text-sm font-semibold">
                  {g.name}
                </h3>
                {KIND_LABELS[g.kind] !== g.name ? <Badge>{KIND_LABELS[g.kind]}</Badge> : null}
                {canEdit ? (
                  <NameDialog
                    title="Add a category"
                    label="Category name"
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Add a category to ${g.name}`}
                        className="ml-auto"
                      >
                        <Plus aria-hidden className="size-4" />
                      </Button>
                    }
                    onSave={(name) =>
                      call
                        .mutateAsync({
                          method: 'POST',
                          path: '/categories',
                          body: { name, groupId: g.id },
                        })
                        .then(() => toast(`${name} added.`))
                    }
                  />
                ) : null}
              </div>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {g.categories.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className={c.archived ? 'flex-1 text-muted line-through' : 'flex-1'}>
                      {c.name}
                    </span>
                    {c.systemKey ? <Badge>Built in</Badge> : null}
                    {c.archived ? <Badge>Archived</Badge> : null}
                    {canEdit ? (
                      <CategoryActions
                        c={c}
                        groups={groups}
                        onRename={(name) =>
                          call.mutateAsync({
                            method: 'PATCH',
                            path: `/categories/${c.id}`,
                            body: { name },
                          })
                        }
                        onArchive={(archived) =>
                          call.mutate({
                            method: 'PATCH',
                            path: `/categories/${c.id}`,
                            body: { archived },
                          })
                        }
                        onDelete={(replaceWith) =>
                          call
                            .mutateAsync({
                              method: 'DELETE',
                              path: `/categories/${c.id}${replaceWith ? `?replaceWith=${replaceWith}` : ''}`,
                            })
                            .then((r) =>
                              toast(`${c.name} deleted.`, {
                                ...(r.data?.moved
                                  ? { description: `${r.data.moved} transactions moved.` }
                                  : {}),
                              }),
                            )
                        }
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Tags</h2>
          {canEdit ? (
            <NameDialog
              title="Add a tag"
              label="Tag name"
              trigger={
                <Button variant="secondary" size="sm">
                  <Plus aria-hidden className="size-4" /> Add tag
                </Button>
              }
              onSave={(name) =>
                call
                  .mutateAsync({
                    method: 'POST',
                    path: '/tags',
                    body: { name, color: TAG_COLORS[tags.length % TAG_COLORS.length] },
                  })
                  .then(() => toast(`${name} added.`))
              }
            />
          ) : null}
        </div>
        {tags.length === 0 ? (
          <p className="text-sm text-muted">
            Tags label transactions across categories, like “Vacation 2026” or “Tax deductible”.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {tags.map((t: Tag) => (
              <li
                key={t.id}
                className="flex items-center gap-1.5 rounded-full border border-border py-0.5 pr-1 pl-3 text-sm"
              >
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ background: t.color }}
                />
                {t.name}
                {canEdit ? (
                  <Tooltip content="Delete tag">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete tag ${t.name}`}
                      className="px-1.5"
                      onPress={() => call.mutate({ method: 'DELETE', path: `/tags/${t.id}` })}
                    >
                      <Trash2 aria-hidden className="size-3.5" />
                    </Button>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

const KIND_LABELS: Record<CategoryGroup['kind'], string> = {
  income: 'Income',
  fixed: 'Fixed',
  flexible: 'Flexible',
  non_monthly: 'Non-monthly',
  savings: 'Savings',
  transfer: 'Transfers',
};

function NameDialog({
  title,
  label,
  trigger,
  initial = '',
  onSave,
}: {
  title: string;
  label: string;
  trigger: React.ReactNode;
  initial?: string;
  onSave: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(initial);
  return (
    <DialogTrigger>
      {trigger}
      <Dialog title={title} size="sm">
        {(close) => (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void onSave(name.trim()).then(close);
            }}
          >
            <TextField
              label={label}
              value={name}
              onChange={setName}
              isRequired
              maxLength={60}
              autoFocus
            />
            <DialogActions>
              <Button variant="secondary" onPress={close}>
                Cancel
              </Button>
              <Button type="submit" isDisabled={!name.trim()}>
                Save
              </Button>
            </DialogActions>
          </Form>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function CategoryActions({
  c,
  groups,
  onRename,
  onArchive,
  onDelete,
}: {
  c: Category;
  groups: CategoryGroup[];
  onRename: (name: string) => Promise<unknown>;
  onArchive: (archived: boolean) => void;
  onDelete: (replaceWith: string | null) => Promise<unknown>;
}) {
  const [replaceWith, setReplaceWith] = useState<string | null>(null);
  return (
    <>
      <NameDialog
        title="Rename category"
        label="Category name"
        initial={c.name}
        trigger={
          <Button variant="ghost" size="sm" aria-label={`Rename ${c.name}`} className="px-1.5">
            <Pencil aria-hidden className="size-3.5" />
          </Button>
        }
        onSave={onRename}
      />
      {c.systemKey ? null : (
        <>
          <Tooltip content={c.archived ? 'Restore' : 'Archive'}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${c.archived ? 'Restore' : 'Archive'} ${c.name}`}
              className="px-1.5"
              onPress={() => onArchive(!c.archived)}
            >
              <Archive aria-hidden className="size-3.5" />
            </Button>
          </Tooltip>
          <DialogTrigger>
            <Button variant="ghost" size="sm" aria-label={`Delete ${c.name}`} className="px-1.5">
              <Trash2 aria-hidden className="size-3.5" />
            </Button>
            <Dialog title={`Delete ${c.name}?`} size="sm" role="alertdialog">
              {(close) => (
                <div className="space-y-4">
                  <p className="text-sm text-muted">
                    Transactions in this category move to the one you choose, including ones only
                    other members can see.
                  </p>
                  <Select
                    label="Move its transactions to"
                    value={replaceWith}
                    onChange={(v) => setReplaceWith(v ? String(v) : null)}
                  >
                    {groups.map((g) => (
                      <SelectSection key={g.id} title={g.name}>
                        {g.categories
                          .filter((x) => x.id !== c.id && !x.archived)
                          .map((x) => (
                            <SelectItem key={x.id} id={x.id}>
                              {x.name}
                            </SelectItem>
                          ))}
                      </SelectSection>
                    ))}
                  </Select>
                  <DialogActions>
                    <Button variant="secondary" onPress={close}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      isDisabled={!replaceWith}
                      onPress={() => void onDelete(replaceWith).then(close)}
                    >
                      Delete category
                    </Button>
                  </DialogActions>
                </div>
              )}
            </Dialog>
          </DialogTrigger>
        </>
      )}
    </>
  );
}
