package ru.appswire.newday;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import ru.appswire.newday.alarm.AlarmPlugin;
import ru.appswire.newday.alarm.AlarmService;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Плагин регистрируется до super: иначе мост его не увидит
        registerPlugin(AlarmPlugin.class);
        super.onCreate(savedInstanceState);
        AlarmService.Companion.createChannels(this);

        /*
         * Отладка WebView — только в отладочной сборке.
         *
         * Она открывает содержимое страницы любому, кто может выполнить adb
         * на этом телефоне, а там в localStorage лежит токен устройства —
         * то есть полный доступ к дням человека. Нужна она только тестам,
         * поэтому в релизе выключена.
         */
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    }
}
