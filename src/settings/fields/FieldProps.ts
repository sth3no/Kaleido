/** What every field of the settings page takes: a controlled value, and the row's label and messages. */
export interface FieldProps<V> {
  /** The id of the field's main control. */
  id: string;
  /** The id of the element that holds the row's label: the control is named by it. */
  labelId: string;
  value: V;
  /** The user chose a value: save it. */
  onChange: (value: V) => void;
  /** The ids of the row's hint and error, which describe the control. */
  describedBy?: string;
  /** The last change was refused. */
  invalid?: boolean;
  disabled?: boolean;
}
