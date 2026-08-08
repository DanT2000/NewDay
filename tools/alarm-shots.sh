#!/usr/bin/env bash
#
# Снимки экрана будильника во всех его состояниях.
#   bash tools/alarm-shots.sh [--api 34]
#
# Экран будильника нельзя посмотреть иначе, чем дождавшись звонка: он живёт
# поверх локскрина, и открыть его «просто так» нечем. Поэтому здесь эмулятор,
# настоящий плагин и снимок каждого состояния — иначе о том, как это выглядит,
# приходится судить по описанию.

set -u

# Временные файлы — в .tmp проекта, с уборкой на выходе
. "$(dirname "$0")/lib/tmp.sh"
SDK="${LOCALAPPDATA}/Android/Sdk"
ADB="$SDK/platform-tools/adb.exe"
EMU="$SDK/emulator/emulator.exe"
AVDMAN="$SDK/cmdline-tools/latest/bin/avdmanager.bat"
# Одно имя и для пакета кода, и для магазина, поэтому активность зовётся
# ru.appswire.newday.MainActivity
PKG=${NEWDAY_PKG:-ru.appswire.newday}
# Сборок стало две: для магазина Play (без самообновления) и для RuStore
# с сайтом. Проверяем ту, что достаётся людям с сайта.
APK=${NEWDAY_APK:-android/app/build/outputs/apk/rustore/release/app-rustore-release.apk}
OUT=tools/.shots
API=34
while [ $# -gt 0 ]; do
  case "$1" in --api) shift; API="$1" ;; esac
  shift
done
mkdir -p "$OUT"

avd="newday_api${API}"
"$ADB" emu kill >/dev/null 2>&1; sleep 3
taskkill //F //IM qemu-system-x86_64.exe >/dev/null 2>&1 || true
sleep 2

if ! "$AVDMAN" list avd 2>/dev/null | grep -q "Name: $avd"; then
  echo no | "$AVDMAN" create avd -n "$avd" \
    -k "system-images;android-${API};google_apis;x86_64" -d pixel_6 --force >/dev/null 2>&1
fi

# Камера — виртуальная сцена, не «none»: без неё hasCamera() честно отвечает
# «камеры нет», задача QR ещё до показа становится примером, и снимок
# видоискателя снять не с чего. Замки от убитых прогонов — тоже здесь.
AVD_DIR="${USERPROFILE}/.android/avd/${avd}.avd"
if [ -f "$AVD_DIR/config.ini" ]; then
  sed -i 's/^hw.camera.back=.*/hw.camera.back=virtualscene/' "$AVD_DIR/config.ini"
  grep -q '^hw.camera.back=' "$AVD_DIR/config.ini" || echo 'hw.camera.back=virtualscene' >> "$AVD_DIR/config.ini"
fi
rm -rf "$AVD_DIR/hardware-qemu.ini.lock" "$AVD_DIR/multiinstance.lock" \
       "$AVD_DIR/userdata-qemu.img.lock" "$AVD_DIR/snapshot.lock" 2>/dev/null || true

echo "поднимаю эмулятор"
"$EMU" -avd "$avd" -no-snapshot-save -no-boot-anim -no-audio -gpu swiftshader_indirect >/dev/null 2>&1 &
"$ADB" wait-for-device
waited=0
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 5; waited=$((waited + 5))
  [ "$waited" -gt 300 ] && { echo "эмулятор не загрузился"; exit 1; }
done
sleep 8

# Самая частая причина отказа — прошлая сборка на эмуляторе подписана другим
# ключом: обновление поверх неё Android запрещает. Сносим и ставим заново.
if ! "$ADB" install -r -g "$APK" >/dev/null 2>&1; then
  "$ADB" uninstall $PKG >/dev/null 2>&1
  "$ADB" install -g "$APK" >/dev/null 2>&1 || { echo "APK не встал"; exit 1; }
fi
"$ADB" shell appops set $PKG SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1
"$ADB" shell appops set $PKG SCHEDULE_EXACT_ALARM allow >/dev/null 2>&1

cdp() {
  local pid
  pid=$("$ADB" shell pidof $PKG | tr -d '\r')
  "$ADB" forward --remove-all >/dev/null 2>&1
  "$ADB" forward tcp:9222 localabstract:webview_devtools_remote_"$pid" >/dev/null 2>&1
  sleep 1
}

start_app() {
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
  "$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
  sleep 6
  local w=0
  while [ "$w" -lt 20 ]; do
    "$ADB" logcat -d -s NewDayAlarm 2>&1 | grep -q "SYNCED" && break
    sleep 2; w=$((w + 2))
  done
}

# setup <json настроек> — задаёт конфигурацию отключения через плагин
setup() {
  cdp
  node tools/webview-eval.js "Capacitor.Plugins.NewDayAlarm.setConfig({ config: $1 }).then(r => 'ok')" >/dev/null 2>&1
}

fire() {
  cdp
  node tools/webview-eval.js \
    "Capacitor.Plugins.NewDayAlarm.testAlarm({ delaySec: ${1:-8}, profile: '${2:-wakeup}' })" >/dev/null 2>&1
}

await_screen() {
  local w=0
  while [ "$w" -lt 60 ]; do
    "$ADB" shell dumpsys activity activities 2>/dev/null | grep -q "AlarmActivity" && { sleep 2; return 0; }
    sleep 2; w=$((w + 2))
  done
  return 1
}

shot() {
  MSYS_NO_PATHCONV=1 "$ADB" shell screencap -p /sdcard/shot.png >/dev/null 2>&1
  MSYS_NO_PATHCONV=1 "$ADB" pull /sdcard/shot.png "$(cygpath -w "$OUT/$1.png")" >/dev/null 2>&1
  echo "  снимок: $1"
}

# нажать по тексту на экране
tap_text() {
  local ui bounds nums
  ui=$(nd_tmpfile newday-shotui)
  MSYS_NO_PATHCONV=1 "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  MSYS_NO_PATHCONV=1 "$ADB" pull /sdcard/ui.xml "$(cygpath -w "$ui")" >/dev/null 2>&1
  bounds=$(tr '>' '\n' < "$ui" | LC_ALL=C grep -aF "text=\"$1\"" \
    | LC_ALL=C grep -ao 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -1)
  [ -z "$bounds" ] && return 1
  nums=$(echo "$bounds" | grep -o '[0-9]*' | tr '\n' ' ')
  # shellcheck disable=SC2086
  set -- $nums
  "$ADB" shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 )) >/dev/null 2>&1
}

case_shot() {
  local name=$1 cfg=$2 label=$3
  echo "== $label"
  start_app
  setup "$cfg"
  "$ADB" logcat -c >/dev/null 2>&1
  fire 8 wakeup
  "$ADB" shell input keyevent KEYCODE_SLEEP >/dev/null 2>&1
  if await_screen; then
    shot "$name"
  else
    echo "  экран не поднялся"
  fi
}

BASE="types: ['math'], count: 1, timeoutSec: 60, snoozeAllowed: false, volumeRamp: false"

# 1. Мягкое начало: можно просто выключить
case_shot alarm-grace \
  "{ $BASE, difficulty: 1, graceEnabled: true, graceSec: 300 }" \
  "Мягкое начало — можно просто выключить"

# 2..4. Математика трёх уровней
for lvl in 1 2 3; do
  case_shot "alarm-math-$lvl" \
    "{ $BASE, difficulty: $lvl, graceEnabled: false }" \
    "Математика, уровень $lvl"
done

# 5. Неверный ответ: поле краснеет
echo "== Неверный ответ"
start_app
setup "{ $BASE, difficulty: 1, graceEnabled: false }"
fire 8 wakeup
"$ADB" shell input keyevent KEYCODE_SLEEP >/dev/null 2>&1
if await_screen; then
  # набираем заведомо чужое число и жмём OK
  tap_text "9"; tap_text "9"; tap_text "9"; tap_text "OK"
  sleep 1
  shot alarm-math-wrong
fi

# 6. Код
case_shot alarm-code \
  "{ types: ['code'], count: 1, difficulty: 2, timeoutSec: 60, snoozeAllowed: false, volumeRamp: false, graceEnabled: false }" \
  "Код"

# 7. Значки
case_shot alarm-icons \
  "{ types: ['icons'], count: 1, difficulty: 2, timeoutSec: 60, snoozeAllowed: false, volumeRamp: false, graceEnabled: false }" \
  "Значки"

# 8. Мягкий профиль: две задачи не даёт, зато есть «отложить»
echo "== Мягкий профиль с «отложить»"
start_app
setup "{ $BASE, difficulty: 1, graceEnabled: false, snoozeAllowed: true, snoozeMinutes: 5 }"
fire 8 gentle
"$ADB" shell input keyevent KEYCODE_SLEEP >/dev/null 2>&1
if await_screen; then shot alarm-gentle; fi

# 9. QR: видоискатель поверх виртуальной сцены эмулятора.
# Код ставится через setConfig с явным ключом qrValue — путь мимо камеры,
# оставленный ровно для таких прогонов.
case_shot alarm-qr \
  "{ types: ['qr'], count: 1, timeoutSec: 60, snoozeAllowed: false, volumeRamp: false, graceEnabled: false, qrValue: 'проверка', qrLabel: 'на чайнике', rescueAfterSec: 300 }" \
  "QR-код"

# 10. QR с кнопкой аварийного выхода: ждём, пока она появится
echo "== QR: аварийный выход через 30 с"
start_app
setup "{ types: ['qr'], count: 1, timeoutSec: 60, snoozeAllowed: false, volumeRamp: false, graceEnabled: false, qrValue: 'проверка', qrLabel: 'на чайнике', rescueAfterSec: 30 }"
"$ADB" logcat -c >/dev/null 2>&1
fire 8 wakeup
"$ADB" shell input keyevent KEYCODE_SLEEP >/dev/null 2>&1
if await_screen; then
  sleep 34
  shot alarm-qr-rescue
fi

# 11. Шаги. На эмуляторе шагомера обычно нет, и это тоже показательно:
# экран должен объяснить причину и сам увести на пример, а не зависнуть.
case_shot alarm-steps \
  "{ types: ['steps'], count: 1, timeoutSec: 60, snoozeAllowed: false, volumeRamp: false, graceEnabled: false, stepsTarget: 20 }" \
  "Шаги"

"$ADB" shell am force-stop $PKG >/dev/null 2>&1
echo
echo "Снимки в $OUT"
"$ADB" emu kill >/dev/null 2>&1
sleep 3
taskkill //F //IM qemu-system-x86_64.exe >/dev/null 2>&1 || true
