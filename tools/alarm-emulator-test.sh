#!/usr/bin/env bash
#
# Сценарии, в которых будильник обязан сработать.
#   bash tools/alarm-emulator-test.sh [--with-reboot]
#
# Требуется запущенный эмулятор или подключённый телефон и установленный APK.
# Проверка идёт по факту: появился ли на экране AlarmActivity.
#
# Про force-stop: принудительно остановленному приложению Android по своему
# дизайну не доставляет будильники, пока его не запустят снова. Так ведёт себя
# и штатный будильник Google, обойти это нельзя. Поэтому «убитое приложение»
# проверяется через `am kill` — это соответствует смахиванию из недавних
# и убийству по нехватке памяти.

set -u
ADB="${LOCALAPPDATA}/Android/Sdk/platform-tools/adb.exe"
PKG=ru.appswire.newday
WITH_REBOOT=0
[ "${1:-}" = "--with-reboot" ] && WITH_REBOOT=1

PASS=0
FAIL=0

# «Поверх других приложений» — без него система блокирует поднятие экрана
# будильника из фона на разблокированном телефоне. На устройстве это
# разрешение выдаёт человек в экране проверки будильника.
"$ADB" shell appops set $PKG SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1

restart() {
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
  "$ADB" shell am start -n $PKG/.MainActivity >/dev/null 2>&1
  sleep 6
}

# fire <delaySec> — ставит тестовый будильник через настоящий плагин
fire() {
  local pid
  pid=$("$ADB" shell pidof $PKG | tr -d '\r')
  "$ADB" forward --remove-all >/dev/null 2>&1
  "$ADB" forward tcp:9222 localabstract:webview_devtools_remote_"$pid" >/dev/null 2>&1
  sleep 1
  node tools/webview-eval.js \
    "Capacitor.Plugins.NewDayAlarm.testAlarm({ delaySec: $1, profile: 'gentle' })" >/dev/null 2>&1
}

# await <секунд> <название> — ждёт появления экрана будильника.
# Ожидание вместо фиксированной паузы: время перезагрузки эмулятора и
# задержки планировщика непредсказуемы, а фиксированный sleep давал
# ложные провалы там, где механизм работал.
await_alarm() {
  local deadline=$1 name=$2 waited=0
  while [ "$waited" -lt "$deadline" ]; do
    if "$ADB" shell dumpsys activity activities 2>/dev/null | grep -q "AlarmActivity"; then
      echo "  + $name (через ${waited} с)"
      PASS=$((PASS + 1))
      "$ADB" shell am force-stop $PKG >/dev/null 2>&1
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  echo "  - $name  ПРОВАЛ (ждали ${deadline} с)"
  FAIL=$((FAIL + 1))
  "$ADB" logcat -d -s NewDayAlarm 2>&1 | tail -4 | sed 's/^/      /'
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
  return 1
}

echo "== 1. Заблокированный экран =="
restart; fire 10
"$ADB" shell input keyevent KEYCODE_SLEEP
await_alarm 45 "экран погашен и заблокирован"

echo "== 2. Беззвучный режим =="
restart
"$ADB" shell cmd notification set_dnd off >/dev/null 2>&1
"$ADB" shell media volume --stream 2 --set 0 >/dev/null 2>&1
fire 10
"$ADB" shell input keyevent KEYCODE_SLEEP
await_alarm 45 "беззвучный режим"

echo "== 3. Не беспокоить =="
restart
"$ADB" shell cmd notification set_dnd on >/dev/null 2>&1
fire 10
"$ADB" shell input keyevent KEYCODE_SLEEP
await_alarm 45 "режим Не беспокоить"
"$ADB" shell cmd notification set_dnd off >/dev/null 2>&1

echo "== 4. Глубокий сон системы (Doze) =="
restart; fire 14
"$ADB" shell input keyevent KEYCODE_SLEEP
"$ADB" shell dumpsys battery unplug >/dev/null 2>&1
"$ADB" shell dumpsys deviceidle force-idle >/dev/null 2>&1
await_alarm 45 "Doze"
"$ADB" shell dumpsys deviceidle unforce >/dev/null 2>&1
"$ADB" shell dumpsys battery reset >/dev/null 2>&1

echo "== 5. Процесс убит (смахнули из недавних) =="
restart; fire 16
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
await_alarm 45 "процесс убит"

echo "== 6. Без сети =="
restart
"$ADB" shell svc wifi disable >/dev/null 2>&1
"$ADB" shell svc data disable >/dev/null 2>&1
fire 10
"$ADB" shell input keyevent KEYCODE_SLEEP
await_alarm 45 "сети нет"
"$ADB" shell svc wifi enable >/dev/null 2>&1
"$ADB" shell svc data enable >/dev/null 2>&1

if [ "$WITH_REBOOT" = "1" ]; then
  echo "== 7. Перезагрузка устройства =="
  restart; fire 150          # запас на перезагрузку эмулятора
  "$ADB" reboot
  "$ADB" wait-for-device
  until [ "$("$ADB" shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 3; done
  await_alarm 240 "будильник пережил перезагрузку"
fi

echo
echo "Итог: успешно $PASS, провалено $FAIL"
[ "$FAIL" -eq 0 ]
