package ru.appswire.newday;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

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

        /*
         * «Назад» отдаём странице, а не системе.
         *
         * Свайп назад закрывал приложение с любого экрана: открыл настройки,
         * провёл от края — и оказался на рабочем столе, вместо возврата на
         * «Сейчас». Причин две, и работают они вместе.
         *
         * Capacitor 6 своего обработчика «назад» не ставит вообще — он ждёт
         * плагина @capacitor/app, которого у нас нет. А с targetSdk 36 на
         * Android 13 и новее система больше не звонит в устаревший
         * onBackPressed: она спрашивает зарегистрированный обработчик, и если
         * его нет — просто закрывает активность. Историю страницы при этом
         * никто не смотрит, поэтому страховочная запись в ней не спасала.
         *
         * Через OnBackPressedDispatcher, а не через OnBackInvokedCallback
         * напрямую: androidx сама выбирает нужный путь по версии Android, и
         * жеста с предпросмотром это тоже касается.
         */
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView view = getBridge() != null ? getBridge().getWebView() : null;
                if (view != null && view.canGoBack()) {
                    // страница сама решит, что значит «назад»: закрыть шторку
                    // или вернуться на «Сейчас» — она одна знает, где человек
                    view.goBack();
                    return;
                }
                /*
                 * Возвращать некуда — уходим с экрана, но приложение не
                 * убиваем: finish() выбросил бы процесс, а с ним и вебвью,
                 * и следующее открытие грузило бы страницу заново, с нуля.
                 */
                moveTaskToBack(true);
            }
        });
    }
}
