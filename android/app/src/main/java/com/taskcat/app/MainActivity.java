package com.taskcat.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(com.taskcat.app.plugins.FloatingBallPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
