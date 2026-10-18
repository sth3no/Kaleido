/** What every field of the settings page takes: a controlled value, and the row's label and messages. */
export interface FieldProps<V> {
  /** The id of the field's main control; the row's `<label for>` points at it. */
  id: string;
  /** The id of the element that holds the row's label: the control is named by it. */
  labelId: string;
  value: V;
  /** The user chose a value: save it. */
  onChange: (value: V) => void;
  /**
   * A text field has typed text that it will not send (a colour that is no colour): the key of the text
   * that says why, shown in the row, or `null` when there is nothing to say any more.
   */
  onInvalid?: (text: string | null) => void;
  /**
   * A field that is dragged (a slider) says what it shows now, also while nothing is saved yet, so that
   * something drawn from the setting (the appearance's preview) can follow it.
   */
  onPreview?: (value: V) => void;
  /** The ids of the row's hint and error, which describe the control. */
  describedBy?: string;
  /** The last change was refused. */
  invalid?: boolean;
  disabled?: boolean;
}
