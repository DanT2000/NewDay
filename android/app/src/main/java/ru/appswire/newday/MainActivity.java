package ru.appswire.newday;

import android.os.Bundle;

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
    }
}
