package com.oney.WebRTCModule;

import android.app.Activity;
import android.app.ActivityOptions;
import android.app.PictureInPictureParams;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.activity.ComponentActivity;
import androidx.annotation.Nullable;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleEventObserver;

import org.webrtc.VideoTrack;

/**
 * Picture-in-picture in a window of the view's own, for the {@code floatingPictureInPicture} prop.
 *
 * {@link PictureInPictureController} shrinks the app's activity into the window, and the whole
 * task goes with it. So an activity the app opens next in its own task, like a UPI app started for
 * a result or a payment SDK's page, opens inside the window or ends it. The system does not even
 * start that PiP by itself for such a launch: it only does so on a task switch.
 *
 * This puts the video in {@link PictureInPictureWindowActivity} instead: a small activity started
 * on top of the app's activity, in the same task, and moved into PiP at once. An activity that
 * enters PiP with others under it gets a task of its own, so the app stays full screen behind the
 * window, and what it opens next opens under the window, its result coming back as usual. Android
 * 13 and later start it straight in the window; earlier versions start it in the task, and it
 * enters from there.
 *
 * A window opens when the prop turns true with the app in front and the view showing a track, at
 * most once for each time the prop turns true. It closes when the prop turns false, when the view
 * goes away or loses its track, when the viewer closes or expands it, and when the app's activity
 * comes back after something covered it: the viewer is back where the video is on screen.
 *
 * The view's {@code onPictureInPictureChange} reports the window as it does the activity's PiP.
 * Only one window shows at a time: the most recently opened one.
 */
final class FloatingPictureInPicture {
    private static final String TAG = WebRTCModule.TAG;

    /** How long a started window may take to be created before it counts as never started. */
    private static final long START_TIMEOUT_MS = 5000;

    /** The session whose window is open or starting. */
    @Nullable
    private static volatile FloatingPictureInPicture showing;

    private final WebRTCView view;
    private final PictureInPictureController.Listener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** The prop. */
    private boolean requested;

    /** A window opened since the prop last turned true. */
    private boolean openedThisTurn;

    /** Started, and not created yet. */
    private boolean starting;

    @Nullable
    private PictureInPictureWindowActivity window;

    private volatile boolean inPictureInPicture;

    /** The viewer closed the window. */
    private boolean dismissed;

    /** The app's activity, watched while a window is open. */
    @Nullable
    private ComponentActivity host;

    /** Something covered the app's activity while the window showed. */
    private boolean hostCovered;

    private final LifecycleEventObserver onHostEvent = (source, event) -> onHostEvent(event);

    private final Runnable startTimeout = () -> {
        if (starting) {
            Log.w(TAG, "The picture-in-picture window did not start.");
            starting = false;
            forget();
        }
    };

    FloatingPictureInPicture(WebRTCView view, PictureInPictureController.Listener listener) {
        this.view = view;
        this.listener = listener;
    }

    /** Whether a window shows a video now. Any thread. */
    static boolean isShowing() {
        FloatingPictureInPicture current = showing;
        return current != null && current.inPictureInPicture;
    }

    /**
     * Hands a window being created the session it belongs to, or {@code null} when it was closed
     * before it got here, or the system recreated it: it then finishes.
     */
    @Nullable
    static FloatingPictureInPicture claim(PictureInPictureWindowActivity activity) {
        FloatingPictureInPicture session = showing;
        if (session == null || !session.starting) {
            return null;
        }
        session.starting = false;
        session.mainHandler.removeCallbacks(session.startTimeout);
        session.window = activity;
        return session;
    }

    // The view

    void setRequested(boolean requested) {
        if (this.requested == requested) {
            return;
        }
        this.requested = requested;
        if (requested) {
            openedThisTurn = false;
            open();
        } else {
            close();
        }
    }

    void onAttachedToWindow() {
        open();
    }

    /** The view's track changed: an open window shows the new one, and a view that got one may open. */
    void onVideoTrackChanged() {
        PictureInPictureWindowActivity current = window;
        if (current == null) {
            open();
            return;
        }
        VideoTrack track = view.getVideoTrack();
        if (track == null) {
            close();
        } else {
            current.show(track);
        }
    }

    /** The view is gone for good. */
    void release() {
        requested = false;
        close();
    }

    @Nullable
    VideoTrack videoTrack() {
        return view.getVideoTrack();
    }

    boolean mirror() {
        return view.isMirror();
    }

    // Opening and closing

    private void open() {
        if (!requested || openedThisTurn || starting || window != null
                || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || view.getVideoTrack() == null) {
            return;
        }
        Activity current = view.getCurrentActivity();
        if (!(current instanceof ComponentActivity)) {
            return;
        }
        ComponentActivity activity = (ComponentActivity) current;
        // Started from the back, it would bring the app's task forward over whatever covers it.
        if (activity.isFinishing() || !activity.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)
                || activity.isInPictureInPictureMode() || !PictureInPictureController.isSupported(activity)) {
            return;
        }

        FloatingPictureInPicture previous = showing;
        if (previous != null && previous != this) {
            previous.close();
        }

        PictureInPictureParams params = view.pictureInPictureWindowParams();
        Intent intent = new Intent(activity, PictureInPictureWindowActivity.class)
                // Not the user leaving: the app's activity must not start its own PiP for this.
                .addFlags(Intent.FLAG_ACTIVITY_NO_USER_ACTION)
                .putExtra(PictureInPictureWindowActivity.EXTRA_PARAMS, params);
        Bundle options = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            options = ActivityOptions.makeLaunchIntoPip(params).toBundle();
            intent.putExtra(PictureInPictureWindowActivity.EXTRA_LAUNCHED_INTO_PIP, true);
        } else {
            // It enters from its first resume; the shrink into the window is the animation.
            intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        }

        showing = this;
        starting = true;
        openedThisTurn = true;
        dismissed = false;
        hostCovered = false;
        try {
            activity.startActivity(intent, options);
        } catch (ActivityNotFoundException | IllegalArgumentException | SecurityException e) {
            Log.w(TAG, "Could not open a picture-in-picture window", e);
            starting = false;
            forget();
            return;
        }
        mainHandler.postDelayed(startTimeout, START_TIMEOUT_MS);
        host = activity;
        activity.getLifecycle().addObserver(onHostEvent);
    }

    private void close() {
        if (starting) {
            // The window finishes itself when it finds nothing to claim.
            starting = false;
            mainHandler.removeCallbacks(startTimeout);
            forget();
            return;
        }
        PictureInPictureWindowActivity current = window;
        if (current != null && !current.isFinishing()) {
            current.finish();
        }
    }

    /** No window, or none to come. */
    private void forget() {
        if (showing == this) {
            showing = null;
        }
        ComponentActivity watched = host;
        host = null;
        if (watched != null) {
            watched.getLifecycle().removeObserver(onHostEvent);
        }
    }

    private void onHostEvent(Lifecycle.Event event) {
        switch (event) {
            case ON_STOP:
                // A UPI app, or a payment page on the way to one, now covers the app.
                if (inPictureInPicture) {
                    hostCovered = true;
                }
                break;
            case ON_START:
                if (hostCovered) {
                    close();
                }
                break;
            case ON_DESTROY:
                close();
                break;
            default:
                break;
        }
    }

    // The window

    void onWindowEntered(PictureInPictureWindowActivity activity) {
        if (window != activity || inPictureInPicture) {
            return;
        }
        inPictureInPicture = true;
        listener.onPictureInPictureChange(true, false);
    }

    void onWindowDismissed(PictureInPictureWindowActivity activity) {
        if (window == activity) {
            dismissed = true;
        }
    }

    void onWindowDestroyed(PictureInPictureWindowActivity activity) {
        if (window != activity) {
            return;
        }
        window = null;
        forget();
        if (inPictureInPicture) {
            inPictureInPicture = false;
            listener.onPictureInPictureChange(false, dismissed);
        }
    }
}
