// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChevronDown, X } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import {
  Button as AriaButton,
  ComboBox as AriaComboBox,
  ComboBoxStateContext,
  Input as AriaInput,
  ListBox,
  Popover,
  Tag,
  TagGroup,
  TagList,
} from 'react-aria-components';
import { Label } from './field.js';
import { SelectItem } from './select.js';
import { controlStyles, popoverStyles } from './utils.js';

export interface PickerTag {
  id: string;
  name: string;
  color: string;
}

const CREATE = '__create';

type CloseFn = () => void;

/** Hands the combo box's close() to the picker, so it can close after adding a tag. */
function Closer({ closeRef }: { closeRef: { current: CloseFn | null } }) {
  const state = useContext(ComboBoxStateContext);
  useEffect(() => {
    closeRef.current = state ? () => state.close() : null;
  }, [state, closeRef]);
  return null;
}

/**
 * Tags on one thing: the chosen ones as removable chips, and a search box to add more (or create
 * one, when `onCreate` is given). Nothing else is listed until you type or open the box, so a
 * household with many tags isn't a wall of checkboxes.
 */
export function TagPicker({
  label = 'Tags',
  tags,
  value,
  onChange,
  onCreate,
  isDisabled,
}: {
  label?: string;
  tags: PickerTag[];
  value: string[];
  onChange: (ids: string[]) => void;
  /** Creates a tag of that name and returns it. */
  onCreate?: (name: string) => Promise<PickerTag>;
  isDisabled?: boolean;
}) {
  const [text, setText] = useState('');
  const closeRef = useRef<CloseFn | null>(null);
  const chosen = value
    .map((id) => tags.find((t) => t.id === id))
    .filter((t): t is PickerTag => !!t);
  const query = text.trim().toLowerCase();
  const options = tags.filter(
    (t) => !value.includes(t.id) && (!query || t.name.toLowerCase().includes(query)),
  );
  const exact = tags.some((t) => t.name.toLowerCase() === query);
  const canCreate = !!onCreate && query.length > 0 && !exact;

  const add = async (key: string) => {
    if (key === CREATE && onCreate) {
      const tag = await onCreate(text.trim());
      onChange([...value, tag.id]);
    } else if (key) {
      onChange([...value, key]);
    }
    setText('');
    // Clearing the box would otherwise reopen the suggestions over the form.
    queueMicrotask(() => closeRef.current?.());
  };

  return (
    <div className="flex flex-col gap-1.5">
      <TagGroup
        aria-label={label}
        {...(isDisabled
          ? {}
          : { onRemove: (keys) => onChange(value.filter((id) => !keys.has(id))) })}
        className="flex flex-col gap-1.5"
      >
        <Label>{label}</Label>
        <TagList
          items={chosen}
          className="flex flex-wrap gap-1.5"
          renderEmptyState={() => <span className="text-sm text-muted">No tags</span>}
        >
          {(tag) => (
            <Tag
              id={tag.id}
              textValue={tag.name}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-accent"
            >
              {({ allowsRemoving }) => (
                <>
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: tag.color }}
                  />
                  {tag.name}
                  {allowsRemoving ? (
                    <AriaButton
                      slot="remove"
                      aria-label={`Remove ${tag.name}`}
                      className="-mr-1 rounded-full p-0.5 text-muted hover:bg-surface hover:text-fg"
                    >
                      <X aria-hidden className="size-3" />
                    </AriaButton>
                  ) : null}
                </>
              )}
            </Tag>
          )}
        </TagList>
      </TagGroup>
      {isDisabled ? null : (
        <AriaComboBox
          aria-label={`Add ${label.toLowerCase()}`}
          inputValue={text}
          onInputChange={setText}
          selectedKey={null}
          onSelectionChange={(key) => {
            if (key !== null) void add(String(key));
          }}
          allowsEmptyCollection
          className="max-w-sm"
        >
          <Closer closeRef={closeRef} />
          <div className="relative">
            <AriaInput
              placeholder={onCreate ? 'Add or create a tag…' : 'Add a tag…'}
              className={`${controlStyles} pr-10`}
            />
            <AriaButton
              aria-label="Show tags"
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted"
            >
              <ChevronDown aria-hidden className="size-4" />
            </AriaButton>
          </div>
          <Popover className={`${popoverStyles} min-w-(--trigger-width)`}>
            <ListBox
              className="max-h-60 overflow-auto p-1 outline-none"
              renderEmptyState={() => (
                <p className="px-2.5 py-1.5 text-sm text-muted">No other tags</p>
              )}
            >
              {[
                ...options.map((t) => (
                  <SelectItem key={t.id} id={t.id} textValue={t.name}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: t.color }}
                      />
                      {t.name}
                    </span>
                  </SelectItem>
                )),
                ...(canCreate
                  ? [
                      <SelectItem key={CREATE} id={CREATE} textValue={`Create tag ${text.trim()}`}>
                        Create tag “{text.trim()}”
                      </SelectItem>,
                    ]
                  : []),
              ]}
            </ListBox>
          </Popover>
        </AriaComboBox>
      )}
    </div>
  );
}
