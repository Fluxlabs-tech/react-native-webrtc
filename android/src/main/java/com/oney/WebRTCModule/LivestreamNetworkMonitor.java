package com.oney.WebRTCModule;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;

/**
 * Follows the device's default network, for livestream sessions: whether there is one, over what,
 * whether it is metered or the user turned on Data Saver, and when the device moves to another
 * network (a new id). Hands each change to the listener, on ConnectivityManager's thread, as
 * { online, type, expensive, constrained, id }.
 */
final class LivestreamNetworkMonitor {
    interface Listener {
        void onChange(WritableMap state);
    }

    private static final String TAG = WebRTCModule.TAG;

    private final ConnectivityManager connectivity;
    private final Listener listener;

    @Nullable
    private ConnectivityManager.NetworkCallback callback;
    @Nullable
    private Network network;
    private int networkId;
    @Nullable
    private State state;

    LivestreamNetworkMonitor(Context context, Listener listener) {
        this.connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        this.listener = listener;
    }

    synchronized void start() {
        if (callback != null || connectivity == null) {
            return;
        }

        ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                update(network, connectivity.getNetworkCapabilities(network));
            }

            @Override
            public void onCapabilitiesChanged(@NonNull Network network, @NonNull NetworkCapabilities capabilities) {
                update(network, capabilities);
            }

            @Override
            public void onLost(@NonNull Network network) {
                lost(network);
            }
        };

        try {
            // What there is now, before the first callback.
            Network active = connectivity.getActiveNetwork();
            state = stateOf(active, active != null ? connectivity.getNetworkCapabilities(active) : null);
            network = active;
            connectivity.registerDefaultNetworkCallback(callback);
            this.callback = callback;
        } catch (RuntimeException e) {
            // SecurityException without ACCESS_NETWORK_STATE, which the library's manifest declares.
            Log.w(TAG, "LivestreamNetworkMonitor: cannot follow the network", e);
            state = null;
        }
    }

    synchronized void stop() {
        if (callback != null) {
            try {
                connectivity.unregisterNetworkCallback(callback);
            } catch (RuntimeException e) {
                Log.w(TAG, "LivestreamNetworkMonitor: unregister failed", e);
            }
            callback = null;
        }
        network = null;
        state = null;
    }

    @Nullable
    synchronized WritableMap state() {
        return state != null ? state.toMap() : null;
    }

    private void update(Network network, @Nullable NetworkCapabilities capabilities) {
        State next;
        synchronized (this) {
            if (callback == null) {
                return;
            }
            // A new id for each network, so a move between two of the same type still shows.
            if (!network.equals(this.network)) {
                this.network = network;
                networkId++;
            }
            next = stateOf(network, capabilities);
            if (next.equals(state)) {
                return;
            }
            state = next;
        }
        listener.onChange(next.toMap());
    }

    private void lost(Network network) {
        State next;
        synchronized (this) {
            // The default network's replacement, if there is one, arrives in onAvailable.
            if (callback == null || !network.equals(this.network)) {
                return;
            }
            this.network = null;
            next = stateOf(null, null);
            if (next.equals(state)) {
                return;
            }
            state = next;
        }
        listener.onChange(next.toMap());
    }

    private State stateOf(@Nullable Network network, @Nullable NetworkCapabilities capabilities) {
        boolean online = network != null && capabilities != null
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        if (!online) {
            return new State(false, "none", false, false, networkId);
        }

        String type = "other";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            type = "wifi";
        } else if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            type = "cellular";
        } else if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            type = "ethernet";
        }

        boolean expensive = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        boolean constrained = expensive
                && connectivity.getRestrictBackgroundStatus()
                        == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED;
        return new State(true, type, expensive, constrained, networkId);
    }

    private static final class State {
        final boolean online;
        final String type;
        final boolean expensive;
        final boolean constrained;
        final int id;

        State(boolean online, String type, boolean expensive, boolean constrained, int id) {
            this.online = online;
            this.type = type;
            this.expensive = expensive;
            this.constrained = constrained;
            this.id = id;
        }

        WritableMap toMap() {
            WritableMap map = Arguments.createMap();
            map.putBoolean("online", online);
            map.putString("type", type);
            map.putBoolean("expensive", expensive);
            map.putBoolean("constrained", constrained);
            map.putInt("id", id);
            return map;
        }

        @Override
        public boolean equals(Object other) {
            if (!(other instanceof State)) {
                return false;
            }
            State that = (State) other;
            return online == that.online && type.equals(that.type) && expensive == that.expensive
                    && constrained == that.constrained && id == that.id;
        }

        @Override
        public int hashCode() {
            return type.hashCode() * 31 + id;
        }
    }
}
