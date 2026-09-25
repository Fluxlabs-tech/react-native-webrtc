package com.oney.WebRTCModule;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.util.Pair;
import android.util.SparseArray;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Callback;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.ReadableType;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;
import com.oney.WebRTCModule.webrtcutils.H264AndSoftwareVideoDecoderFactory;
import com.oney.WebRTCModule.webrtcutils.H264AndSoftwareVideoEncoderFactory;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import org.webrtc.*;
import org.webrtc.audio.AudioDeviceModule;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;

// The annotation is how ReactContext.getNativeModule(WebRTCModule.class) finds the module, as
// WebRTCView does.
@ReactModule(name = NativeWebRTCModuleSpec.NAME)
public class WebRTCModule extends NativeWebRTCModuleSpec {
    static final String TAG = WebRTCModule.class.getCanonicalName();

    PeerConnectionFactory mFactory;
    VideoEncoderFactory mVideoEncoderFactory;
    VideoDecoderFactory mVideoDecoderFactory;
    AudioDeviceModule mAudioDeviceModule;

    // The livestream audio the factory was built with; null when the app set its own audio device
    // module, or the manifest turned it off.
    @Nullable
    private LivestreamAudio mLivestreamAudio;

    // Follows the device's network while livestream sessions or the app listen; made on first use.
    @Nullable
    private volatile LivestreamNetworkMonitor mNetworkMonitor;

    // Need to expose the peer connection codec factories here to get capabilities
    private final SparseArray<PeerConnectionObserver> mPeerConnectionObservers;
    final Map<String, MediaStream> localStreams;

    // Store generated certificates by ID to avoid exposing private keys to JS
    private static final Map<String, RtcCertificatePem> mCertificates = new HashMap<>();

    private final GetUserMediaImpl getUserMediaImpl;

    public WebRTCModule(ReactApplicationContext reactContext) {
        super(reactContext);

        mPeerConnectionObservers = new SparseArray<>();
        localStreams = new HashMap<>();

        WebRTCModuleOptions options = WebRTCModuleOptions.getInstance();

        AudioDeviceModule adm = options.audioDeviceModule;
        VideoEncoderFactory encoderFactory = options.videoEncoderFactory;
        VideoDecoderFactory decoderFactory = options.videoDecoderFactory;
        Loggable injectableLogger = options.injectableLogger;
        Logging.Severity loggingSeverity = options.loggingSeverity;
        String fieldTrials = options.fieldTrials;

        // Livestream audio, unless the app brings its own module. Its field trials are read here,
        // before initialize(); its module can only be built after.
        if (adm == null) {
            mLivestreamAudio = LivestreamAudio.fromManifest(reactContext);
            if (mLivestreamAudio != null) {
                fieldTrials = mLivestreamAudio.fieldTrialsAdding(fieldTrials);
            }
        }

        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(reactContext)
                        .setFieldTrials(fieldTrials)
                        .setNativeLibraryLoader(new LibraryLoader())
                        .setInjectableLogger(injectableLogger, loggingSeverity)
                        .createInitializationOptions());

        if (injectableLogger == null && loggingSeverity != null) {
            Logging.enableLogToDebugOutput(loggingSeverity);
        }

        if (encoderFactory == null || decoderFactory == null) {
            // Initialize EGL context required for HW acceleration.
            EglBase.Context eglContext = EglUtils.getRootEglBaseContext();

            if (eglContext != null) {
                encoderFactory = new H264AndSoftwareVideoEncoderFactory(eglContext);
                decoderFactory = new H264AndSoftwareVideoDecoderFactory(eglContext);
            } else {
                encoderFactory = new SoftwareVideoEncoderFactory();
                decoderFactory = new SoftwareVideoDecoderFactory();
            }
        }

        if (adm == null) {
            adm = mLivestreamAudio != null
                    ? mLivestreamAudio.createAudioDeviceModule()
                    : JavaAudioDeviceModule.builder(reactContext).setEnableVolumeLogger(false).createAudioDeviceModule();
        }

        Log.d(TAG, "Using video encoder factory: " + encoderFactory.getClass().getCanonicalName());
        Log.d(TAG, "Using video decoder factory: " + decoderFactory.getClass().getCanonicalName());

        mFactory = PeerConnectionFactory.builder()
                           .setAudioDeviceModule(adm)
                           .setVideoEncoderFactory(encoderFactory)
                           .setVideoDecoderFactory(decoderFactory)
                           .createPeerConnectionFactory();

        // PeerConnectionFactory now owns the adm native pointer, and we don't need it anymore.
        adm.release();

        // Saving the encoder and decoder factories to get codec info later when needed.
        mVideoEncoderFactory = encoderFactory;
        mVideoDecoderFactory = decoderFactory;
        mAudioDeviceModule = adm;

        getUserMediaImpl = new GetUserMediaImpl(this, reactContext);
    }

    private PeerConnection getPeerConnection(int id) {
        PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
        return (pco == null) ? null : pco.getPeerConnection();
    }

    void sendEvent(String eventName, @Nullable ReadableMap params) {
        // Through the emitters codegen generates for the events src/NativeWebRTCModule.ts declares.
        switch (eventName) {
            case "peerConnectionSignalingStateChanged":
                emitPeerConnectionSignalingStateChanged(params);
                break;
            case "peerConnectionStateChanged":
                emitPeerConnectionStateChanged(params);
                break;
            case "peerConnectionOnRenegotiationNeeded":
                emitPeerConnectionOnRenegotiationNeeded(params);
                break;
            case "peerConnectionIceConnectionChanged":
                emitPeerConnectionIceConnectionChanged(params);
                break;
            case "peerConnectionIceGatheringChanged":
                emitPeerConnectionIceGatheringChanged(params);
                break;
            case "peerConnectionGotICECandidate":
                emitPeerConnectionGotICECandidate(params);
                break;
            case "peerConnectionDidOpenDataChannel":
                emitPeerConnectionDidOpenDataChannel(params);
                break;
            case "peerConnectionOnRemoveTrack":
                emitPeerConnectionOnRemoveTrack(params);
                break;
            case "peerConnectionOnTrack":
                emitPeerConnectionOnTrack(params);
                break;
            case "dataChannelStateChanged":
                emitDataChannelStateChanged(params);
                break;
            case "dataChannelReceiveMessage":
                emitDataChannelReceiveMessage(params);
                break;
            case "dataChannelDidChangeBufferedAmount":
                emitDataChannelDidChangeBufferedAmount(params);
                break;
            case "mediaStreamTrackMuteChanged":
                emitMediaStreamTrackMuteChanged(params);
                break;
            case "mediaStreamTrackEnded":
                emitMediaStreamTrackEnded(params);
                break;
            case "livestreamNetworkChanged":
                emitLivestreamNetworkChanged(params);
                break;
            default:
                Log.e(TAG, "sendEvent(): " + eventName + " is not an event of the spec");
        }
    }

    private PeerConnection.IceServer createIceServer(String url) {
        return PeerConnection.IceServer.builder(url).createIceServer();
    }

    private PeerConnection.IceServer createIceServer(String url, String username, String credential) {
        return PeerConnection.IceServer.builder(url).setUsername(username).setPassword(credential).createIceServer();
    }

    private List<PeerConnection.IceServer> createIceServers(ReadableArray iceServersArray) {
        final int size = (iceServersArray == null) ? 0 : iceServersArray.size();
        List<PeerConnection.IceServer> iceServers = new ArrayList<>(size);
        for (int i = 0; i < size; i++) {
            ReadableMap iceServerMap = iceServersArray.getMap(i);
            boolean hasUsernameAndCredential = iceServerMap.hasKey("username") && iceServerMap.hasKey("credential");
            if (iceServerMap.hasKey("urls")) {
                switch (iceServerMap.getType("urls")) {
                    case String:
                        if (hasUsernameAndCredential) {
                            iceServers.add(createIceServer(iceServerMap.getString("urls"),
                                    iceServerMap.getString("username"),
                                    iceServerMap.getString("credential")));
                        } else {
                            iceServers.add(createIceServer(iceServerMap.getString("urls")));
                        }
                        break;
                    case Array:
                        ReadableArray urls = iceServerMap.getArray("urls");
                        for (int j = 0; j < urls.size(); j++) {
                            String url = urls.getString(j);
                            if (hasUsernameAndCredential) {
                                iceServers.add(createIceServer(
                                        url, iceServerMap.getString("username"), iceServerMap.getString("credential")));
                            } else {
                                iceServers.add(createIceServer(url));
                            }
                        }
                        break;
                }
            }
        }
        return iceServers;
    }

    private PeerConnection.RTCConfiguration parseRTCConfiguration(ReadableMap map) {
        ReadableArray iceServersArray = null;
        if (map != null && map.hasKey("iceServers")) {
            iceServersArray = map.getArray("iceServers");
        }
        List<PeerConnection.IceServer> iceServers = createIceServers(iceServersArray);

        PeerConnection.RTCConfiguration conf = new PeerConnection.RTCConfiguration(iceServers);
        conf.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        // Required for perfect negotiation.
        conf.enableImplicitRollback = true;

        // Enable GCM ciphers.
        CryptoOptions cryptoOptions = CryptoOptions.builder()
                                              .setEnableGcmCryptoSuites(true)
                                              .setEnableAes128Sha1_32CryptoCipher(false)
                                              .setEnableEncryptedRtpHeaderExtensions(false)
                                              .setRequireFrameEncryption(false)
                                              .createCryptoOptions();
        conf.cryptoOptions = cryptoOptions;

        if (map == null) {
            return conf;
        }

        // iceTransportPolicy (public api)
        if (map.hasKey("iceTransportPolicy") && map.getType("iceTransportPolicy") == ReadableType.String) {
            final String v = map.getString("iceTransportPolicy");
            if (v != null) {
                switch (v) {
                    case "all": // public
                        conf.iceTransportsType = PeerConnection.IceTransportsType.ALL;
                        break;
                    case "relay": // public
                        conf.iceTransportsType = PeerConnection.IceTransportsType.RELAY;
                        break;
                    case "nohost":
                        conf.iceTransportsType = PeerConnection.IceTransportsType.NOHOST;
                        break;
                    case "none":
                        conf.iceTransportsType = PeerConnection.IceTransportsType.NONE;
                        break;
                }
            }
        }

        // bundlePolicy (public api)
        if (map.hasKey("bundlePolicy") && map.getType("bundlePolicy") == ReadableType.String) {
            final String v = map.getString("bundlePolicy");
            if (v != null) {
                switch (v) {
                    case "balanced": // public
                        conf.bundlePolicy = PeerConnection.BundlePolicy.BALANCED;
                        break;
                    case "max-compat": // public
                        conf.bundlePolicy = PeerConnection.BundlePolicy.MAXCOMPAT;
                        break;
                    case "max-bundle": // public
                        conf.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
                        break;
                }
            }
        }

        // rtcpMuxPolicy (public api)
        if (map.hasKey("rtcpMuxPolicy") && map.getType("rtcpMuxPolicy") == ReadableType.String) {
            final String v = map.getString("rtcpMuxPolicy");
            if (v != null) {
                switch (v) {
                    case "negotiate": // public
                        conf.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.NEGOTIATE;
                        break;
                    case "require": // public
                        conf.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE;
                        break;
                }
            }
        }

        // FIXME: peerIdentity of type DOMString (public api)

        // certificates (public api)
        if (map.hasKey("certificates") && map.getType("certificates") == ReadableType.Array) {
            ReadableArray certificates = map.getArray("certificates");
            if (certificates.size() > 0) {
                ReadableMap certMap = certificates.getMap(0);
                if (certMap.hasKey("certificateId")) {
                    String certId = certMap.getString("certificateId");
                    RtcCertificatePem cert;
                    synchronized (mCertificates) {
                        cert = mCertificates.get(certId);
                    }
                    if (cert != null) {
                        conf.certificate = cert;
                    }
                }
            }
        }

        // iceCandidatePoolSize of type unsigned short, defaulting to 0
        if (map.hasKey("iceCandidatePoolSize") && map.getType("iceCandidatePoolSize") == ReadableType.Number) {
            final int v = map.getInt("iceCandidatePoolSize");
            if (v > 0) {
                conf.iceCandidatePoolSize = v;
            }
        }

        // === below is private api in webrtc ===

        // tcpCandidatePolicy (private api)
        if (map.hasKey("tcpCandidatePolicy") && map.getType("tcpCandidatePolicy") == ReadableType.String) {
            final String v = map.getString("tcpCandidatePolicy");
            if (v != null) {
                switch (v) {
                    case "enabled":
                        conf.tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.ENABLED;
                        break;
                    case "disabled":
                        conf.tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED;
                        break;
                }
            }
        }

        // candidateNetworkPolicy (private api)
        if (map.hasKey("candidateNetworkPolicy") && map.getType("candidateNetworkPolicy") == ReadableType.String) {
            final String v = map.getString("candidateNetworkPolicy");
            if (v != null) {
                switch (v) {
                    case "all":
                        conf.candidateNetworkPolicy = PeerConnection.CandidateNetworkPolicy.ALL;
                        break;
                    case "low_cost":
                        conf.candidateNetworkPolicy = PeerConnection.CandidateNetworkPolicy.LOW_COST;
                        break;
                }
            }
        }

        // KeyType (private api)
        if (map.hasKey("keyType") && map.getType("keyType") == ReadableType.String) {
            final String v = map.getString("keyType");
            if (v != null) {
                switch (v) {
                    case "RSA":
                        conf.keyType = PeerConnection.KeyType.RSA;
                        break;
                    case "ECDSA":
                        conf.keyType = PeerConnection.KeyType.ECDSA;
                        break;
                }
            }
        }

        // continualGatheringPolicy (private api)
        if (map.hasKey("continualGatheringPolicy") && map.getType("continualGatheringPolicy") == ReadableType.String) {
            final String v = map.getString("continualGatheringPolicy");
            if (v != null) {
                switch (v) {
                    case "gather_once":
                        conf.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE;
                        break;
                    case "gather_continually":
                        conf.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
                        break;
                }
            }
        }

        // audioJitterBufferMaxPackets (private api)
        if (map.hasKey("audioJitterBufferMaxPackets")
                && map.getType("audioJitterBufferMaxPackets") == ReadableType.Number) {
            final int v = map.getInt("audioJitterBufferMaxPackets");
            if (v > 0) {
                conf.audioJitterBufferMaxPackets = v;
            }
        }

        // iceConnectionReceivingTimeout (private api)
        if (map.hasKey("iceConnectionReceivingTimeout")
                && map.getType("iceConnectionReceivingTimeout") == ReadableType.Number) {
            final int v = map.getInt("iceConnectionReceivingTimeout");
            conf.iceConnectionReceivingTimeout = v;
        }

        // iceBackupCandidatePairPingInterval (private api)
        if (map.hasKey("iceBackupCandidatePairPingInterval")
                && map.getType("iceBackupCandidatePairPingInterval") == ReadableType.Number) {
            final int v = map.getInt("iceBackupCandidatePairPingInterval");
            conf.iceBackupCandidatePairPingInterval = v;
        }

        // audioJitterBufferFastAccelerate (private api)
        if (map.hasKey("audioJitterBufferFastAccelerate")
                && map.getType("audioJitterBufferFastAccelerate") == ReadableType.Boolean) {
            final boolean v = map.getBoolean("audioJitterBufferFastAccelerate");
            conf.audioJitterBufferFastAccelerate = v;
        }

        // pruneTurnPorts (private api)
        if (map.hasKey("pruneTurnPorts") && map.getType("pruneTurnPorts") == ReadableType.Boolean) {
            final boolean v = map.getBoolean("pruneTurnPorts");
            conf.pruneTurnPorts = v;
        }

        // presumeWritableWhenFullyRelayed (private api)
        if (map.hasKey("presumeWritableWhenFullyRelayed")
                && map.getType("presumeWritableWhenFullyRelayed") == ReadableType.Boolean) {
            final boolean v = map.getBoolean("presumeWritableWhenFullyRelayed");
            conf.presumeWritableWhenFullyRelayed = v;
        }

        return conf;
    }

    @Override
    public boolean peerConnectionInit(ReadableMap configuration, double idDouble) {
        int id = (int) idDouble;
        PeerConnection.RTCConfiguration rtcConfiguration = parseRTCConfiguration(configuration);

        try {
            return (boolean) ThreadUtils
                    .submitToExecutor(() -> {
                        PeerConnectionObserver observer = new PeerConnectionObserver(this, id);
                        PeerConnection peerConnection = mFactory.createPeerConnection(rtcConfiguration, observer);
                        if (peerConnection == null) {
                            return false;
                        }
                        observer.setPeerConnection(peerConnection);
                        mPeerConnectionObservers.put(id, observer);
                        return true;
                    })
                    .get();
        } catch (ExecutionException | InterruptedException e) {
            e.printStackTrace();
            throw new RuntimeException(e);
        }
    }

    // Must be called in the executor.
    MediaStream getStreamForReactTag(String streamReactTag) {
        MediaStream stream = localStreams.get(streamReactTag);

        if (stream != null) {
            return stream;
        }

        for (int i = 0, size = mPeerConnectionObservers.size(); i < size; i++) {
            PeerConnectionObserver pco = mPeerConnectionObservers.valueAt(i);
            stream = pco.remoteStreams.get(streamReactTag);
            if (stream != null) {
                return stream;
            }
        }

        return null;
    }

    public MediaStreamTrack getTrack(int pcId, String trackId) {
        if (pcId == -1) {
            return getLocalTrack(trackId);
        }

        PeerConnectionObserver pco = mPeerConnectionObservers.get(pcId);
        if (pco == null) {
            Log.d(TAG, "getTrack(): could not find PeerConnection");
            return null;
        }

        return pco.remoteTracks.get(trackId);
    }

    MediaStreamTrack getLocalTrack(String trackId) {
        return getUserMediaImpl.getTrack(trackId);
    }

    public VideoTrack createVideoTrack(AbstractVideoCaptureController videoCaptureController) {
        return getUserMediaImpl.createVideoTrack(videoCaptureController);
    }

    public void createStream(
            MediaStreamTrack[] tracks, GetUserMediaImpl.BiConsumer<String, ArrayList<WritableMap>> successCallback) {
        getUserMediaImpl.createStream(tracks, successCallback);
    }

    /**
     * Turns an "options" <tt>ReadableMap</tt> into a <tt>MediaConstraints</tt> object.
     *
     * @param options A <tt>ReadableMap</tt> which represents a JavaScript
     * object specifying the options to be parsed into a
     * <tt>MediaConstraints</tt> instance.
     * @return A new <tt>MediaConstraints</tt> instance initialized with the
     * mandatory keys and values specified by <tt>options</tt>.
     */
    MediaConstraints constraintsForOptions(ReadableMap options) {
        MediaConstraints mediaConstraints = new MediaConstraints();
        ReadableMapKeySetIterator keyIterator = options.keySetIterator();

        while (keyIterator.hasNextKey()) {
            String key = keyIterator.nextKey();
            String value = ReactBridgeUtil.getMapStrValue(options, key);

            mediaConstraints.mandatory.add(new MediaConstraints.KeyValuePair(key, value));
        }

        return mediaConstraints;
    }

    @Override
    public WritableMap peerConnectionAddTransceiver(double idDouble, ReadableMap options) {
        int id = (int) idDouble;
        try {
            return (WritableMap) ThreadUtils
                    .submitToExecutor((Callable<Object>) () -> {
                        PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
                        if (pco == null) {
                            Log.d(TAG, "peerConnectionAddTransceiver() peerConnection is null");
                            return null;
                        }

                        RtpTransceiver transceiver = null;
                        if (options.hasKey("type")) {
                            String kind = options.getString("type");
                            transceiver = pco.addTransceiver(SerializeUtils.parseMediaType(kind),
                                    SerializeUtils.parseTransceiverOptions(options.getMap("init")));
                        } else if (options.hasKey("trackId")) {
                            String trackId = options.getString("trackId");
                            MediaStreamTrack track = getLocalTrack(trackId);
                            transceiver = pco.addTransceiver(
                                    track, SerializeUtils.parseTransceiverOptions(options.getMap("init")));

                        } else {
                            // This should technically never happen as the JS side checks for that.
                            Log.d(TAG, "peerConnectionAddTransceiver() no type nor trackId provided in options");
                            return null;
                        }

                        if (transceiver == null) {
                            Log.d(TAG, "peerConnectionAddTransceiver() Error adding transceiver");
                            return null;
                        }
                        WritableMap params = Arguments.createMap();
                        // We need to get a unique order at which the transceiver was created
                        // to reorder the cached array of transceivers on the JS layer.
                        params.putInt("transceiverOrder", pco.getNextTransceiverId());
                        params.putMap("transceiver", SerializeUtils.serializeTransceiver(id, transceiver));
                        return params;
                    })
                    .get();
        } catch (InterruptedException | ExecutionException e) {
            Log.d(TAG, "peerConnectionAddTransceiver() " + e.getMessage());
            return null;
        }
    }

    @Override
    public WritableMap peerConnectionAddTrack(double idDouble, String trackId, ReadableMap options) {
        int id = (int) idDouble;
        try {
            return (WritableMap) ThreadUtils
                    .submitToExecutor((Callable<Object>) () -> {
                        PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
                        if (pco == null) {
                            Log.d(TAG, "peerConnectionAddTrack() peerConnection is null");
                            return null;
                        }

                        MediaStreamTrack track = getLocalTrack(trackId);
                        if (track == null) {
                            Log.w(TAG, "peerConnectionAddTrack() couldn't find track " + trackId);
                            return null;
                        }

                        List<String> streamIds = new ArrayList<>();
                        if (options.hasKey("streamIds")) {
                            ReadableArray rawStreamIds = options.getArray("streamIds");
                            if (rawStreamIds != null) {
                                for (int i = 0; i < rawStreamIds.size(); i++) {
                                    streamIds.add(rawStreamIds.getString(i));
                                }
                            }
                        }
                        RtpSender sender = pco.getPeerConnection().addTrack(track, streamIds);

                        // Need to get the corresponding transceiver as well
                        RtpTransceiver transceiver = pco.getTransceiver(sender.id());

                        // We need the transceiver creation order to reorder the transceivers array
                        // in the JS layer.
                        WritableMap params = Arguments.createMap();
                        params.putInt("transceiverOrder", pco.getNextTransceiverId());
                        params.putMap("transceiver", SerializeUtils.serializeTransceiver(id, transceiver));
                        params.putMap("sender", SerializeUtils.serializeSender(id, sender));
                        return params;
                    })
                    .get();
        } catch (InterruptedException | ExecutionException e) {
            Log.d(TAG, "peerConnectionAddTrack() " + e.getMessage());
            return null;
        }
    }

    @Override
    public boolean peerConnectionRemoveTrack(double idDouble, String senderId) {
        int id = (int) idDouble;
        try {
            return (boolean) ThreadUtils
                    .submitToExecutor((Callable<Object>) () -> {
                        PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
                        if (pco == null) {
                            Log.d(TAG, "peerConnectionRemoveTrack() peerConnection is null");
                            return false;
                        }
                        RtpSender sender = pco.getSender(senderId);
                        if (sender == null) {
                            Log.w(TAG, "peerConnectionRemoveTrack() sender is null");
                            return false;
                        }

                        return pco.getPeerConnection().removeTrack(sender);
                    })
                    .get();
        } catch (InterruptedException | ExecutionException e) {
            Log.d(TAG, "peerConnectionRemoveTrack() " + e.getMessage());
            return false;
        }
    }

    @Override
    public void senderSetParameters(double idDouble, String senderId, ReadableMap options, Promise promise) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            try {
                PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
                if (pco == null) {
                    Log.d(TAG, "senderSetParameters() peerConnectionObserver is null");
                    promise.reject(new Exception("Peer Connection is not initialized"));
                    return;
                }

                RtpSender sender = pco.getSender(senderId);
                if (sender == null) {
                    Log.w(TAG, "senderSetParameters() sender is null");
                    promise.reject(new Exception("Could not get sender"));
                    return;
                }

                RtpParameters params = sender.getParameters();
                params = SerializeUtils.updateRtpParameters(options, params);
                sender.setParameters(params);
                promise.resolve(SerializeUtils.serializeRtpParameters(sender.getParameters()));
            } catch (Exception e) {
                Log.d(TAG, "senderSetParameters: " + e.getMessage());
                promise.reject(e);
            }
        });
    }

    @Override
    public void transceiverStop(double idDouble, String senderId, Promise promise) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            try {
                PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
                if (pco == null) {
                    Log.d(TAG, "transceiverStop() peerConnectionObserver is null");
                    promise.reject(new Exception("Peer Connection is not initialized"));
                    return;
                }
                RtpTransceiver transceiver = pco.getTransceiver(senderId);
                if (transceiver == null) {
                    Log.w(TAG, "transceiverStop() transceiver is null");
                    promise.reject(new Exception("Could not get transceiver"));
                    return;
                }

                transceiver.stopStandard();
                promise.resolve(true);
            } catch (Exception e) {
                Log.d(TAG, "transceiverStop(): " + e.getMessage());
                promise.reject(e);
            }
        });
    }

    @Override
    public void senderReplaceTrack(double idDouble, String senderId, String trackId, Promise promise) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            try {
                PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
                if (pco == null) {
                    Log.d(TAG, "senderReplaceTrack() peerConnectionObserver is null");
                    promise.reject(new Exception("Peer Connection is not initialized"));
                    return;
                }

                RtpSender sender = pco.getSender(senderId);
                if (sender == null) {
                    Log.w(TAG, "senderReplaceTrack() sender is null");
                    promise.reject(new Exception("Could not get sender"));
                    return;
                }

                MediaStreamTrack track = getLocalTrack(trackId);
                sender.setTrack(track, false);
                promise.resolve(true);
            } catch (Exception e) {
                Log.d(TAG, "senderReplaceTrack(): " + e.getMessage());
                promise.reject(e);
            }
        });
    }

    @Override
    public void transceiverSetDirection(double idDouble, String senderId, String direction, Promise promise) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            WritableMap identifier = Arguments.createMap();
            WritableMap params = Arguments.createMap();
            identifier.putInt("peerConnectionId", id);
            identifier.putString("transceiverId", senderId);
            try {
                PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
                if (pco == null) {
                    Log.d(TAG, "transceiverSetDirection() peerConnectionObserver is null");
                    promise.reject(new Exception("Peer Connection is not initialized"));
                    return;
                }
                RtpTransceiver transceiver = pco.getTransceiver(senderId);
                if (transceiver == null) {
                    Log.d(TAG, "transceiverSetDirection() transceiver is null");
                    promise.reject(new Exception("Could not get sender"));
                    return;
                }

                transceiver.setDirection(SerializeUtils.parseDirection(direction));

                promise.resolve(true);
            } catch (Exception e) {
                Log.d(TAG, "transceiverSetDirection(): " + e.getMessage());
                promise.reject(e);
            }
        });
    }

    @Override
    public boolean transceiverSetCodecPreferences(double idDouble, String senderId, ReadableArray codecPreferences) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            WritableMap identifier = Arguments.createMap();
            WritableMap params = Arguments.createMap();
            identifier.putInt("peerConnectionId", id);
            identifier.putString("transceiverId", senderId);
            try {
                PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
                if (pco == null) {
                    Log.d(TAG, "transceiverSetDirection() peerConnectionObserver is null");
                    return;
                }
                RtpTransceiver transceiver = pco.getTransceiver(senderId);
                if (transceiver == null) {
                    Log.d(TAG, "transceiverSetDirection() transceiver is null");
                    return;
                }

                // Convert JSON codec capabilities to the actual objects.
                RtpTransceiver.RtpTransceiverDirection direction = transceiver.getDirection();
                List<Pair<Map<String, Object>, RtpCapabilities.CodecCapability>> availableCodecs = new ArrayList<>();

                if (direction.equals(RtpTransceiver.RtpTransceiverDirection.SEND_RECV)
                        || direction.equals(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY)) {
                    RtpCapabilities capabilities = mFactory.getRtpSenderCapabilities(transceiver.getMediaType());
                    for (RtpCapabilities.CodecCapability codec : capabilities.codecs) {
                        Map<String, Object> codecDict = SerializeUtils.serializeRtpCapabilitiesCodec(codec).toHashMap();
                        availableCodecs.add(new Pair<>(codecDict, codec));
                    }
                }

                if (direction.equals(RtpTransceiver.RtpTransceiverDirection.SEND_RECV)
                        || direction.equals(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)) {
                    RtpCapabilities capabilities = mFactory.getRtpReceiverCapabilities(transceiver.getMediaType());
                    for (RtpCapabilities.CodecCapability codec : capabilities.codecs) {
                        Map<String, Object> codecDict = SerializeUtils.serializeRtpCapabilitiesCodec(codec).toHashMap();
                        availableCodecs.add(new Pair<>(codecDict, codec));
                    }
                }

                // Codec preferences is order sensitive.
                List<RtpCapabilities.CodecCapability> codecsToSet = new ArrayList<>();

                for (int i = 0; i < codecPreferences.size(); i++) {
                    Map<String, Object> codecPref = codecPreferences.getMap(i).toHashMap();
                    for (Pair<Map<String, Object>, RtpCapabilities.CodecCapability> pair : availableCodecs) {
                        Map<String, Object> availableCodecDict = pair.first;
                        if (codecPref.equals(availableCodecDict)) {
                            codecsToSet.add(pair.second);
                            break;
                        }
                    }
                }

                transceiver.setCodecPreferences(codecsToSet);
            } catch (Exception e) {
                Log.d(TAG, "transceiverSetCodecPreferences(): " + e.getMessage());
            }
        });
        return true;
    }

    @Override
    public void getDisplayMedia(ReadableMap constraints, Promise promise) {
        ThreadUtils.runOnExecutor(() -> getUserMediaImpl.getDisplayMedia(constraints, promise));
    }

    @Override
    public void getUserMedia(ReadableMap constraints, Callback successCallback, Callback errorCallback) {
        ThreadUtils.runOnExecutor(() -> getUserMediaImpl.getUserMedia(constraints, successCallback, errorCallback));
    }

    @Override
    public void enumerateDevices(Callback callback) {
        ThreadUtils.runOnExecutor(() -> callback.invoke(getUserMediaImpl.enumerateDevices()));
    }

    @Override
    public void mediaStreamCreate(String id) {
        ThreadUtils.runOnExecutor(() -> {
            MediaStream mediaStream = mFactory.createLocalMediaStream(id);
            localStreams.put(id, mediaStream);
        });
    }

    @Override
    public void mediaStreamAddTrack(String streamId, double pcIdDouble, String trackId) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            MediaStream stream = localStreams.get(streamId);
            if (stream == null) {
                Log.d(TAG, "mediaStreamAddTrack() could not find stream " + streamId);
                return;
            }

            MediaStreamTrack track = getTrack(pcId, trackId);
            if (track == null) {
                Log.d(TAG, "mediaStreamAddTrack() could not find track " + trackId);
                return;
            }

            String kind = track.kind();
            if ("audio".equals(kind)) {
                stream.addTrack((AudioTrack) track);
            } else if ("video".equals(kind)) {
                stream.addTrack((VideoTrack) track);
            }
        });
    }

    @Override
    public void mediaStreamRemoveTrack(String streamId, double pcIdDouble, String trackId) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            MediaStream stream = localStreams.get(streamId);
            if (stream == null) {
                Log.d(TAG, "mediaStreamRemoveTrack() could not find stream " + streamId);
                return;
            }

            MediaStreamTrack track = getTrack(pcId, trackId);
            if (track == null) {
                Log.d(TAG, "mediaStreamRemoveTrack() could not find track " + trackId);
                return;
            }

            String kind = track.kind();
            if ("audio".equals(kind)) {
                stream.removeTrack((AudioTrack) track);
            } else if ("video".equals(kind)) {
                stream.removeTrack((VideoTrack) track);
            }
        });
    }

    /**
     * Whether the activity is in picture-in-picture. For the moment the app is backgrounded:
     * Android pauses the activity into PiP, so AppState reports "background" while the video is
     * still on screen, and that can reach JS before the view's onPictureInPictureChange does.
     */
    @Override
    public boolean isInPictureInPicture() {
        Activity activity = getCurrentActivity();
        return activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
                && activity.isInPictureInPictureMode();
    }

    /**
     * Whether picture-in-picture can start right now: the device supports it and the user has not
     * turned it off for this app.
     */
    @Override
    public void isPictureInPictureSupported(Promise promise) {
        Context context = getCurrentActivity() != null ? getCurrentActivity() : getReactApplicationContext();
        promise.resolve(PictureInPictureController.isSupported(context));
    }

    @Override
    public WritableMap livestreamAudioState() {
        if (mLivestreamAudio == null) {
            WritableMap state = Arguments.createMap();
            state.putBoolean("installed", false);
            return state;
        }
        return mLivestreamAudio.state();
    }

    @Override
    public boolean livestreamAudioSetLevellerEnabled(boolean enabled) {
        return mLivestreamAudio != null && mLivestreamAudio.setLevellerEnabled(enabled);
    }

    /**
     * DynamicsProcessing exposes no metering, so Android has nothing to report.
     */
    @Nullable
    @Override
    public WritableMap livestreamAudioTakeLevels() {
        return null;
    }

    @Override
    public void livestreamNetworkStart() {
        LivestreamNetworkMonitor monitor;
        synchronized (this) {
            if (mNetworkMonitor == null) {
                mNetworkMonitor = new LivestreamNetworkMonitor(
                        getReactApplicationContext(), state -> sendEvent("livestreamNetworkChanged", state));
            }
            monitor = mNetworkMonitor;
        }
        monitor.start();
    }

    @Override
    public void livestreamNetworkStop() {
        LivestreamNetworkMonitor monitor = mNetworkMonitor;
        if (monitor != null) {
            monitor.stop();
        }
    }

    @Nullable
    @Override
    public WritableMap livestreamNetworkState() {
        LivestreamNetworkMonitor monitor = mNetworkMonitor;
        return monitor != null ? monitor.state() : null;
    }

    @Override
    public void invalidate() {
        livestreamNetworkStop();
        super.invalidate();
    }

    @Override
    public void mediaStreamRelease(String id) {
        ThreadUtils.runOnExecutor(() -> {
            MediaStream stream = localStreams.get(id);
            if (stream == null) {
                Log.d(TAG, "mediaStreamRelease() stream is null");
                return;
            }
            localStreams.remove(id);
            stream.dispose();
        });
    }

    @Override
    public void mediaStreamTrackRelease(String id) {
        ThreadUtils.runOnExecutor(() -> {
            MediaStreamTrack track = getLocalTrack(id);
            if (track == null) {
                Log.d(TAG, "mediaStreamTrackRelease() track is null");
                return;
            }
            track.setEnabled(false);
            getUserMediaImpl.disposeTrack(id);
        });
    }

    @Override
    public void mediaStreamTrackSetEnabled(double pcIdDouble, String id, boolean enabled) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            MediaStreamTrack track = getTrack(pcId, id);
            if (track == null) {
                Log.d(TAG, "mediaStreamTrackSetEnabled() could not find track " + id);
                return;
            }

            if (track.enabled() == enabled) {
                return;
            }
            track.setEnabled(enabled);
            getUserMediaImpl.mediaStreamTrackSetEnabled(id, enabled);
        });
    }

    @Override
    public void mediaStreamTrackApplyConstraints(String id, ReadableMap constraints, Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            MediaStreamTrack track = getLocalTrack(id);
            if (track != null) {
                getUserMediaImpl.applyConstraints(id, constraints, promise);
            } else {
                promise.reject(new Exception("mediaStreamTrackApplyConstraints() could not find track " + id));
            }
        });
    }

    @Override
    public void mediaStreamTrackSetVolume(double pcIdDouble, String id, double volume) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            MediaStreamTrack track = getTrack(pcId, id);
            if (track == null) {
                Log.d(TAG, "mediaStreamTrackSetVolume() could not find track " + id);
                return;
            }

            if (!(track instanceof AudioTrack)) {
                Log.d(TAG, "mediaStreamTrackSetVolume() track is not an AudioTrack!");
                return;
            }

            ((AudioTrack) track).setVolume(volume);
        });
    }

    /**
     * This serializes the transceivers current direction and mid and returns them
     * for update when an sdp negotiation/renegotiation happens
     */
    private ReadableArray getTransceiversInfo(PeerConnection peerConnection) {
        WritableArray transceiverUpdates = Arguments.createArray();

        for (RtpTransceiver transceiver : peerConnection.getTransceivers()) {
            WritableMap transceiverUpdate = Arguments.createMap();

            RtpTransceiver.RtpTransceiverDirection direction = transceiver.getCurrentDirection();
            if (direction != null) {
                String directionSerialized = SerializeUtils.serializeDirection(direction);
                transceiverUpdate.putString("currentDirection", directionSerialized);
            }

            transceiverUpdate.putString("transceiverId", transceiver.getSender().id());
            transceiverUpdate.putString("mid", transceiver.getMid());
            transceiverUpdate.putBoolean("isStopped", transceiver.isStopped());
            transceiverUpdate.putMap("senderRtpParameters",
                    SerializeUtils.serializeRtpParameters(transceiver.getSender().getParameters()));
            transceiverUpdate.putMap("receiverRtpParameters",
                    SerializeUtils.serializeRtpParameters(transceiver.getReceiver().getParameters()));
            transceiverUpdates.pushMap(transceiverUpdate);
        }
        return transceiverUpdates;
    }

    @Override
    public void mediaStreamTrackSetVideoEffects(String id, ReadableArray names) {
        ThreadUtils.runOnExecutor(() -> { getUserMediaImpl.setVideoEffects(id, names); });
    }

    @Override
    public void peerConnectionSetConfiguration(ReadableMap configuration, double idDouble) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnection peerConnection = getPeerConnection(id);
            if (peerConnection == null) {
                Log.d(TAG, "peerConnectionSetConfiguration() peerConnection is null");
                return;
            }
            peerConnection.setConfiguration(parseRTCConfiguration(configuration));
        });
    }

    @Override
    public void peerConnectionCreateOffer(double idDouble, ReadableMap options, Promise promise) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
            PeerConnection peerConnection = pco.getPeerConnection();

            if (peerConnection == null) {
                Log.d(TAG, "peerConnectionCreateOffer() peerConnection is null");
                promise.reject(new Exception("PeerConnection not found"));
                return;
            }

            List<String> receiversIds = new ArrayList<>();
            for (RtpTransceiver transceiver : peerConnection.getTransceivers()) {
                receiversIds.add(transceiver.getReceiver().id());
            }

            final SdpObserver observer = new SdpObserver() {
                @Override
                public void onCreateFailure(String s) {
                    ThreadUtils.runOnExecutor(() -> { promise.reject("E_OPERATION_ERROR", s); });
                }

                @Override
                public void onCreateSuccess(SessionDescription sdp) {
                    ThreadUtils.runOnExecutor(() -> {
                        WritableMap params = Arguments.createMap();
                        WritableMap sdpInfo = Arguments.createMap();

                        sdpInfo.putString("sdp", sdp.description);
                        sdpInfo.putString("type", sdp.type.canonicalForm());

                        params.putArray("transceiversInfo", getTransceiversInfo(peerConnection));
                        params.putMap("sdpInfo", sdpInfo);

                        WritableArray newTransceivers = Arguments.createArray();
                        for (RtpTransceiver transceiver : peerConnection.getTransceivers()) {
                            if (!receiversIds.contains(transceiver.getReceiver().id())) {
                                WritableMap newTransceiver = Arguments.createMap();
                                newTransceiver.putInt("transceiverOrder", pco.getNextTransceiverId());
                                newTransceiver.putMap(
                                        "transceiver", SerializeUtils.serializeTransceiver(id, transceiver));
                                newTransceivers.pushMap(newTransceiver);
                            }
                        }

                        params.putArray("newTransceivers", newTransceivers);

                        promise.resolve(params);
                    });
                }

                @Override
                public void onSetFailure(String s) {}

                @Override
                public void onSetSuccess() {}
            };

            peerConnection.createOffer(observer, constraintsForOptions(options));
        });
    }

    @Override
    public void peerConnectionCreateAnswer(double idDouble, ReadableMap options, Promise promise) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnection peerConnection = getPeerConnection(id);

            if (peerConnection == null) {
                Log.d(TAG, "peerConnectionCreateAnswer() peerConnection is null");
                promise.reject(new Exception("PeerConnection not found"));
                return;
            }

            final SdpObserver observer = new SdpObserver() {
                @Override
                public void onCreateFailure(String s) {
                    ThreadUtils.runOnExecutor(() -> { promise.reject("E_OPERATION_ERROR", s); });
                }

                @Override
                public void onCreateSuccess(SessionDescription sdp) {
                    ThreadUtils.runOnExecutor(() -> {
                        WritableMap params = Arguments.createMap();
                        WritableMap sdpInfo = Arguments.createMap();

                        sdpInfo.putString("sdp", sdp.description);
                        sdpInfo.putString("type", sdp.type.canonicalForm());

                        params.putArray("transceiversInfo", getTransceiversInfo(peerConnection));
                        params.putMap("sdpInfo", sdpInfo);

                        promise.resolve(params);
                    });
                }

                @Override
                public void onSetFailure(String s) {}

                @Override
                public void onSetSuccess() {}
            };

            peerConnection.createAnswer(observer, constraintsForOptions(options));
        });
    }

    @Override
    public void peerConnectionSetLocalDescription(double pcIdDouble, ReadableMap desc, Promise promise) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnection peerConnection = getPeerConnection(pcId);
            if (peerConnection == null) {
                Log.d(TAG, "peerConnectionSetLocalDescription() peerConnection is null");
                promise.reject(new Exception("PeerConnection not found"));
                return;
            }

            final SdpObserver observer = new SdpObserver() {
                @Override
                public void onCreateSuccess(SessionDescription sdp) {}

                @Override
                public void onSetSuccess() {
                    ThreadUtils.runOnExecutor(() -> {
                        WritableMap newSdpMap = Arguments.createMap();
                        WritableMap params = Arguments.createMap();

                        SessionDescription newSdp = peerConnection.getLocalDescription();
                        // Can happen when doing a rollback.
                        if (newSdp != null) {
                            newSdpMap.putString("type", newSdp.type.canonicalForm());
                            newSdpMap.putString("sdp", newSdp.description);
                        }

                        params.putMap("sdpInfo", newSdpMap);
                        params.putArray("transceiversInfo", getTransceiversInfo(peerConnection));

                        promise.resolve(params);
                    });
                }

                @Override
                public void onCreateFailure(String s) {}

                @Override
                public void onSetFailure(String s) {
                    ThreadUtils.runOnExecutor(() -> { promise.reject("E_OPERATION_ERROR", s); });
                }
            };

            if (desc != null) {
                SessionDescription sdp = new SessionDescription(
                        SessionDescription.Type.fromCanonicalForm(Objects.requireNonNull(desc.getString("type"))),
                        desc.getString("sdp"));

                peerConnection.setLocalDescription(observer, sdp);
            } else {
                peerConnection.setLocalDescription(observer);
            }
        });
    }

    @Override
    public void peerConnectionSetRemoteDescription(double idDouble, ReadableMap desc, Promise promise) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
            PeerConnection peerConnection = pco.getPeerConnection();

            if (peerConnection == null) {
                Log.d(TAG, "peerConnectionSetRemoteDescription() peerConnection is null");
                promise.reject(new Exception("PeerConnection not found"));
                return;
            }

            SessionDescription sdp = new SessionDescription(
                    SessionDescription.Type.fromCanonicalForm(desc.getString("type")), desc.getString("sdp"));

            List<String> receiversIds = new ArrayList<>();
            for (RtpTransceiver transceiver : peerConnection.getTransceivers()) {
                receiversIds.add(transceiver.getReceiver().id());
            }

            final SdpObserver observer = new SdpObserver() {
                @Override
                public void onCreateSuccess(final SessionDescription sdp) {}

                @Override
                public void onSetSuccess() {
                    ThreadUtils.runOnExecutor(() -> {
                        WritableMap newSdpMap = Arguments.createMap();
                        WritableMap params = Arguments.createMap();

                        SessionDescription newSdp = peerConnection.getRemoteDescription();
                        // Be defensive for the rollback cases.
                        if (newSdp != null) {
                            newSdpMap.putString("type", newSdp.type.canonicalForm());
                            newSdpMap.putString("sdp", newSdp.description);
                        }

                        params.putArray("transceiversInfo", getTransceiversInfo(peerConnection));
                        params.putMap("sdpInfo", newSdpMap);

                        WritableArray newTransceivers = Arguments.createArray();
                        for (RtpTransceiver transceiver : peerConnection.getTransceivers()) {
                            if (!receiversIds.contains(transceiver.getReceiver().id())) {
                                WritableMap newTransceiver = Arguments.createMap();
                                newTransceiver.putInt("transceiverOrder", pco.getNextTransceiverId());
                                newTransceiver.putMap(
                                        "transceiver", SerializeUtils.serializeTransceiver(id, transceiver));
                                newTransceivers.pushMap(newTransceiver);
                            }
                        }

                        params.putArray("newTransceivers", newTransceivers);

                        promise.resolve(params);
                    });
                }

                @Override
                public void onCreateFailure(String s) {}

                @Override
                public void onSetFailure(String s) {
                    ThreadUtils.runOnExecutor(() -> { promise.reject("E_OPERATION_ERROR", s); });
                }
            };

            peerConnection.setRemoteDescription(observer, sdp);
        });
    }

    @Override
    public WritableMap receiverGetCapabilities(String kind) {
        try {
            return (WritableMap) ThreadUtils
                    .submitToExecutor((Callable<Object>) () -> {
                        MediaStreamTrack.MediaType mediaType;
                        if (kind.equals("audio")) {
                            mediaType = MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO;
                        } else if (kind.equals("video")) {
                            mediaType = MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO;
                        } else {
                            return Arguments.createMap();
                        }

                        RtpCapabilities capabilities = mFactory.getRtpReceiverCapabilities(mediaType);
                        return SerializeUtils.serializeRtpCapabilities(capabilities);
                    })
                    .get();
        } catch (ExecutionException | InterruptedException e) {
            Log.d(TAG, "receiverGetCapabilities() " + e.getMessage());
            return null;
        }
    }

    @Override
    public WritableMap senderGetCapabilities(String kind) {
        try {
            return (WritableMap) ThreadUtils
                    .submitToExecutor((Callable<Object>) () -> {
                        MediaStreamTrack.MediaType mediaType;
                        if (kind.equals("audio")) {
                            mediaType = MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO;
                        } else if (kind.equals("video")) {
                            mediaType = MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO;
                        } else {
                            return Arguments.createMap();
                        }

                        RtpCapabilities capabilities = mFactory.getRtpSenderCapabilities(mediaType);
                        return SerializeUtils.serializeRtpCapabilities(capabilities);
                    })
                    .get();
        } catch (ExecutionException | InterruptedException e) {
            Log.d(TAG, "senderGetCapabilities() " + e.getMessage());
            return null;
        }
    }

    @Override
    public void receiverGetStats(double pcIdDouble, String receiverId, Promise promise) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnectionObserver pco = mPeerConnectionObservers.get(pcId);
            if (pco == null || pco.getPeerConnection() == null) {
                Log.d(TAG, "receiverGetStats() peerConnection is null");
                promise.resolve(StringUtils.statsToJSON(new RTCStatsReport(0, new HashMap<>())));
            } else {
                pco.receiverGetStats(receiverId, promise);
            }
        });
    }

    @Override
    public void senderGetStats(double pcIdDouble, String senderId, Promise promise) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnectionObserver pco = mPeerConnectionObservers.get(pcId);
            if (pco == null || pco.getPeerConnection() == null) {
                Log.d(TAG, "senderGetStats() peerConnection is null");
                promise.resolve(StringUtils.statsToJSON(new RTCStatsReport(0, new HashMap<>())));
            } else {
                pco.senderGetStats(senderId, promise);
            }
        });
    }

    @Override
    public void peerConnectionAddICECandidate(double pcIdDouble, ReadableMap candidateMap, Promise promise) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnection peerConnection = getPeerConnection(pcId);
            if (peerConnection == null) {
                Log.d(TAG, "peerConnectionAddICECandidate() peerConnection is null");
                promise.reject(new Exception("PeerConnection not found"));
                return;
            }

            if (!candidateMap.hasKey("sdpMid") && !candidateMap.hasKey("sdpMLineIndex")) {
                promise.reject("E_TYPE_ERROR", "Invalid argument");
                return;
            }

            IceCandidate candidate = new IceCandidate(candidateMap.hasKey("sdpMid") && !candidateMap.isNull("sdpMid")
                            ? candidateMap.getString("sdpMid")
                            : "",
                    candidateMap.hasKey("sdpMLineIndex") && !candidateMap.isNull("sdpMLineIndex")
                            ? candidateMap.getInt("sdpMLineIndex")
                            : 0,
                    candidateMap.getString("candidate"));

            peerConnection.addIceCandidate(candidate, new AddIceObserver() {
                @Override
                public void onAddSuccess() {
                    ThreadUtils.runOnExecutor(() -> {
                        WritableMap newSdpMap = Arguments.createMap();
                        SessionDescription newSdp = peerConnection.getRemoteDescription();
                        newSdpMap.putString("type", newSdp.type.canonicalForm());
                        newSdpMap.putString("sdp", newSdp.description);
                        promise.resolve(newSdpMap);
                    });
                }

                @Override
                public void onAddFailure(String s) {
                    ThreadUtils.runOnExecutor(() -> { promise.reject("E_OPERATION_ERROR", s); });
                }
            });
        });
    }

    @Override
    public void peerConnectionGetStats(double peerConnectionIdDouble, Promise promise) {
        int peerConnectionId = (int) peerConnectionIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnectionObserver pco = mPeerConnectionObservers.get(peerConnectionId);
            if (pco == null || pco.getPeerConnection() == null) {
                Log.d(TAG, "peerConnectionGetStats() peerConnection is null");
                promise.resolve(StringUtils.statsToJSON(new RTCStatsReport(0, new HashMap<>())));
            } else {
                pco.getStats(promise);
            }
        });
    }

    @Override
    public void peerConnectionClose(double idDouble) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
            if (pco == null || pco.getPeerConnection() == null) {
                Log.d(TAG, "peerConnectionClose() peerConnection is null");
                return;
            }
            pco.close();
        });
    }

    @Override
    public void peerConnectionDispose(double idDouble) {
        int id = (int) idDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnectionObserver pco = mPeerConnectionObservers.get(id);
            if (pco == null || pco.getPeerConnection() == null) {
                Log.d(TAG, "peerConnectionDispose() peerConnection is null");
            }
            pco.dispose();
            mPeerConnectionObservers.remove(id);
        });
    }

    @Override
    public void peerConnectionRestartIce(double pcIdDouble) {
        int pcId = (int) pcIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnection peerConnection = getPeerConnection(pcId);
            if (peerConnection == null) {
                Log.w(TAG, "peerConnectionRestartIce() peerConnection is null");
                return;
            }

            peerConnection.restartIce();
        });
    }

    @Override
    public WritableMap createDataChannel(double peerConnectionIdDouble, String label, ReadableMap config) {
        int peerConnectionId = (int) peerConnectionIdDouble;
        try {
            return (WritableMap) ThreadUtils
                    .submitToExecutor((Callable<Object>) () -> {
                        PeerConnectionObserver pco = mPeerConnectionObservers.get(peerConnectionId);
                        if (pco == null || pco.getPeerConnection() == null) {
                            Log.d(TAG, "createDataChannel() peerConnection is null");
                            return null;
                        } else {
                            return pco.createDataChannel(label, config);
                        }
                    })
                    .get();
        } catch (ExecutionException | InterruptedException e) {
            return null;
        }
    }

    @Override
    public void dataChannelClose(double peerConnectionIdDouble, String reactTag) {
        int peerConnectionId = (int) peerConnectionIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            // Forward to PeerConnectionObserver which deals with DataChannels
            // because DataChannel is owned by PeerConnection.
            PeerConnectionObserver pco = mPeerConnectionObservers.get(peerConnectionId);
            if (pco == null || pco.getPeerConnection() == null) {
                Log.d(TAG, "dataChannelClose() peerConnection is null");
                return;
            }

            pco.dataChannelClose(reactTag);
        });
    }

    @Override
    public void dataChannelDispose(double peerConnectionIdDouble, String reactTag) {
        int peerConnectionId = (int) peerConnectionIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            PeerConnectionObserver pco = mPeerConnectionObservers.get(peerConnectionId);
            if (pco == null || pco.getPeerConnection() == null) {
                Log.d(TAG, "dataChannelDispose() peerConnection is null");
                return;
            }

            pco.dataChannelDispose(reactTag);
        });
    }

    @Override
    public void dataChannelSend(double peerConnectionIdDouble, String reactTag, String data, String type) {
        int peerConnectionId = (int) peerConnectionIdDouble;
        ThreadUtils.runOnExecutor(() -> {
            // Forward to PeerConnectionObserver which deals with DataChannels
            // because DataChannel is owned by PeerConnection.
            PeerConnectionObserver pco = mPeerConnectionObservers.get(peerConnectionId);
            if (pco == null || pco.getPeerConnection() == null) {
                Log.d(TAG, "dataChannelSend() peerConnection is null");
                return;
            }

            pco.dataChannelSend(reactTag, data, type);
        });
    }

    @Override
    public void generateCertificate(ReadableMap options, Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            try {
                PeerConnection.KeyType keyType = PeerConnection.KeyType.ECDSA;
                long expires = 2592000L; // Default 30 days

                if (options.hasKey("keyType")) {
                    String keyTypeStr = options.getString("keyType");
                    if ("RSA".equals(keyTypeStr)) {
                        keyType = PeerConnection.KeyType.RSA;
                    } else if ("ECDSA".equals(keyTypeStr)) {
                        keyType = PeerConnection.KeyType.ECDSA;
                    }
                }

                if (options.hasKey("expires")) {
                    expires = (long) options.getDouble("expires");
                }

                RtcCertificatePem cert = RtcCertificatePem.generateCertificate(keyType, expires);
                String certId = java.util.UUID.randomUUID().toString();
                synchronized (mCertificates) {
                    mCertificates.put(certId, cert);
                }

                WritableMap params = Arguments.createMap();
                params.putString("certificateId", certId);
                // Return expires as millis since epoch
                params.putDouble("expires", System.currentTimeMillis() + expires * 1000);

                // Calculate fingerprints
                WritableArray fingerprints = Arguments.createArray();

                try {
                    CertificateFactory cf = CertificateFactory.getInstance("X.509");
                    ByteArrayInputStream is = new ByteArrayInputStream(cert.certificate.getBytes(StandardCharsets.UTF_8));
                    X509Certificate x509Cert = (X509Certificate) cf.generateCertificate(is);

                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    byte[] hash = digest.digest(x509Cert.getEncoded());

                    WritableMap fingerprint = Arguments.createMap();
                    fingerprint.putString("algorithm", "sha-256");
                    fingerprint.putString("value", bytesToHex(hash));
                    fingerprints.pushMap(fingerprint);
                } catch (Exception e) {
                    Log.e(TAG, "Failed to calculate fingerprint: " + e.getMessage());
                }

                params.putArray("fingerprints", fingerprints);

                promise.resolve(params);
            } catch (Exception e) {
                promise.reject(e);
            }
        });
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
            sb.append(":");
        }
        if (sb.length() > 0) {
            sb.setLength(sb.length() - 1);
        }
        return sb.toString();
    }

    // iOS only, in the spec both platforms share. JS calls them on iOS alone.

    @Override
    public void checkPermission(String mediaType, Promise promise) {
        promise.reject("E_UNSUPPORTED", "checkPermission is iOS only");
    }

    @Override
    public void requestPermission(String mediaType, Promise promise) {
        promise.reject("E_UNSUPPORTED", "requestPermission is iOS only");
    }

    @Override
    public void audioSessionDidActivate() {}

    @Override
    public void audioSessionDidDeactivate() {}
}
