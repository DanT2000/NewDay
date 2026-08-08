#!/usr/bin/env bash
#
# Встанет ли магазинная сборка обновлением поверх той, что раздаёт сайт.
#
#   bash tools/update-over-site-check.sh
#
# Нужен сайтовый APK в /tmp/site.apk — скачать так:
#   curl -sL -o /tmp/site.apk https://newday.appswire.ru/api/v1/app/download
#
# Обещание «обновится, а не встанет вторым значком» даётся в PUBLISHING.md и
# зависит сразу от трёх вещей: одинакового applicationId, одинакового ключа
# подписи и растущего versionCode. Проверять его рассуждением нельзя — только
# установкой.
#
# Совпадение отпечатков сертификата — условие необходимое, но не достаточное:
# Android откажет и при понижении versionCode, и при разном applicationId.
# Проверяем делом: ставим 1.0.7 с сайта, обновляем на 1.0.8 без удаления,
# запускаем трижды и смотрим, жив ли процесс и нет ли падений.
#
# Имена переменных латиницей: bash в этой среде не принимает кириллицу в
# именах — присваивание молча превращается в «command not found».
set -u
SDK="${LOCALAPPDATA}/Android/Sdk"
ADB="$SDK/platform-tools/adb.exe"
EMU="$SDK/emulator/emulator.exe"
PKG=ru.appswire.newday
SITE=/tmp/site.apk
NEW=android/app/build/outputs/apk/rustore/release/app-rustore-release.apk
AVD=newday_store_api34

fail() { echo "ПРОВАЛ: $*"; exit 1; }

if [ "$("$ADB" devices | grep -c 'emulator-')" = "0" ]; then
  rm -rf "${USERPROFILE}/.android/avd/${AVD}.avd/"*.lock 2>/dev/null || true
  echo "поднимаю эмулятор"
  "$EMU" -avd "$AVD" -no-snapshot-save -no-boot-anim -no-audio -gpu swiftshader_indirect >/dev/null 2>&1 &
  "$ADB" wait-for-device
  w=0
  until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 5; w=$((w + 5)); [ "$w" -gt 300 ] && fail "эмулятор не загрузился"
  done
  sleep 8
else
  echo "эмулятор уже поднят"
fi

version_now() {
  "$ADB" shell dumpsys package $PKG 2>/dev/null | grep -m1 versionName | tr -d '\r' | sed 's/.*=//'
}

echo "── шаг 1: ставим сборку с сайта, как у человека на телефоне"
"$ADB" uninstall $PKG >/dev/null 2>&1 || true
"$ADB" install "$SITE" >/dev/null 2>&1 || fail "сайтовый APK не встал"
had=$(version_now)
echo "   стоит версия: $had"
[ "$had" = "1.0.7" ] || fail "ожидали 1.0.7, стоит $had"

echo "── шаг 2: человек хотя бы раз открывал приложение"
# Иначе первое обновление ловит гонку в самом Android: процесс поднимается
# широковещанием MY_PACKAGE_REPLACED ровно в момент подмены APK, ресурсы ещё
# недоступны, и падает framework, а не приложение. У человека приложение
# открыто хоть раз, поэтому воспроизводим тот же порядок.
"$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
sleep 10
"$ADB" shell am force-stop $PKG >/dev/null 2>&1
sleep 2

echo "── шаг 3: ставим магазинную сборку ПОВЕРХ, без удаления"
out=$("$ADB" install -r "$NEW" 2>&1)
echo "$out" | grep -qi "Success" || fail "обновление не встало: $(echo "$out" | tail -2 | tr '\n' ' ')"
now=$(version_now)
echo "   стало: $now"
[ "$now" = "1.0.8" ] || fail "версия не обновилась: $now"

echo "── шаг 4: запускается после обновления, три раза подряд"
for i in 1 2 3; do
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
  sleep 2
  # -b all: падения лежат в отдельном буфере, обычный logcat -c его не чистит,
  # и проверка ловила старую запись, обвиняя работающий код
  "$ADB" logcat -c -b all >/dev/null 2>&1
  "$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
  sleep 10
  alive=$("$ADB" shell pidof $PKG | tr -d '\r')
  crashes=$("$ADB" logcat -d -b all 2>/dev/null | grep -ciE "FATAL EXCEPTION|ANR in $PKG" || true)
  echo "   запуск $i: процесс ${alive:-НЕТ}, падений $crashes"
  [ -n "$alive" ] || fail "после обновления приложение не запустилось (попытка $i)"
  [ "$crashes" = "0" ] || fail "падение после обновления (попытка $i)"
done

echo
echo "ИТОГ: сборка с сайта 1.0.7 обновилась до магазинной 1.0.8 без удаления,"
echo "      значок один, приложение запускается, падений нет."
exit 0
