import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * An inline text field for naming things on the canvas.
 *
 * Replaces `window.prompt`, which blocked the page, could not be styled, and interrupted
 * every single node creation. Used for a draft node, for renaming a node, and for naming a
 * new diagram, so the commit semantics live in one place.
 *
 * Enter or blur commits; Escape cancels. Committing an empty value cancels instead, and a
 * value equal to the original commits nothing at all — a rename that changes nothing should
 * not reach the server, because a pointless op still burns a rev and lands in the change
 * feed as noise.
 */

export interface LabelInputProps {
  initial?: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  /**
   * Size the field to its text instead of letting it claim an input's intrinsic width.
   *
   * An `<input>` is about 20 characters wide by default, and a node is `width: fit-content`,
   * so a plain field made the node jump to ~178px the moment you started renaming it — the
   * box grew while the text stayed put. A hidden ghost holding the same string drives the
   * width, with the field laid over it, so the node measures exactly what it will measure
   * once committed.
   */
  autoWidth?: boolean;
  /**
   * Treat an empty value as a real commit rather than a cancel.
   *
   * A node must have a label, so clearing one is meaningless and is treated as "changed my
   * mind". An edge label is optional, so emptying it is a deliberate act — the only way to
   * remove text you no longer want on an arrow.
   */
  allowEmpty?: boolean;
  /** Called with the trimmed value. Never called with an empty string or an unchanged one. */
  onCommit: (label: string) => void;
  onCancel: () => void;
}

export function LabelInput({
  initial = '',
  placeholder,
  ariaLabel,
  className,
  autoWidth = false,
  allowEmpty = false,
  onCommit,
  onCancel,
}: LabelInputProps) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  /** Guards against blur firing a second time after Enter or Escape already resolved it. */
  const done = useRef(false);

  /*
   * Focus on the next frame, not synchronously.
   *
   * Node creation is triggered from a capture-phase `dblclick`, so React Flow's own
   * handler for the same event runs *after* this component mounts and moves focus to the
   * pane. Focusing immediately loses the race: `document.activeElement` ends up on `body`,
   * every keystroke goes nowhere, and Enter commits an empty value — which looks exactly
   * like "creating a node is broken".
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      if (done.current) return;
      done.current = true;
      const next = value.trim();
      // An unchanged label is not a change. This project already carries one no-op
      // `move_node` bug; a no-op rename would be the same fault twice.
      const changed = next !== initial.trim();
      if (commit && changed && (next || allowEmpty)) onCommit(next);
      else onCancel();
    },
    [value, initial, allowEmpty, onCommit, onCancel],
  );

  const field = (
    <input
      ref={input}
      className={className ?? 'cp-label-input'}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      /*
       * Every key event stops here.
       *
       * React Flow listens for Backspace and Delete to remove the selection, and for space
       * to pan. Without this, typing a label would delete the node being renamed — a
       * destructive failure with no error surface to reveal it.
       */
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onKeyPress={(event) => event.stopPropagation()}
      // A click into the field must not select or drag the node underneath it.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true)}
    />
  );

  if (!autoWidth) return field;

  return (
    <span className="cp-input-sizer">
      {/* Holds the same string so the box measures the text, not an input's default width.
          A single space keeps an empty field from collapsing to nothing. */}
      <span className="cp-input-ghost" aria-hidden="true">
        {value || placeholder || ' '}
      </span>
      {field}
    </span>
  );
}
