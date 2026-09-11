import React, { useCallback, useEffect, useRef, useState } from 'react';

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
  /**
   * Render a `<textarea>` and let Enter insert a newline.
   *
   * Commit then moves to Cmd/Ctrl+Enter or clicking away, because a multi-line field cannot
   * have Enter mean both "new line" and "done". Escape still cancels.
   */
  multiline?: boolean;
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
  multiline = false,
  onCommit,
  onCancel,
}: LabelInputProps) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
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
      const field = input.current;
      if (!field) return;
      field.focus();
      // Select-all is right for a name — you open it to retype the thing. It is wrong for a
      // body, where the usual reason to open it is to add a line, and one keystroke on a
      // full selection would wipe everything already written.
      if (multiline) field.setSelectionRange(field.value.length, field.value.length);
      else field.select();
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

  /*
   * Grow the box to its rendered content.
   *
   * `rows` counts typed lines, not wrapped ones, so one long paragraph asked for a single
   * row and then scrolled inside it. `scrollHeight` is measured after layout, so it is the
   * only number that knows how the text actually wrapped.
   */
  useEffect(() => {
    const field = input.current;
    if (!multiline || !field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [value, multiline]);

  /*
   * Shared by both fields. Every key event stops here.
   *
   * React Flow listens for Backspace and Delete to remove the selection, and for space to
   * pan. Without this, typing would delete the node being edited — a destructive failure
   * with no error surface to reveal it.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') finish(false);
    else if (event.key === 'Enter') {
      // In a body, Enter is a newline and only a modifier means "done". Anywhere else it
      // is the commit, as it has always been.
      if (!multiline) finish(true);
      else if (event.metaKey || event.ctrlKey) finish(true);
    }
  };

  const shared = {
    ref: input as never,
    className: className ?? 'cp-label-input',
    'aria-label': ariaLabel,
    placeholder,
    value,
    onChange: (event: { target: { value: string } }) => setValue(event.target.value),
    onKeyDown,
    onKeyUp: (event: React.KeyboardEvent) => event.stopPropagation(),
    onKeyPress: (event: React.KeyboardEvent) => event.stopPropagation(),
    // A click into the field must not select or drag the node underneath it.
    onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
    onBlur: () => finish(true),
  };

  if (multiline) return <textarea {...shared} rows={1} />;

  const field = (
    <input
      ref={input as React.RefObject<HTMLInputElement>}
      className={className ?? 'cp-label-input'}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
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
