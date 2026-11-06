// SPDX-License-Identifier: AGPL-3.0-or-later
import { GOAL_COLORS, GOAL_ICONS, type GoalIconName } from '@fiscus/shared';
import { clsx } from 'clsx';
import {
  Baby,
  Bike,
  Briefcase,
  Car,
  Gem,
  Gift,
  GraduationCap,
  Heart,
  House,
  type LucideIcon,
  Palmtree,
  PawPrint,
  PiggyBank,
  Plane,
  Shield,
  Sprout,
  Umbrella,
} from 'lucide-react';
import { FileTrigger } from 'react-aria-components';
import { apiBase } from '../config.js';
import { textOn } from './BankLogo.js';
import { Button } from './ui.js';

// A goal's picture (goals walkthrough §1): its photo, or an icon on a color. Photos are shrunk in
// the browser to a small square before they're sent, and served from Fiscus's own origin.

export const GOAL_ICON: Record<GoalIconName, LucideIcon> = {
  'piggy-bank': PiggyBank,
  plane: Plane,
  house: House,
  car: Car,
  'graduation-cap': GraduationCap,
  heart: Heart,
  gift: Gift,
  umbrella: Umbrella,
  baby: Baby,
  sprout: Sprout,
  shield: Shield,
  briefcase: Briefcase,
  palmtree: Palmtree,
  gem: Gem,
  bike: Bike,
  'paw-print': PawPrint,
};

/** How a goal looks: a photo (a preview while it's being chosen, else its own), or an icon. */
export interface GoalLook {
  icon: GoalIconName | null;
  color: string | null;
  /** A URL to show: the goal’s photo, or a preview of one just chosen. */
  photo: string | null;
}

export const goalPhotoUrl = (householdId: string, goalId: string, version: string) =>
  `${apiBase()}/api/v1/households/${householdId}/goals/${goalId}/image?v=${version}`;

/** The picture, decorative: the goal's name is always beside it. */
export function GoalPicture({ look, size = 'md' }: { look: GoalLook; size?: 'xs' | 'sm' | 'md' }) {
  const box =
    size === 'xs'
      ? 'size-7 rounded-md'
      : size === 'sm'
        ? 'size-10 rounded-lg'
        : 'size-14 rounded-xl sm:size-16';
  if (look.photo) {
    return (
      <img
        src={look.photo}
        alt=""
        aria-hidden
        className={clsx(box, 'shrink-0 object-cover ring-1 ring-border')}
      />
    );
  }
  const Icon = GOAL_ICON[look.icon ?? 'piggy-bank'];
  return (
    <span
      aria-hidden
      className={clsx(
        box,
        'grid shrink-0 place-items-center',
        !look.color && 'bg-surface-2 text-muted',
      )}
      style={look.color ? { backgroundColor: look.color, color: textOn(look.color) } : undefined}
    >
      <Icon className={size === 'xs' ? 'size-4' : size === 'sm' ? 'size-5' : 'size-7'} />
    </span>
  );
}

const SIDE = 256;

/**
 * A photo as a small square JPEG, cropped to its middle: a `blob:` URL to preview it (the page's
 * Content-Security-Policy allows those, not `data:`), and base64 to send.
 */
export async function shrinkPhoto(file: File): Promise<{ previewUrl: string; dataBase64: string }> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIDE,
    SIDE,
  );
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No photo'))), 'image/jpeg', 0.85),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return { previewUrl: URL.createObjectURL(blob), dataBase64: btoa(binary) };
}

/** Choosing a goal's picture: an icon and a color, or a photo instead. */
export function PicturePicker({
  look,
  isDisabled,
  onIcon,
  onColor,
  onPhoto,
  onRemovePhoto,
}: {
  look: GoalLook;
  isDisabled?: boolean;
  onIcon: (icon: GoalIconName) => void;
  onColor: (color: string) => void;
  onPhoto: (file: File) => void;
  onRemovePhoto: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <GoalPicture look={look} />
      <div className="min-w-0 flex-1 space-y-2">
        <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
          {GOAL_ICONS.map((name) => {
            const Icon = GOAL_ICON[name];
            const on = (look.icon ?? 'piggy-bank') === name && !look.photo;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={name.replace('-', ' ')}
                disabled={isDisabled}
                onClick={() => onIcon(name)}
                className={clsx(
                  'grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50',
                  on && 'bg-surface-2 text-fg ring-2 ring-accent',
                )}
              >
                <Icon aria-hidden className="size-4" />
              </button>
            );
          })}
        </div>
        <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
          {GOAL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={look.color === c}
              aria-label={`Color ${c}`}
              disabled={isDisabled}
              onClick={() => onColor(c)}
              className={clsx(
                'size-6 rounded-full ring-offset-2 ring-offset-surface disabled:opacity-50',
                look.color === c && 'ring-2 ring-fg',
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <FileTrigger
            acceptedFileTypes={['image/jpeg', 'image/png', 'image/webp']}
            onSelect={(files) => {
              const file = files?.[0];
              if (file) onPhoto(file);
            }}
          >
            <Button size="sm" variant="secondary" isDisabled={isDisabled}>
              {look.photo ? 'Change photo' : 'Use a photo'}
            </Button>
          </FileTrigger>
          {look.photo ? (
            <Button size="sm" variant="ghost" isDisabled={isDisabled} onPress={onRemovePhoto}>
              Remove photo
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
