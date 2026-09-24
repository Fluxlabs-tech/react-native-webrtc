package com.oney.WebRTCModule;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.uimanager.events.Event;

/**
 * {@code onPictureInPictureChange}: the activity entered or left picture-in-picture.
 */
final class PictureInPictureChangeEvent extends Event<PictureInPictureChangeEvent> {
    static final String EVENT_NAME = "topPictureInPictureChange";

    private final boolean isInPictureInPicture;
    private final boolean dismissed;

    PictureInPictureChangeEvent(int surfaceId, int viewTag, boolean isInPictureInPicture, boolean dismissed) {
        super(surfaceId, viewTag);
        this.isInPictureInPicture = isInPictureInPicture;
        this.dismissed = dismissed;
    }

    @Override
    public String getEventName() {
        return EVENT_NAME;
    }

    // An enter and an exit can follow each other within a frame; neither may swallow the other.
    @Override
    public boolean canCoalesce() {
        return false;
    }

    @Nullable
    @Override
    protected WritableMap getEventData() {
        WritableMap data = Arguments.createMap();
        data.putBoolean("isInPictureInPicture", isInPictureInPicture);
        data.putBoolean("dismissed", dismissed);
        return data;
    }
}
