package ru.appswire.newday;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import ru.appswire.newday.alarm.AlarmPlugin;
import ru.appswire.newday.alarm.AlarmService;
import ru.appswire.newday.update.UpdatePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Плагины регистрируются до super: иначе мост их не увидит
        registerPlugin(AlarmPlugin.class);
        registerPlugin(UpdatePlugin.class);
        super.onCreate(savedInstanceState);
        AlarmService.Companion.createChannels(this);

        /*
         * Отладка WebView — только в отладочной сборке.
         *
         * Она открывает содержимое страницы любому, кто может выполнить adb
         * на этом телефоне, а там в localStorage лежит токен устройства —
         * то есть полный доступ к дням человека. Нужна она только живым тестам
         * будильника, поэтому в релизе выключена.
         *
         * Признак берём из флага пакета, а не из BuildConfig: он не требует
         * включать генерацию BuildConfig и означает ровно то же самое.
         */
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
    }
}
