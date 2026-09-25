import type * as React from 'react';
import type { HostComponent, ViewProps } from 'react-native';
import codegenNativeCommands from 'react-native/Libraries/Utilities/codegenNativeCommands';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

/**
 * iOS: the system broadcast picker, read by React Native's codegen. It has no props of its own;
 * the show command opens it.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface NativeProps extends ViewProps {}

interface NativeCommands {
    show: (viewRef: React.ElementRef<HostComponent<NativeProps>>) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
    supportedCommands: [ 'show' ]
});

export default codegenNativeComponent<NativeProps>('ScreenCapturePickerView', {
    excludedPlatforms: [ 'android' ]
});
