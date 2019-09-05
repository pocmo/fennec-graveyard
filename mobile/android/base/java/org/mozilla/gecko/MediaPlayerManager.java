/* -*- Mode: Java; c-basic-offset: 4; tab-width: 4; indent-tabs-mode: nil; -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko;

import android.os.Bundle;
import android.support.v4.app.Fragment;
import android.support.v7.media.MediaControlIntent;
import android.support.v7.media.MediaRouteSelector;
import android.support.v7.media.MediaRouter;
import android.support.v7.media.MediaRouter.RouteInfo;
import android.util.Log;

import com.google.android.gms.cast.CastMediaControlIntent;

import org.json.JSONObject;
import org.mozilla.gecko.annotation.ReflectionTarget;
import org.mozilla.gecko.AppConstants.Versions;
import org.mozilla.gecko.util.BundleEventListener;
import org.mozilla.gecko.util.EventCallback;
import org.mozilla.gecko.util.GeckoBundle;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Manages a list of GeckoMediaPlayers methods (i.e. Chromecast/Miracast). Routes messages
 * from Gecko to the correct caster based on the id of the display
 */
public class MediaPlayerManager extends Fragment implements BundleEventListener {
    /**
     * Create a new instance of DetailsFragment, initialized to
     * show the text at 'index'.
     */

    private static MediaPlayerManager instance = null;

    @ReflectionTarget
    public static MediaPlayerManager getInstance() {
        if (instance != null) {
            return instance;
        }
        return new MediaPlayerManager();
    }

    private static final String LOGTAG = "GeckoMediaPlayerManager";
    protected boolean isPresentationMode = false; // Used to prevent mirroring when Presentation API is used.

    @ReflectionTarget
    public static final String MEDIA_PLAYER_TAG = "MPManagerFragment";

    private static final boolean SHOW_DEBUG = false;
    // Simplified debugging interfaces
    private static void debug(String msg, Exception e) {
        if (SHOW_DEBUG) {
            Log.e(LOGTAG, msg, e);
        }
    }

    private static void debug(String msg) {
        if (SHOW_DEBUG) {
            Log.d(LOGTAG, msg);
        }
    }

    protected MediaRouter mediaRouter = null;
    protected final Map<String, GeckoMediaPlayer> players = new HashMap<String, GeckoMediaPlayer>();
    protected final Map<String, GeckoPresentationDisplay> displays = new HashMap<String, GeckoPresentationDisplay>(); // used for Presentation API

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        EventDispatcher.getInstance().registerGeckoThreadListener(this,
                                                                  "MediaPlayer:Load",
                                                                  "MediaPlayer:Start",
                                                                  "MediaPlayer:Stop",
                                                                  "MediaPlayer:Play",
                                                                  "MediaPlayer:Pause",
                                                                  "MediaPlayer:End",
                                                                  "MediaPlayer:Message",
                                                                  "AndroidCastDevice:Start",
                                                                  "AndroidCastDevice:Stop",
                                                                  "AndroidCastDevice:SyncDevice");
    }

    @Override
    public void onDestroy() {
        EventDispatcher.getInstance().unregisterGeckoThreadListener(this,
                                                                    "MediaPlayer:Load",
                                                                    "MediaPlayer:Start",
                                                                    "MediaPlayer:Stop",
                                                                    "MediaPlayer:Play",
                                                                    "MediaPlayer:Pause",
                                                                    "MediaPlayer:End",
                                                                    "MediaPlayer:Message",
                                                                    "AndroidCastDevice:Start",
                                                                    "AndroidCastDevice:Stop",
                                                                    "AndroidCastDevice:SyncDevice");

        super.onDestroy();
    }

    // BundleEventListener implementation
    @Override
    public void handleMessage(final String event, final GeckoBundle message,
                              final EventCallback callback) {
        debug(event);
        if (event.startsWith("MediaPlayer:")) {
            final GeckoMediaPlayer player = players.get(message.getString("id"));
            if (player == null) {
                Log.e(LOGTAG, "Couldn't find a player for this id: " + message.getString("id") + " for message: " + event);
                if (callback != null) {
                    callback.sendError(null);
                }
                return;
            }

            if ("MediaPlayer:Play".equals(event)) {
                player.play(callback);
            } else if ("MediaPlayer:Start".equals(event)) {
                player.start(callback);
            } else if ("MediaPlayer:Stop".equals(event)) {
                player.stop(callback);
            } else if ("MediaPlayer:Pause".equals(event)) {
                player.pause(callback);
            } else if ("MediaPlayer:End".equals(event)) {
                player.end(callback);
            } else if ("MediaPlayer:Message".equals(event) && message.containsKey("data")) {
                player.message(message.getString("data"), callback);
            } else if ("MediaPlayer:Load".equals(event)) {
                final String url = message.getString("source", "");
                final String type = message.getString("type", "video/mp4");
                final String title = message.getString("title", "");
                player.load(title, url, type, callback);
            }
        }

        if (event.startsWith("AndroidCastDevice:")) {
            if ("AndroidCastDevice:Start".equals(event)) {
                final GeckoPresentationDisplay display = displays.get(message.getString("id"));
                if (display == null) {
                    Log.e(LOGTAG, "Couldn't find a display for this id: " + message.getString("id") + " for message: " + event);
                    return;
                }
                display.start(callback);
            } else if ("AndroidCastDevice:Stop".equals(event)) {
                final GeckoPresentationDisplay display = displays.get(message.getString("id"));
                if (display == null) {
                    Log.e(LOGTAG, "Couldn't find a display for this id: " + message.getString("id") + " for message: " + event);
                    return;
                }
                display.stop(callback);
            } else if ("AndroidCastDevice:SyncDevice".equals(event)) {
                for (Map.Entry<String, GeckoPresentationDisplay> entry : displays.entrySet()) {
                    GeckoPresentationDisplay display = entry.getValue();
                    final GeckoBundle data = display.toBundle();
                    if (data == null) {
                        break;
                    }
                    EventDispatcher.getInstance().dispatch("AndroidCastDevice:Added", data);
                }
            }
        }
    }

    private final MediaRouter.Callback callback =
        new MediaRouter.Callback() {
            @Override
            public void onRouteRemoved(MediaRouter router, RouteInfo route) {
                debug("onRouteRemoved: route=" + route);

                // Remove from media player list.
                players.remove(route.getId());

                final GeckoBundle data = new GeckoBundle(1);
                data.putString("id", route.getId());
                EventDispatcher.getInstance().dispatch("MediaPlayer:Removed", data);
                updatePresentation();

                // Remove from presentation display list.
                if (displays.remove(route.getId()) != null) {
                    EventDispatcher.getInstance().dispatch("AndroidCastDevice:Removed", data);
                }
            }

            @Override
            public void onRouteSelected(MediaRouter router, MediaRouter.RouteInfo route) {
                updatePresentation();
            }

            @Override
            public void onRouteUnselected(MediaRouter router, MediaRouter.RouteInfo route) {
                updatePresentation();
            }

            @Override
            public void onRoutePresentationDisplayChanged(MediaRouter router, RouteInfo route) {
                updatePresentation();
            }

            @Override
            public void onRouteVolumeChanged(MediaRouter router, RouteInfo route) {
            }

            @Override
            public void onRouteAdded(MediaRouter router, MediaRouter.RouteInfo route) {
                debug("onRouteAdded: route=" + route);
                final GeckoMediaPlayer player = getMediaPlayerForRoute(route);
                saveAndNotifyOfPlayer("MediaPlayer:Added", route, player);
                updatePresentation();

                final GeckoPresentationDisplay display = getPresentationDisplayForRoute(route);
                saveAndNotifyOfDisplay("AndroidCastDevice:Added", route, display);
            }

            @Override
            public void onRouteChanged(MediaRouter router, MediaRouter.RouteInfo route) {
                debug("onRouteChanged: route=" + route);
                final GeckoMediaPlayer player = players.get(route.getId());
                saveAndNotifyOfPlayer("MediaPlayer:Changed", route, player);
                updatePresentation();

                // onRouteAdded might not be called in some devices.
                final GeckoPresentationDisplay display = getPresentationDisplayForRoute(route);
                saveAndNotifyOfDisplay("AndroidCastDevice:Changed", route, display);
            }

            private void saveAndNotifyOfPlayer(final String eventName,
                                               MediaRouter.RouteInfo route,
                                               final GeckoMediaPlayer player) {
                if (player == null) {
                    return;
                }

                final GeckoBundle data = player.toBundle();
                if (data == null) {
                    return;
                }

                players.put(route.getId(), player);
                EventDispatcher.getInstance().dispatch(eventName, data);
            }

            private void saveAndNotifyOfDisplay(final String eventName,
                                                MediaRouter.RouteInfo route,
                                                final GeckoPresentationDisplay display) {
                if (display == null) {
                    return;
                }

                final GeckoBundle data = display.toBundle();
                if (data == null) {
                    return;
                }

                displays.put(route.getId(), display);
                EventDispatcher.getInstance().dispatch(eventName, data);
            }
        };

    private GeckoMediaPlayer getMediaPlayerForRoute(MediaRouter.RouteInfo route) {
        try {
            if (route.supportsControlCategory(MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)) {
                return new ChromeCastPlayer(getActivity(), route);
            }
        } catch (Exception ex) {
            debug("Error handling presentation", ex);
        }

        return null;
    }

    private GeckoPresentationDisplay getPresentationDisplayForRoute(MediaRouter.RouteInfo route) {
        try {
            if (route.supportsControlCategory(CastMediaControlIntent.categoryForCast(ChromeCastDisplay.REMOTE_DISPLAY_APP_ID))) {
                return new ChromeCastDisplay(getActivity(), route);
            }
        } catch (Exception ex) {
            debug("Error handling presentation", ex);
        }
        return null;
    }

    @Override
    public void onPause() {
        super.onPause();
        mediaRouter.removeCallback(callback);
        mediaRouter = null;
    }

    @Override
    public void onResume() {
        super.onResume();

        // The mediaRouter shouldn't exist here, but this is a nice safety check.
        if (mediaRouter != null) {
            return;
        }

        mediaRouter = MediaRouter.getInstance(getActivity());
        final MediaRouteSelector selectorBuilder = new MediaRouteSelector.Builder()
            .addControlCategory(MediaControlIntent.CATEGORY_LIVE_VIDEO)
            .addControlCategory(MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)
            .addControlCategory(CastMediaControlIntent.categoryForCast(ChromeCastPlayer.MIRROR_RECEIVER_APP_ID))
            .addControlCategory(CastMediaControlIntent.categoryForCast(ChromeCastDisplay.REMOTE_DISPLAY_APP_ID))
            .build();
        mediaRouter.addCallback(selectorBuilder, callback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY);
    }

    public void setPresentationMode(boolean isPresentationMode) {
        this.isPresentationMode = isPresentationMode;
    }

    protected void updatePresentation() { /* Overridden in sub-classes. */ }
}
