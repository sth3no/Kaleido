/**
 * The field that edits a setting, by the kind its descriptor names. The value is what `useSetting`
 * decoded for that kind (a boolean for a toggle, a number for a slider, a list of file names for
 * the shaders, a string for the rest, `''` among them for "none" of the browser); `onChange` hands the
 * field's new value to it.
 */

import type { SettingDescriptor } from './descriptors';
import AccentField from './fields/AccentField';
import BrowserField from './fields/BrowserField';
import ColorField from './fields/ColorField';
import DeviceField from './fields/DeviceField';
import type { FieldProps } from './fields/FieldProps';
import FontField from './fields/FontField';
import LangListField from './fields/LangListField';
import Select from './fields/Select';
import ShaderListField from './fields/ShaderListField';
import Slider from './fields/Slider';
import Toggle from './fields/Toggle';
import { asBoolean, asList, asNumber, asString, type FieldValue } from './values';

export interface SettingFieldProps extends Omit<FieldProps<FieldValue>, 'value'> {
  descriptor: SettingDescriptor;
  value: FieldValue;
}

export default function SettingField({ descriptor, value, ...common }: SettingFieldProps) {
  const { field } = descriptor;
  switch (field.kind) {
    case 'toggle':
      return <Toggle {...common} value={asBoolean(value)} />;
    case 'select':
      return (
        <Select
          {...common}
          value={asString(value)}
          options={field.options}
          customLabelKey={field.customLabelKey}
        />
      );
    case 'slider':
      return (
        <Slider
          {...common}
          value={asNumber(value, field.min)}
          min={field.min}
          max={field.max}
          step={field.step}
          unitKey={field.unitKey}
          percent={field.percent}
        />
      );
    case 'color':
      return <ColorField {...common} value={asString(value)} alpha={field.alpha !== false} />;
    case 'accent':
      return <AccentField {...common} value={asString(value)} />;
    case 'font':
      return <FontField {...common} value={asString(value)} />;
    case 'langList':
      return <LangListField {...common} value={asString(value)} />;
    case 'device':
      return <DeviceField {...common} value={asString(value)} />;
    case 'shaderList':
      return <ShaderListField {...common} value={asList(value)} />;
    case 'browser':
      return <BrowserField {...common} value={asString(value)} />;
  }
}
