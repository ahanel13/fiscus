// SPDX-License-Identifier: AGPL-3.0-or-later
import { Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { DropZone, FileTrigger, Text } from 'react-aria-components';
import { Button } from './button.js';

/**
 * Drop files here or choose them. Files are read in the browser; nothing is uploaded until the
 * caller sends what it parsed. Keyboard and screen-reader users get the "Choose files" button;
 * the drop zone itself is also focusable and accepts pasted files.
 */
export function FileDrop({
  label,
  description,
  accept,
  allowsMultiple,
  onFiles,
}: {
  label: string;
  description?: ReactNode;
  accept?: string[];
  allowsMultiple?: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <DropZone
      aria-label={label}
      getDropOperation={(types) =>
        accept && !accept.some((t) => types.has(t)) && !types.has('text/plain') ? 'cancel' : 'copy'
      }
      onDrop={async (e) => {
        const files = await Promise.all(
          e.items
            .filter((i) => i.kind === 'file')
            .map((i) => (i as { getFile: () => Promise<File> }).getFile()),
        );
        if (files.length) onFiles(allowsMultiple ? files : files.slice(0, 1));
      }}
      className={
        'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border-strong px-4 py-8 text-center ' +
        'drop-target:border-accent drop-target:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
      }
    >
      <Upload aria-hidden className="size-6 text-muted" />
      <Text slot="label" className="text-sm font-medium">
        {label}
      </Text>
      {description ? <span className="max-w-md text-sm text-muted">{description}</span> : null}
      <FileTrigger
        {...(accept ? { acceptedFileTypes: accept } : {})}
        {...(allowsMultiple ? { allowsMultiple: true } : {})}
        onSelect={(list) => {
          if (list) onFiles([...list]);
        }}
      >
        <Button variant="secondary">Choose {allowsMultiple ? 'files' : 'a file'}</Button>
      </FileTrigger>
    </DropZone>
  );
}
