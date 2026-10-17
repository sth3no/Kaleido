/**
 * A round icon button of the player's controls. The icon is decorative: the button carries its
 * name as its `aria-label` (and as the tooltip). After a click with the pointer it gives the focus
 * back, so that Space and Enter go to mpv again (`blurAfterPointer`).
 */

import type { ButtonHTMLAttributes, Ref } from 'react';

import { blurAfterPointer } from '../input/forward';
import Icon from '../shell/Icon';
import styles from './ControlButton.module.css';

export interface ControlButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type' | 'aria-label' | 'title'> {
  /** What the button is called: for screen readers and the tooltip. */
  label: string;
  /** The path of the icon (shell/Icon.tsx). */
  icon: string;
  /** The big one: play and pause. */
  large?: boolean;
  /** The button opens a panel (`aria-haspopup`). */
  popup?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export default function ControlButton({
  label,
  icon,
  large = false,
  popup = false,
  className,
  ref,
  ...rest
}: ControlButtonProps) {
  const look = large ? `${styles.button} ${styles.large}` : styles.button;
  return (
    <button
      ref={ref}
      type="button"
      className={className ? `${look} ${className}` : look}
      aria-label={label}
      title={label}
      aria-haspopup={popup ? 'dialog' : undefined}
      {...rest}
      {...blurAfterPointer}
    >
      <Icon path={icon} />
    </button>
  );
}
