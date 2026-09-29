package com.taskcat.app.plugins;

import android.app.Activity;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * 系统级悬浮球管理：显示猫 emoji，可拖动，点击触发语音输入。
 * 使用 Android WindowManager 叠加层，可浮于任何应用之上。
 */
public class FloatingBallManager {
    private final WindowManager windowManager;
    private final TextView floatView;
    private WindowManager.LayoutParams params;
    private boolean isShowing = false;
    private Runnable onClickCallback;

    // 拖动起始坐标
    private float initialTouchX, initialTouchY;
    private int initialX, initialY;

    public FloatingBallManager(Activity activity) {
        windowManager = (WindowManager) activity.getSystemService(Activity.WINDOW_SERVICE);

        floatView = new TextView(activity);
        floatView.setText("\uD83D\uDC31"); // 猫 emoji
        floatView.setTextSize(32);
        floatView.setGravity(Gravity.CENTER);
        floatView.setPadding(16, 16, 16, 16);
        // 半透明深色圆形背景
        floatView.setBackgroundColor(0xBB333333);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            floatView.setElevation(12);
            floatView.setOutlineProvider(new android.view.ViewOutlineProvider() {
                @Override
                public void getOutline(View view, android.graphics.Outline outline) {
                    outline.setOval(0, 0, view.getWidth(), view.getHeight());
                }
            });
            floatView.setClipToOutline(true);
        }

        // 触摸事件：拖动 + 点击检测
        floatView.setOnTouchListener((v, event) -> {
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    initialX = params.x;
                    initialY = params.y;
                    initialTouchX = event.getRawX();
                    initialTouchY = event.getRawY();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    params.x = initialX + (int) (event.getRawX() - initialTouchX);
                    params.y = initialY + (int) (event.getRawY() - initialTouchY);
                    windowManager.updateViewLayout(floatView, params);
                    return true;
                case MotionEvent.ACTION_UP: {
                    float dx = event.getRawX() - initialTouchX;
                    float dy = event.getRawY() - initialTouchY;
                    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
                        // 单击
                        if (onClickCallback != null) onClickCallback.run();
                    }
                    return true;
                }
            }
            return false;
        });
    }

    public void show() {
        if (isShowing) return;

        int layoutFlag;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            layoutFlag = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        } else {
            layoutFlag = WindowManager.LayoutParams.TYPE_PHONE;
        }

        params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                layoutFlag,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 100;
        params.y = 200;

        windowManager.addView(floatView, params);
        isShowing = true;
    }

    public void hide() {
        if (!isShowing) return;
        windowManager.removeView(floatView);
        isShowing = false;
    }

    public boolean isShowing() {
        return isShowing;
    }

    public void setOnClickCallback(Runnable callback) {
        this.onClickCallback = callback;
    }
}