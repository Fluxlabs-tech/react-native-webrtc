import type * as React from 'react';
import type { HostComponent, ViewProps } from 'react-native';
import type {
    DirectEventHandler,
    Float,
    Int32,
    WithDefault
} from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeCommands from 'react-native/Libraries/Utilities/codegenNativeCommands';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

type PictureInPictureSize = Readonly<{
    width: Float;
    height: Float;
}>;

/**
 * The native video view, read by React Native's codegen. RTCView documents the props.
 */
export interface NativeProps extends ViewProps {
    streamURL?: string;
    mirror?: boolean;
    objectFit?: string;
    zOrder?: Int32;
    pictureInPictureEnabled?: WithDefault<boolean, false>;
    autoStartPictureInPicture?: WithDefault<boolean, true>;
    autoStopPictureInPicture?: WithDefault<boolean, true>;
    pictureInPicturePreferredSize?: PictureInPictureSize;
    onDimensionsChange?: DirectEventHandler<Readonly<{ width: Int32; height: Int32 }>>;
    onPictureInPictureChange?: DirectEventHandler<Readonly<{ isInPictureInPicture: boolean; dismissed: boolean }>>;
}

// Codegen wants React.ElementRef spelled out in each command, not behind an alias.
interface NativeCommands {
    startPictureInPicture: (viewRef: React.ElementRef<HostComponent<NativeProps>>) => void;
    stopPictureInPicture: (viewRef: React.ElementRef<HostComponent<NativeProps>>) => void;
    startIOSPIP: (viewRef: React.ElementRef<HostComponent<NativeProps>>) => void;
    stopIOSPIP: (viewRef: React.ElementRef<HostComponent<NativeProps>>) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
    supportedCommands: [ 'startPictureInPicture', 'stopPictureInPicture', 'startIOSPIP', 'stopIOSPIP' ]
});

export default codegenNativeComponent<NativeProps>('RTCVideoView');
