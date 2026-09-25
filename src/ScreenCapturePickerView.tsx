import React from 'react';
import { ViewProps } from 'react-native';

import NativeScreenCapturePickerView, { Commands } from './ScreenCapturePickerViewNativeComponent';

type RefType = React.ComponentRef<typeof NativeScreenCapturePickerView>;

/**
 * iOS: the system picker that starts a broadcast upload extension, for screen sharing. Render it,
 * hidden if need be, and call show() to open it.
 */
export default class ScreenCapturePickerView extends React.PureComponent<ViewProps> {
    private readonly ref = React.createRef<RefType>();

    /**
     * Opens the picker.
     */
    public show() {
        const view = this.ref.current;

        if (view) {
            Commands.show(view);
        }
    }

    render(): React.ReactNode {
        return <NativeScreenCapturePickerView {...this.props} ref={this.ref} />;
    }
}
