package io.cumora.app;

import android.os.Build;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
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
        if ("received".equals(kind)) {
            received();
            call.resolve();
            return;
        }
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

    /**
     * A message arriving is not a touch, so it plays a pattern no touch plays:
     * the phone maker's tuned double click. USAGE_TOUCH keeps it under the same
     * touch-feedback setting as the other kinds. VibrationAttributes arrived in
     * API 33, so older phones play nothing for it.
     */
    private void received() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        getContext().getSystemService(Vibrator.class).vibrate(
            VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK),
            VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH));
    }

    private static Integer constantFor(String kind) {
        // GESTURE_START, CONFIRM and REJECT arrived in API 30; minSdk is 24.
        boolean api30 = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        switch (kind) {
            // One UI plays its key-press click for GESTURE_START.
            case "press":
                return api30 ? HapticFeedbackConstants.GESTURE_START : HapticFeedbackConstants.VIRTUAL_KEY;
            case "hold":
                return HapticFeedbackConstants.LONG_PRESS;
            case "sent":
            case "success":
                return api30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
            case "error":
                return api30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
            default:
                return null;
        }
    }
}
