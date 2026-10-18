/**
 * The app's error boundary (Ruling R53, spec 10.1). An error while React draws would otherwise
 * unmount the whole tree: a transparent window over the video with no controls and no keyboard (the
 * video layer's listeners go with it), and nothing in kaleido.log. Instead the boundary shows a
 * recover view that says so and offers to reload the UI (Rust keeps playing and the reloaded UI
 * picks the player up again), and it sends the error with its stacks to Rust
 * (`system_ui_error`), which writes it to the log.
 *
 * It wraps the app inside the root (`main.tsx`), below the appearance and the language: the recover
 * view has the tokens and the texts of the app.
 */

import { Component, useEffect, useId, useRef, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { systemUiError } from '../ipc/commands';
import styles from './ErrorBoundary.module.css';

/**
 * The error as the log gets it: its name and message, its stack, and the components it came from.
 * V8's stack starts with the name and the message, so they are not said twice.
 */
export function describeUiError(error: unknown, componentStack?: string | null): string {
  const what = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack !== undefined && error.stack !== '' ? error.stack : null;
  const head = stack === null ? what : stack.startsWith(what) ? stack : `${what}\n${stack}`;
  return componentStack ? `${head}\nin components:${componentStack}` : head;
}

const reloadPage = () => {
  window.location.reload();
};

interface RecoverViewProps {
  onReload: () => void;
}

/** What is left of the app: what happened, and the way back. Opaque, over the whole window. */
function RecoverView({ onReload }: RecoverViewProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const textId = useId();
  const reload = useRef<HTMLButtonElement>(null);
  // The keyboard reaches nothing else now.
  useEffect(() => {
    reload.current?.focus();
  }, []);

  return (
    <div
      className={styles.recover}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={textId}
      // The window has no title bar of Windows': it still moves.
      data-tauri-drag-region
    >
      <div className={styles.content}>
        <h1 id={titleId} className={styles.title}>
          {t('errors.recover.title')}
        </h1>
        <p id={textId} className={styles.text}>
          {t('errors.recover.text')}
        </p>
        <button ref={reload} type="button" className={styles.reload} onClick={onReload}>
          {t('errors.recover.reload')}
        </button>
      </div>
    </div>
  );
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** What the recover view's button does: reload the page (tests pass their own). */
  onReload?: () => void;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    systemUiError(describeUiError(error, info.componentStack)).catch((reason: unknown) => {
      console.warn('system_ui_error', reason);
    });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <RecoverView onReload={this.props.onReload ?? reloadPage} />;
  }
}
