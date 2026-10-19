/**
 * A round icon button of the player's controls. The icon is decorative: the button carries its
 * name as its `aria-label` (and as the tooltip). After a click with the pointer it gives the focus
 * back, so that Space and Enter go to mpv again (`blurAfterPointer`). A button can also show a
 * short text (the quality that plays): it is then a pill, and its name should say the text too.
 */

import type { ButtonHTMLAttributes, Ref } from 'react';

import { blurAfterPointer } from '../input/forward';
import Icon from '../shell/Icon';
import styles from './ControlButton.module.css';

export interface ControlButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type' | 'aria-label' | 'title'> {
  /** What the button is called: for screen readers and the tooltip. */
  label: string;
  /** The path of the icon (shell/Icon.tsx); a button with a `text` may have none. */
  icon?: string;
  /** A short text in the button, after the icon if there is one. */
  text?: string;
  /** The big one: play and pause. */
  large?: boolean;
  /** The button opens a panel (`aria-haspopup`). */
  popup?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export default function ControlButton({
  label,
  icon,
  text,
  large = false,
  popup = false,
  className,
  ref,
  ...rest
}: ControlButtonProps) {
  const shape = text === undefined ? styles.button : `${styles.button} ${styles.wide}`;
  const look = large ? `${shape} ${styles.large}` : shape;
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
      {icon !== undefined && <Icon path={icon} />}
      {text !== undefined && <span>{text}</span>}
    </button>
  );
}
