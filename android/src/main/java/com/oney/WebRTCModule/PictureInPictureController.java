package com.oney.WebRTCModule;

import android.app.Activity;
import android.app.AppOpsManager;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Log;
import android.util.Rational;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.ViewTreeObserver;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.activity.ComponentActivity;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.app.PictureInPictureModeChangedInfo;
import androidx.core.app.PictureInPictureUiStateCompat;
import androidx.core.util.Consumer;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleEventObserver;

import org.webrtc.EglRenderer;
import org.webrtc.RendererCommon.ScalingType;
import org.webrtc.SurfaceViewRenderer;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Android picture-in-picture for one {@link WebRTCView}.
 *
 * Android has no separate PiP video window: the whole activity shrinks into it. So while the
 * activity is in PiP, the window's content is hidden and the view's {@link SurfaceViewRenderer}
 * is moved to the top of the window, where it fills whatever size the PiP window is. The content
 * is hidden with {@code GONE}, so the React root keeps its full-screen layout and nothing
 * re-lays out for the small window.
 *
 * What makes the transition seamless, rather than just working:
 *
 * - The swap happens as the transition starts, not when it ends: on Android 15+ from the
 *   "transitioning to PiP" UI state, otherwise when the activity pauses already in PiP, and
 *   before {@code enterPictureInPictureMode} for an explicit request. The shrink animation then
 *   shows the video rather than the screen around it.
 * - Moving a SurfaceView destroys its surface, which shows black until the next frame is drawn.
 *   A snapshot of the last frame covers the renderer until its new surface has drawn one.
 * - The source rect hint and aspect ratio follow the view's layout, so the system animates from
 *   exactly the video on screen into a window of the same shape.
 *
 * Only one view manages the activity's PiP at a time: the most recently enabled one.
 */
final class PictureInPictureController {
    interface Listener {
        /**
         * @param dismissed PiP ended because the user closed the window, not because they
         *     returned to the app. Always {@code false} while entering.
         */
        void onPictureInPictureChange(boolean isInPictureInPicture, boolean dismissed);
    }

    private static final String TAG = WebRTCModule.TAG;

    /** {@link PictureInPictureParams.Builder#setAspectRatio} rejects anything outside these. */
    private static final Rational MIN_ASPECT_RATIO = new Rational(100, 239);
    private static final Rational MAX_ASPECT_RATIO = new Rational(239, 100);

    /** Snapshot size relative to the video frame. It only covers a few frames of transition. */
    private static final float SNAPSHOT_SCALE = 0.5f;

    /** How long a swap waits for a frame to snapshot before going ahead without one. */
    private static final long SNAPSHOT_TIMEOUT_MS = 100;

    /**
     * How long a snapshot may cover the renderer while its new surface waits for a frame. A stream
     * that has stalled keeps its last frame on screen for this long instead of going black.
     */
    private static final long PLACEHOLDER_TIMEOUT_MS = 1000;

    private enum Layout {
        /** The renderer is inside its WebRTCView. */
        INLINE,
        /** A swap to the PiP layout is waiting for its snapshot. */
        ENTERING,
        /** The renderer fills the window and the window's content is hidden. */
        PIP,
        /** A swap back is waiting for its snapshot. */
        EXITING,
    }

    /** Enabled, attached controllers, oldest first. The last one owns the activity's PiP. */
    private static final List<WeakReference<PictureInPictureController>> controllers = new ArrayList<>();

    private final WebRTCView view;
    private final SurfaceViewRenderer renderer;
    private final Listener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private boolean enabled;
    private boolean autoStart = true;
    @Nullable
    private Rational preferredAspectRatio;

    /** Set while registered: enabled and attached to an androidx activity. */
    @Nullable
    private ComponentActivity activity;
    @Nullable
    private ViewTreeObserver viewTreeObserver;
    /** The activity rejected PiP params, most likely because it does not declare PiP support. */
    private boolean paramsRejected;

    private Layout layout = Layout.INLINE;
    /** Bumped by every layout change, so a stale snapshot callback knows to do nothing. */
    private int layoutGeneration;
    /** Runs once a pending swap to the PiP layout has happened. */
    private final List<Runnable> afterEnter = new ArrayList<>();
    /** This controller is one of the reasons the window's content is hidden. */
    private boolean holdsWindow;

    @Nullable
    private ImageView placeholder;
    @Nullable
    private EglRenderer.FrameListener placeholderFrameListener;
    /** The placeholder's frame listener has fired, so there is nothing left to remove. */
    private boolean placeholderFrameDrawn;
    @Nullable
    private Runnable placeholderTimeout;

    private boolean inPictureInPicture;
    /** PiP has ended; the next lifecycle event says whether the user returned or dismissed it. */
    private boolean exitPending;

    // The params last handed to the activity, so layout passes do not repeat the binder call.
    @Nullable
    private Rational appliedAspectRatio;
    @Nullable
    private Rect appliedSourceRectHint;
    @Nullable
    private Boolean appliedAutoEnter;

    private final Consumer<PictureInPictureModeChangedInfo> onModeChanged =
            info -> onPictureInPictureModeChanged(info.isInPictureInPictureMode());

    private final Consumer<PictureInPictureUiStateCompat> onUiStateChanged = state -> {
        // Android 15+ reports the start of the transition; earlier versions never do.
        if (isOwner() && state.isTransitioningToPip()) {
            enterPipLayout(true, null);
        }
    };

    private final Runnable onUserLeaveHint = this::onUserLeaveHint;

    private final LifecycleEventObserver onLifecycleEvent = (source, event) -> onLifecycleEvent(event);

    private final ViewTreeObserver.OnGlobalLayoutListener onGlobalLayout = this::applyParams;

    private final ViewTreeObserver.OnScrollChangedListener onScrollChanged = this::applyParams;

    PictureInPictureController(WebRTCView view, SurfaceViewRenderer renderer, Listener listener) {
        this.view = view;
        this.renderer = renderer;
        this.listener = listener;
    }

    /**
     * Whether this device and app can enter PiP right now: the device supports it and the user has
     * not turned it off for the app in Settings.
     */
    static boolean isSupported(@Nullable Context context) {
        if (context == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return false;
        }
        if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            return false;
        }
        AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) {
            return true;
        }
        int uid = Process.myUid();
        String packageName = context.getPackageName();
        int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, uid, packageName)
                : appOps.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, uid, packageName);
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    // Props

    void setEnabled(boolean enabled) {
        if (this.enabled == enabled) {
            return;
        }
        this.enabled = enabled;
        if (enabled) {
            register();
        } else {
            unregister(true);
        }
    }

    void setAutoStart(boolean autoStart) {
        if (this.autoStart == autoStart) {
            return;
        }
        this.autoStart = autoStart;
        applyParams();
    }

    void setPreferredAspectRatio(@Nullable Rational aspectRatio) {
        if (Objects.equals(preferredAspectRatio, aspectRatio)) {
            return;
        }
        preferredAspectRatio = aspectRatio;
        applyParams();
    }

    // WebRTCView hooks

    void onAttachedToWindow() {
        register();
    }

    void onDetachedFromWindow() {
        // No reattaching the renderer here: a child added while its parent detaches is left
        // attached to the window. WebRTCView puts it back when it is next attached.
        unregister(false);
    }

    /** The video track, its resolution or the view's scaling changed. */
    void onVideoChanged() {
        applyParams();
    }

    /** An explicit request, from the {@code startPictureInPicture} command. */
    void enterPictureInPicture() {
        ComponentActivity target = activity;
        if (target == null || !isOwner() || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !isSupported(target)) {
            Log.d(TAG, "Picture-in-picture is not available for this RTCView.");
            return;
        }
        if (target.isInPictureInPictureMode()) {
            return;
        }
        PictureInPictureParams params = currentParams();
        // Swap first, so the transition starts from the video alone.
        enterPipLayout(true, () -> {
            if (activity != target || !isOwner()) {
                return;
            }
            if (!enterPictureInPictureMode(target, params)) {
                exitPipLayout();
            }
        });
    }

    // Registration

    private void register() {
        if (activity != null || !enabled || !view.isAttachedToWindow()) {
            return;
        }
        Activity current = view.getCurrentActivity();
        if (!(current instanceof ComponentActivity)) {
            Log.w(TAG, "Picture-in-picture needs an androidx ComponentActivity.");
            return;
        }
        PictureInPictureController previous = owner();

        activity = (ComponentActivity) current;
        activity.addOnPictureInPictureModeChangedListener(onModeChanged);
        activity.addOnPictureInPictureUiStateChangedListener(onUiStateChanged);
        activity.addOnUserLeaveHintListener(onUserLeaveHint);
        activity.getLifecycle().addObserver(onLifecycleEvent);

        viewTreeObserver = view.getViewTreeObserver();
        viewTreeObserver.addOnGlobalLayoutListener(onGlobalLayout);
        viewTreeObserver.addOnScrollChangedListener(onScrollChanged);

        controllers.add(new WeakReference<>(this));
        if (previous != null) {
            previous.exitPipLayoutNow(previous.view.isAttachedToWindow());
        }
        onOwnershipGained();
    }

    private void unregister(boolean reattachRenderer) {
        ComponentActivity released = activity;
        if (released == null) {
            return;
        }
        boolean wasOwner = isOwner();
        boolean rejected = paramsRejected;

        exitPipLayoutNow(reattachRenderer);

        released.removeOnPictureInPictureModeChangedListener(onModeChanged);
        released.removeOnPictureInPictureUiStateChangedListener(onUiStateChanged);
        released.removeOnUserLeaveHintListener(onUserLeaveHint);
        released.getLifecycle().removeObserver(onLifecycleEvent);
        if (viewTreeObserver != null && viewTreeObserver.isAlive()) {
            viewTreeObserver.removeOnGlobalLayoutListener(onGlobalLayout);
            viewTreeObserver.removeOnScrollChangedListener(onScrollChanged);
        }
        viewTreeObserver = null;

        removeController(this);
        activity = null;
        inPictureInPicture = false;
        exitPending = false;
        paramsRejected = false;

        if (!wasOwner) {
            return;
        }
        PictureInPictureController next = owner();
        if (next != null) {
            next.onOwnershipGained();
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !rejected) {
            // Nothing left to show: leaving the app must no longer shrink it into PiP.
            setParams(released, new PictureInPictureParams.Builder().setAutoEnterEnabled(false).build());
        }
    }

    /** This controller now owns the activity's PiP: newly enabled, or the newer owner went away. */
    private void onOwnershipGained() {
        forgetAppliedParams();
        applyParams();

        // Already in PiP, e.g. a player remounted to reconnect. No snapshot: this renderer may not
        // have drawn anything yet.
        ComponentActivity current = activity;
        if (current != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && current.isInPictureInPictureMode()) {
            enterPipLayout(false, null);
            if (!inPictureInPicture) {
                inPictureInPicture = true;
                listener.onPictureInPictureChange(true, false);
            }
        }
    }

    @Nullable
    private static PictureInPictureController owner() {
        for (int i = controllers.size() - 1; i >= 0; i--) {
            PictureInPictureController controller = controllers.get(i).get();
            if (controller != null) {
                return controller;
            }
            controllers.remove(i);
        }
        return null;
    }

    private boolean isOwner() {
        return activity != null && owner() == this;
    }

    private static void removeController(PictureInPictureController controller) {
        for (int i = controllers.size() - 1; i >= 0; i--) {
            PictureInPictureController c = controllers.get(i).get();
            if (c == null || c == controller) {
                controllers.remove(i);
            }
        }
    }

    // Activity callbacks

    private void onUserLeaveHint() {
        // Android 12+ enters by itself: auto-enter is part of the params. Earlier versions have to
        // be asked here, the one callback that comes before the activity pauses.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return;
        }
        ComponentActivity target = activity;
        if (target == null || !isOwner() || !autoStart || !view.hasVideoTrack() || !isSupported(target)) {
            return;
        }
        if (enterPictureInPictureMode(target, currentParams())) {
            enterPipLayout(true, null);
        }
    }

    private void onPictureInPictureModeChanged(boolean isInPictureInPicture) {
        ComponentActivity current = activity;
        if (current == null || !isOwner() || inPictureInPicture == isInPictureInPicture) {
            return;
        }
        inPictureInPicture = isInPictureInPicture;

        if (isInPictureInPicture) {
            exitPending = false;
            enterPipLayout(true, null);
            listener.onPictureInPictureChange(true, false);
            return;
        }

        exitPipLayout();
        // Returning to the app resumes the activity; closing the window stops it.
        Lifecycle.State state = current.getLifecycle().getCurrentState();
        if (state.isAtLeast(Lifecycle.State.RESUMED)) {
            listener.onPictureInPictureChange(false, false);
        } else if (!state.isAtLeast(Lifecycle.State.STARTED)) {
            listener.onPictureInPictureChange(false, true);
        } else {
            exitPending = true;
        }
    }

    private void onLifecycleEvent(Lifecycle.Event event) {
        ComponentActivity current = activity;
        if (current == null || !isOwner() || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return;
        }
        switch (event) {
            case ON_PAUSE:
                // Pausing into PiP: on some versions this comes before the mode change.
                if (current.isInPictureInPictureMode()) {
                    enterPipLayout(true, null);
                }
                break;
            case ON_RESUME:
                resolvePendingExit(false);
                // A PiP layout without PiP, e.g. entering was refused.
                if (!current.isInPictureInPictureMode()) {
                    exitPipLayout();
                }
                break;
            case ON_STOP:
                resolvePendingExit(true);
                if (!current.isInPictureInPictureMode()) {
                    exitPipLayout();
                }
                break;
            default:
                break;
        }
    }

    private void resolvePendingExit(boolean dismissed) {
        if (!exitPending) {
            return;
        }
        exitPending = false;
        listener.onPictureInPictureChange(false, dismissed);
    }

    // Params

    private void applyParams() {
        ComponentActivity target = activity;
        if (target == null || !isOwner() || layout != Layout.INLINE || paramsRejected
                || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        Rational aspectRatio = aspectRatio();
        Rect sourceRectHint = sourceRectHint(aspectRatio);
        boolean autoEnter = autoStart && view.hasVideoTrack();

        if (Objects.equals(aspectRatio, appliedAspectRatio) && Objects.equals(sourceRectHint, appliedSourceRectHint)
                && Objects.equals(autoEnter, appliedAutoEnter)) {
            return;
        }
        if (setParams(target, buildParams(aspectRatio, sourceRectHint, autoEnter))) {
            appliedAspectRatio = aspectRatio;
            appliedSourceRectHint = sourceRectHint;
            appliedAutoEnter = autoEnter;
        } else {
            paramsRejected = true;
        }
    }

    private void forgetAppliedParams() {
        appliedAspectRatio = null;
        appliedSourceRectHint = null;
        appliedAutoEnter = null;
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private PictureInPictureParams currentParams() {
        Rational aspectRatio = aspectRatio();
        return buildParams(aspectRatio, sourceRectHint(aspectRatio), autoStart && view.hasVideoTrack());
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private static PictureInPictureParams buildParams(
            @Nullable Rational aspectRatio, @Nullable Rect sourceRectHint, boolean autoEnter) {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
        if (aspectRatio != null) {
            builder.setAspectRatio(aspectRatio);
        }
        if (sourceRectHint != null) {
            builder.setSourceRectHint(sourceRectHint);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(autoEnter);
        }
        return builder.build();
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private static boolean setParams(Activity activity, PictureInPictureParams params) {
        try {
            activity.setPictureInPictureParams(params);
            return true;
        } catch (IllegalStateException | IllegalArgumentException e) {
            // IllegalStateException: the activity does not declare android:supportsPictureInPicture.
            Log.w(TAG, "Picture-in-picture params were rejected", e);
            return false;
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private static boolean enterPictureInPictureMode(Activity activity, PictureInPictureParams params) {
        try {
            return activity.enterPictureInPictureMode(params);
        } catch (IllegalStateException | IllegalArgumentException e) {
            Log.w(TAG, "Could not enter picture-in-picture", e);
            return false;
        }
    }

    /**
     * The shape of the PiP window. {@code cover} keeps what the viewer sees, the view's own shape;
     * {@code contain} shows the whole frame, the video's shape.
     */
    @Nullable
    private Rational aspectRatio() {
        Rational ratio = preferredAspectRatio;
        if (ratio == null && view.getScalingType() == ScalingType.SCALE_ASPECT_FIT) {
            ratio = view.getVideoAspectRatio();
        }
        if (ratio == null && view.getWidth() > 0 && view.getHeight() > 0) {
            ratio = new Rational(view.getWidth(), view.getHeight());
        }
        return ratio == null ? null : clampAspectRatio(ratio);
    }

    @Nullable
    private static Rational clampAspectRatio(Rational ratio) {
        if (ratio.isNaN() || ratio.isInfinite() || ratio.isZero()) {
            return null;
        }
        if (ratio.compareTo(MIN_ASPECT_RATIO) < 0) {
            return MIN_ASPECT_RATIO;
        }
        if (ratio.compareTo(MAX_ASPECT_RATIO) > 0) {
            return MAX_ASPECT_RATIO;
        }
        return ratio;
    }

    /**
     * Where the system animates from: the part of the screen showing video, cropped to the PiP
     * window's shape so the animation has nothing to stretch.
     */
    @Nullable
    private Rect sourceRectHint(@Nullable Rational aspectRatio) {
        if (aspectRatio == null) {
            return null;
        }
        // The renderer for contain, where it is letterboxed inside the view; the view for cover.
        View video = view.getScalingType() == ScalingType.SCALE_ASPECT_FIT && renderer.getParent() == view
                ? renderer
                : view;
        Rect rect = new Rect();
        // Window coordinates, clipped to what is on screen...
        if (!video.getGlobalVisibleRect(rect) || rect.isEmpty()) {
            return null;
        }
        // ...moved to screen coordinates, which is what the system animates from when the window
        // does not start at the top of the screen.
        int[] inWindow = new int[2];
        int[] onScreen = new int[2];
        video.getLocationInWindow(inWindow);
        video.getLocationOnScreen(onScreen);
        rect.offset(onScreen[0] - inWindow[0], onScreen[1] - inWindow[1]);
        return cropToAspectRatio(rect, aspectRatio);
    }

    /** The largest centred part of {@code rect} with the given shape. */
    private static Rect cropToAspectRatio(Rect rect, Rational aspectRatio) {
        Rect crop = new Rect(rect);
        float ratio = aspectRatio.floatValue();
        if (rect.width() > rect.height() * ratio) {
            int width = Math.round(rect.height() * ratio);
            crop.left += (rect.width() - width) / 2;
            crop.right = crop.left + width;
        } else {
            int height = Math.round(rect.width() / ratio);
            crop.top += (rect.height() - height) / 2;
            crop.bottom = crop.top + height;
        }
        return crop;
    }

    // Layout

    private void enterPipLayout(boolean snapshot, @Nullable Runnable then) {
        switch (layout) {
            case PIP:
                if (then != null) {
                    then.run();
                }
                return;
            case EXITING:
                // The swap back never happened, so the PiP layout is still in place.
                layout = Layout.PIP;
                layoutGeneration++;
                if (then != null) {
                    then.run();
                }
                return;
            case ENTERING:
                if (then != null) {
                    afterEnter.add(then);
                }
                return;
            case INLINE:
                break;
        }
        if (then != null) {
            afterEnter.add(then);
        }
        layout = Layout.ENTERING;
        int generation = ++layoutGeneration;
        Consumer<Bitmap> swap = bitmap -> {
            if (layoutGeneration != generation || layout != Layout.ENTERING) {
                return;
            }
            swapToPip(bitmap);
            layout = Layout.PIP;
            List<Runnable> pending = new ArrayList<>(afterEnter);
            afterEnter.clear();
            for (Runnable runnable : pending) {
                runnable.run();
            }
        };
        if (snapshot) {
            snapshot(swap);
        } else {
            swap.accept(null);
        }
    }

    private void exitPipLayout() {
        switch (layout) {
            case INLINE:
            case EXITING:
                return;
            case ENTERING:
                // The swap never happened.
                layout = Layout.INLINE;
                layoutGeneration++;
                afterEnter.clear();
                return;
            case PIP:
                break;
        }
        layout = Layout.EXITING;
        int generation = ++layoutGeneration;
        snapshot(bitmap -> {
            if (layoutGeneration != generation || layout != Layout.EXITING) {
                return;
            }
            swapToInline(bitmap, true);
            layout = Layout.INLINE;
            forgetAppliedParams();
            applyParams();
        });
    }

    /** Back inline at once, with no snapshot: the view is going away or losing ownership. */
    private void exitPipLayoutNow(boolean reattachRenderer) {
        layoutGeneration++;
        afterEnter.clear();
        if (layout == Layout.PIP || layout == Layout.EXITING) {
            swapToInline(null, reattachRenderer);
        }
        layout = Layout.INLINE;
        removePlaceholder();
    }

    private void swapToPip(@Nullable Bitmap snapshot) {
        ViewGroup root = contentRoot();
        if (root == null) {
            return;
        }
        if (!holdsWindow) {
            holdsWindow = true;
            SharedWindow.hideContent(root);
        }
        detachRenderer();
        SharedWindow.addPipView(root, renderer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (snapshot != null) {
            showPlaceholder(root, snapshot, null);
        }
    }

    private void swapToInline(@Nullable Bitmap snapshot, boolean reattachRenderer) {
        removePlaceholder();
        detachRenderer();
        if (holdsWindow) {
            holdsWindow = false;
            SharedWindow.restoreContent();
        }
        if (!reattachRenderer) {
            return;
        }
        view.reattachRenderer();
        ViewGroup root = contentRoot();
        Rect rect = root != null ? rectIn(root, view) : null;
        if (snapshot != null && rect != null) {
            showPlaceholder(root, snapshot, rect);
        }
    }

    /** Takes the renderer out of whichever layout has it: its view or the window. */
    private void detachRenderer() {
        ViewParent parent = renderer.getParent();
        if (parent == view) {
            view.removeView(renderer);
        } else if (parent instanceof ViewGroup) {
            SharedWindow.removePipView((ViewGroup) parent, renderer);
        }
    }

    @Nullable
    private ViewGroup contentRoot() {
        Activity current = activity != null ? activity : view.getCurrentActivity();
        return current != null ? current.findViewById(android.R.id.content) : null;
    }

    @Nullable
    private static Rect rectIn(ViewGroup root, View view) {
        if (view.getWidth() == 0 || view.getHeight() == 0) {
            return null;
        }
        int[] rootLocation = new int[2];
        int[] viewLocation = new int[2];
        root.getLocationInWindow(rootLocation);
        view.getLocationInWindow(viewLocation);
        int left = viewLocation[0] - rootLocation[0];
        int top = viewLocation[1] - rootLocation[1];
        return new Rect(left, top, left + view.getWidth(), top + view.getHeight());
    }

    // Snapshots

    /** Calls back on the main thread with the next frame drawn, or {@code null} if none comes soon. */
    private void snapshot(Consumer<Bitmap> callback) {
        final boolean[] done = {false};
        final EglRenderer.FrameListener[] frameListener = new EglRenderer.FrameListener[1];
        final Runnable timeout = () -> {
            if (done[0]) {
                return;
            }
            done[0] = true;
            renderer.removeFrameListener(frameListener[0]);
            callback.accept(null);
        };
        frameListener[0] = bitmap -> mainHandler.post(() -> {
            if (done[0]) {
                return;
            }
            done[0] = true;
            mainHandler.removeCallbacks(timeout);
            callback.accept(bitmap);
        });
        renderer.addFrameListener(frameListener[0], SNAPSHOT_SCALE);
        mainHandler.postDelayed(timeout, SNAPSHOT_TIMEOUT_MS);
    }

    /**
     * Covers the renderer with a still frame until its surface, recreated by the move, has drawn.
     *
     * @param rect where to put it in {@code root}, or {@code null} to fill it
     */
    private void showPlaceholder(ViewGroup root, Bitmap bitmap, @Nullable Rect rect) {
        removePlaceholder();

        ImageView image = new ImageView(root.getContext());
        image.setImageBitmap(bitmap);
        image.setScaleType(view.getScalingType() == ScalingType.SCALE_ASPECT_FILL
                ? ImageView.ScaleType.CENTER_CROP
                : ImageView.ScaleType.FIT_CENTER);
        FrameLayout.LayoutParams params;
        if (rect == null) {
            params = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        } else {
            params = new FrameLayout.LayoutParams(rect.width(), rect.height(), Gravity.TOP | Gravity.START);
            params.leftMargin = rect.left;
            params.topMargin = rect.top;
        }
        SharedWindow.addPipView(root, image, params);
        placeholder = image;

        // A zero scale reports a drawn frame without reading it back. It only fires once the
        // renderer has a surface again, which is exactly when the still can go.
        placeholderFrameDrawn = false;
        placeholderFrameListener = ignored -> mainHandler.post(() -> {
            if (placeholder == image) {
                placeholderFrameDrawn = true;
                removePlaceholder();
            }
        });
        placeholderTimeout = () -> {
            if (placeholder == image) {
                removePlaceholder();
            }
        };
        renderer.addFrameListener(placeholderFrameListener, 0f);
        mainHandler.postDelayed(placeholderTimeout, PLACEHOLDER_TIMEOUT_MS);
    }

    private void removePlaceholder() {
        if (placeholderTimeout != null) {
            mainHandler.removeCallbacks(placeholderTimeout);
            placeholderTimeout = null;
        }
        if (placeholderFrameListener != null) {
            // Removing blocks on the render thread, which a listener that already fired does
            // not need.
            if (!placeholderFrameDrawn) {
                renderer.removeFrameListener(placeholderFrameListener);
            }
            placeholderFrameListener = null;
        }
        if (placeholder != null) {
            ViewParent parent = placeholder.getParent();
            if (parent instanceof ViewGroup) {
                SharedWindow.removePipView((ViewGroup) parent, placeholder);
            }
            placeholder = null;
        }
    }

    /**
     * The window's content, hidden while any controller has its PiP layout up.
     *
     * Shared because two controllers can overlap in PiP: a player remounted to reconnect mounts
     * its new view before or after the old one unmounts. Counting holds means neither order
     * shows the content in between, and neither restores it while the other still needs it.
     */
    private static final class SharedWindow {
        /** Content hidden for PiP, with the visibility to restore. */
        private static final Map<View, Integer> hidden = new HashMap<>();
        /** Views put into the window for PiP: renderers and placeholders. Never hidden. */
        private static final Set<View> pipViews = new HashSet<>();
        private static int holds;

        static void hideContent(ViewGroup root) {
            holds++;
            for (int i = 0; i < root.getChildCount(); i++) {
                View child = root.getChildAt(i);
                if (pipViews.contains(child) || hidden.containsKey(child)) {
                    continue;
                }
                hidden.put(child, child.getVisibility());
                child.setVisibility(View.GONE);
            }
        }

        static void restoreContent() {
            if (holds == 0 || --holds > 0) {
                return;
            }
            for (Map.Entry<View, Integer> entry : hidden.entrySet()) {
                entry.getKey().setVisibility(entry.getValue());
            }
            hidden.clear();
        }

        static void addPipView(ViewGroup root, View pipView, ViewGroup.LayoutParams params) {
            pipViews.add(pipView);
            root.addView(pipView, params);
        }

        static void removePipView(ViewGroup root, View pipView) {
            pipViews.remove(pipView);
            root.removeView(pipView);
        }
    }
}
