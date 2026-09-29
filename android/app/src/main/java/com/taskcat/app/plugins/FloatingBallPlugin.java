package com.taskcat.app.plugins;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor 插件：系统级悬浮球。
 * 管理 WindowManager 悬浮窗（猫 emoji），点击时触发语音输入。
 * 权限：SYSTEM_ALERT_WINDOW（悬浮窗）、RECORD_AUDIO（语音识别）。
 */
@CapacitorPlugin(name = "FloatingBall")
public class FloatingBallPlugin extends Plugin {

    private FloatingBallManager floatManager;

    @Override
    public void load() {
        super.load();
        floatManager = new FloatingBallManager(getActivity());
        floatManager.setOnClickCallback(() -> {
            // 通知 JS 层悬浮球被点击
            JSObject ret = new JSObject();
            ret.put("action", "click");
            notifyListeners("click", ret);

            // 如果应用不在前台，启动 Activity
            Intent intent = getActivity().getIntent();
            intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            getActivity().startActivity(intent);
        });
    }

    /** 显示悬浮球（需用户已授权 SYSTEM_ALERT_WINDOW） */
    @PluginMethod
    public void show(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(getContext())) {
                // 未授权 → 跳转设置页引导用户开启
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.reject("SYSTEM_ALERT_WINDOW permission not granted");
                return;
            }
        }
        floatManager.show();
        call.resolve();
    }

    /** 隐藏悬浮球 */
    @PluginMethod
    public void hide(PluginCall call) {
        floatManager.hide();
        call.resolve();
    }

    /** 检查悬浮球是否显示 */
    @PluginMethod
    public void isShowing(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("showing", floatManager.isShowing());
        call.resolve(ret);
    }

    /** 请求悬浮窗权限（跳转系统设置页） */
    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(getContext())) {
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
                return;
            }
        }
        call.resolve();
    }
}