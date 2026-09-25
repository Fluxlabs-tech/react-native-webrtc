package com.oney.WebRTCModule;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.uimanager.events.Event;

/**
 * {@code onDimensionsChange}: the size of the rendered video changed.
 */
final class DimensionsChangeEvent extends Event<DimensionsChangeEvent> {
    static final String EVENT_NAME = "topDimensionsChange";

    private final int width;
    private final int height;

    DimensionsChangeEvent(int surfaceId, int viewTag, int width, int height) {
        super(surfaceId, viewTag);
        this.width = width;
        this.height = height;
    }

    @Override
    public String getEventName() {
        return EVENT_NAME;
    }

    @Nullable
    @Override
    protected WritableMap getEventData() {
        WritableMap data = Arguments.createMap();
        data.putInt("width", width);
        data.putInt("height", height);
        return data;
    }
}
