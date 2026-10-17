package io.cumora.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in the app module are registered by hand, before
        // the bridge starts.
        registerPlugin(NxHapticsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
