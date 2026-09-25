import { forwardRef, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { Commands } from './RTCVideoViewNativeComponent';
import  { NativeVideoViewProps, NativeRTCVideoView , } from './RTCView';

export interface RTCPIPViewProps extends NativeVideoViewProps {
    /**
   * Picture in picture options for this view. Disabled if not supplied.
   *
   * Note: this should only be generally only used with remote video tracks,
   * as the local camera may stop while in the background.
   *
   * iOS only. Requires iOS 15.0 or above, and the PIP background mode capability.
   * @deprecated
   */
  iosPIP?: RTCIOSPIPOptions & {
    fallbackView?: ReactNode;
  };
}

export interface RTCIOSPIPOptions {
  /**
   * Whether PIP can be launched from this view.
   *
   * Defaults to true.
   */
  enabled?: boolean;

  /**
   * The preferred size of the PIP window.
   */
  preferredSize?: {
    width: number;
    height: number;
  },

  /**
   * Indicates whether Picture in Picture starts automatically
   * when the controller embeds its content inline and the app
   * transitions to the background.
   *
   * Defaults to true.
   *
   * See: AVPictureInPictureController.canStartPictureInPictureAutomaticallyFromInline
   */
  startAutomatically?: boolean;

  /**
   * Indicates whether Picture in Picture should stop automatically
   * when the app returns to the foreground.
   *
   * Defaults to true.
   */
  stopAutomatically?: boolean;
}

type RTCViewInstance = InstanceType<typeof NativeRTCVideoView>;

let warnedAboutIOSPIP = false;

/**
 * The iosPIP options as the props that replaced them, which the native view takes on both
 * architectures. Only iOS ever read iosPIP.
 */
function pictureInPictureProps(iosPIP: RTCPIPViewProps['iosPIP']): Partial<NativeVideoViewProps> {
    if (!iosPIP || Platform.OS !== 'ios') {
        return {};
    }

    if (!warnedAboutIOSPIP) {
        warnedAboutIOSPIP = true;
        console.warn('\'iosPIP\' is deprecated. Please use the new Picture-in-Picture props.');
    }

    return {
        pictureInPictureEnabled: iosPIP.enabled ?? true,
        autoStartPictureInPicture: iosPIP.startAutomatically ?? true,
        autoStopPictureInPicture: iosPIP.stopAutomatically ?? true,
        pictureInPicturePreferredSize: iosPIP.preferredSize
    };
}

/**
 * A convenience wrapper around RTCView to handle the fallback view as a prop.
 * @deprecated Use RTCView instead.
 */
const RTCPIPView = forwardRef<RTCViewInstance, RTCPIPViewProps>((props, ref) => {
    const { iosPIP, ...rtcViewProps } = props;

    // Props given directly win over the ones iosPIP stands for.
    return (
        <NativeRTCVideoView ref={ref}
            {...pictureInPictureProps(iosPIP)}
            {...rtcViewProps}>
            {iosPIP?.fallbackView}
        </NativeRTCVideoView>
    );
});

/**
 * @deprecated
 */
export function startIOSPIP(ref) {
    if (ref.current) {
        Commands.startIOSPIP(ref.current);
    }
}

/**
 * @deprecated
 */
export function stopIOSPIP(ref) {
    if (ref.current) {
        Commands.stopIOSPIP(ref.current);
    }
}

export default RTCPIPView;