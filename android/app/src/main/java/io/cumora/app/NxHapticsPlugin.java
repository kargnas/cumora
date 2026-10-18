package io.cumora.app;

import android.os.Build;
import android.view.HapticFeedbackConstants;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Haptics for the redesigned UI (src/next/haptics.ts). @capacitor/haptics
 * plays fixed 40-100 ms vibration waveforms on Android, which feel like a
 * buzz next to the system's own clicks. View.performHapticFeedback plays the
 * effects the phone maker tuned for each meaning, and it follows the user's
 * "touch feedback" setting.
 */
@CapacitorPlugin(name = "NxHaptics")
public class NxHapticsPlugin extends Plugin {

    @Override
    public void load() {
        // Chromium plays LONG_PRESS on the WebView whenever the page handles a
        // long press (GestureListenerManagerImpl.onEventAck), which doubled the
        // app's own `hold`, and TEXT_HANDLE_MOVE while a selection handle is
        // dragged. With the view's setting off only calls that pass
        // FLAG_IGNORE_VIEW_SETTING play, so every haptic comes from the app.
        getBridge().getWebView().setHapticFeedbackEnabled(false);
    }

    @PluginMethod
    public void perform(PluginCall call) {
        String kind = call.getString("kind", "");
        Integer constant = constantFor(kind);
        if (constant == null) {
            call.reject("Unknown haptic kind: " + kind);
            return;
        }
        getActivity().runOnUiThread(() -> {
            getBridge().getWebView().performHapticFeedback(constant, HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
            call.resolve();
        });
    }

    private static Integer constantFor(String kind) {
        // GESTURE_START/END, CONFIRM and REJECT arrived in API 30; minSdk is 24.
        boolean api30 = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        switch (kind) {
            // A button going down and coming back up. One UI plays its
            // key-press click for GESTURE_START and its lighter key-release
            // tick for GESTURE_END.
            case "press":
                return api30 ? HapticFeedbackConstants.GESTURE_START : HapticFeedbackConstants.VIRTUAL_KEY;
            case "release":
                return api30 ? HapticFeedbackConstants.GESTURE_END : HapticFeedbackConstants.CLOCK_TICK;
            case "hold":
                return HapticFeedbackConstants.LONG_PRESS;
            case "success":
                return api30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
            case "error":
                return api30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
            default:
                return null;
        }
    }
}
