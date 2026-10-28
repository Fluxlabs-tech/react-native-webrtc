package com.oney.WebRTCModule;

import android.app.KeyguardManager;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.activity.ComponentActivity;
import androidx.annotation.Nullable;
import androidx.core.app.PictureInPictureModeChangedInfo;
import androidx.core.util.Consumer;
import androidx.lifecycle.Lifecycle;

import org.webrtc.EglBase;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoTrack;

/**
 * The window {@link FloatingPictureInPicture} shows a view's video in: nothing but the video, and
 * only ever in picture-in-picture. Leaving it in any way ends it, so it never stands in front of
 * the app full screen.
 */
public final class PictureInPictureWindowActivity extends ComponentActivity {
    static final String EXTRA_PARAMS = "com.oney.WebRTCModule.PICTURE_IN_PICTURE_PARAMS";

    /** Started straight in the window (Android 13 and later), rather than entering it itself. */
    static final String EXTRA_LAUNCHED_INTO_PIP = "com.oney.WebRTCModule.LAUNCHED_INTO_PICTURE_IN_PICTURE";

    private static final String TAG = WebRTCModule.TAG;

    /** How long it may take to be in the window before it gives up. */
    private static final long ENTER_TIMEOUT_MS = 2000;

    @Nullable
    private FloatingPictureInPicture session;

    @Nullable
    private FrameLayout root;

    @Nullable
    private SurfaceViewRenderer renderer;

    @Nullable
    private VideoTrack track;

    private boolean enterRequested;

    private boolean launchedIntoPip;

    /** It has resumed once: the viewer can have done nothing to the window before that. */
    private boolean resumedOnce;

    /** It has been in the window. */
    private boolean entered;

    /** It left the window while paused: expanded if it resumes, closed if it stops. */
    private boolean exitPending;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Consumer<PictureInPictureModeChangedInfo> onModeChanged =
            info -> onModeChanged(info.isInPictureInPictureMode());

    private final Runnable enterTimeout = () -> {
        if (!isInPictureInPictureMode()) {
            Log.w(TAG, "The picture-in-picture window did not enter picture-in-picture.");
            finish();
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Recreated by the system, it has no view to show any more.
        session = savedInstanceState == null ? FloatingPictureInPicture.claim(this) : null;
        launchedIntoPip = getIntent().getBooleanExtra(EXTRA_LAUNCHED_INTO_PIP, false);
        EglBase.Context eglContext = EglUtils.getRootEglBaseContext();
        if (session == null || eglContext == null) {
            finish();
            return;
        }

        FrameLayout content = new FrameLayout(this);
        SurfaceViewRenderer surface = new SurfaceViewRenderer(this);
        // Filling the window, it shows the middle of the frame in the window's shape, which is the
        // view's own when it covers.
        content.addView(surface, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(content);
        root = content;
        try {
            surface.init(eglContext, null);
        } catch (RuntimeException e) {
            Log.e(TAG, "Could not draw the picture-in-picture window", e);
            finish();
            return;
        }
        surface.setMirror(session.mirror());
        renderer = surface;

        addOnPictureInPictureModeChangedListener(onModeChanged);
        // Started in the window, it is in it from the start, whether or not the activity says so
        // yet. Out of the window, it shows nothing: the app under it shows through.
        boolean inWindow = launchedIntoPip || isInPictureInPictureMode();
        setShown(inWindow);
        if (inWindow) {
            onModeChanged(true);
        } else {
            mainHandler.postDelayed(enterTimeout, ENTER_TIMEOUT_MS);
        }
        show(session.videoTrack());
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumedOnce = true;
        if (exitPending) {
            // Expanded.
            finish();
            return;
        }
        // Android 13 and later start it in the window. Earlier ones start it in the app's task, on
        // top of the app, and it enters from here.
        if (launchedIntoPip || enterRequested || session == null || isInPictureInPictureMode()) {
            return;
        }
        enterRequested = true;
        PictureInPictureParams params = getIntent().getParcelableExtra(EXTRA_PARAMS);
        boolean accepted = false;
        try {
            accepted = params != null && enterPictureInPictureMode(params);
        } catch (IllegalStateException | IllegalArgumentException e) {
            Log.w(TAG, "Could not enter picture-in-picture", e);
        }
        if (!accepted && !isInPictureInPictureMode()) {
            finish();
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        // In the window it stays started; it stops when the viewer closes it. Not when the screen
        // goes off: the window comes back with it.
        if (session == null || isFinishing() || isChangingConfigurations() || !isInteractive()) {
            return;
        }
        session.onWindowDismissed(this);
        finish();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(enterTimeout);
        removeOnPictureInPictureModeChangedListener(onModeChanged);
        show(null);
        SurfaceViewRenderer surface = renderer;
        renderer = null;
        if (surface != null) {
            surface.release();
        }
        if (session != null) {
            session.onWindowDestroyed(this);
        }
        super.onDestroy();
    }

    /** Shows {@code videoTrack} in place of the one it showed. */
    void show(@Nullable VideoTrack videoTrack) {
        SurfaceViewRenderer surface = renderer;
        VideoTrack previous = track;
        if (surface == null || videoTrack == previous) {
            return;
        }
        track = videoTrack;
        ThreadUtils.runOnExecutor(() -> {
            if (previous != null) {
                try {
                    previous.removeSink(surface);
                } catch (Throwable tr) {
                    // Released already, which removed its sinks.
                }
            }
            if (videoTrack != null) {
                try {
                    videoTrack.addSink(surface);
                } catch (Throwable tr) {
                    Log.e(TAG, "Could not show the video in the picture-in-picture window", tr);
                }
            }
        });
    }

    private void onModeChanged(boolean isInPictureInPicture) {
        if (session == null || isFinishing()) {
            return;
        }
        // The system settling the window it was started in; the viewer has had no chance to act.
        if (!isInPictureInPicture && launchedIntoPip && !resumedOnce) {
            return;
        }
        setShown(isInPictureInPicture);
        if (isInPictureInPicture) {
            entered = true;
            exitPending = false;
            mainHandler.removeCallbacks(enterTimeout);
            session.onWindowEntered(this);
            return;
        }
        if (!entered) {
            return;
        }
        // Expanded, the app is right under it, where the viewer wants to be. Closed, it stops.
        if (getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
            finish();
        } else {
            exitPending = true;
        }
    }

    /** The video and its black ground, or nothing at all. */
    private void setShown(boolean shown) {
        if (root != null) {
            root.setBackgroundColor(shown ? Color.BLACK : Color.TRANSPARENT);
        }
        if (renderer != null) {
            renderer.setVisibility(shown ? View.VISIBLE : View.INVISIBLE);
        }
    }

    private boolean isInteractive() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        return (power == null || power.isInteractive())
                && (keyguard == null || !keyguard.isKeyguardLocked());
    }
}
