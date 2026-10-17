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

    @PluginMethod
    public void perform(PluginCall call) {
        int constant = constantFor(call.getString("kind", ""));
        getActivity().runOnUiThread(() -> {
            getBridge().getWebView().performHapticFeedback(constant);
            call.resolve();
        });
    }

    private static int constantFor(String kind) {
        // CONFIRM and REJECT arrived in API 30; minSdk is 24.
        boolean api30 = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        switch (kind) {
            case "tap":
                return HapticFeedbackConstants.VIRTUAL_KEY;
            case "hold":
                return HapticFeedbackConstants.LONG_PRESS;
            case "success":
                return api30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
            case "error":
                return api30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
            default:
                return HapticFeedbackConstants.CONTEXT_CLICK;
        }
    }
}
