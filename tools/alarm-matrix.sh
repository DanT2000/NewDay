#!/usr/bin/env bash
#
# Матрица будильника по версиям Android.
#   bash tools/alarm-matrix.sh [--api 32,33,34,35,36] [--with-reboot] [--keep]
#
# Зачем отдельная обёртка: одно устройство ничего не доказывает. Правила про
# точные будильники, полноэкранные уведомления и фоновые службы Google меняет
# почти каждый год, и «работает у меня на 16-м» ничего не говорит о телефоне
# трёхлетней давности. Поэтому один и тот же прогон гоняется по нескольким
# версиям, а итог сводится в таблицу: видно, где именно отвалилось.
#
# Версии по умолчанию — от Android 12L (телефоны 2022 года, они ещё в ходу)
# до самой свежей. Ниже 12 не спускаемся: там ещё нет ни SCHEDULE_EXACT_ALARM,
# ни нынешних правил Doze, и проверять на них — проверять другую систему.
#
# Каждая версия получает чистый AVD: остатки прошлого прогона (выданные
# разрешения, включённый «Не беспокоить», убитое приложение) сделали бы
# следующий прогон недостоверным.

set -u

SDK="${LOCALAPPDATA}/Android/Sdk"
ADB="$SDK/platform-tools/adb.exe"
EMU="$SDK/emulator/emulator.exe"
AVDMAN="$SDK/cmdline-tools/latest/bin/avdmanager.bat"
SDKMAN="$SDK/cmdline-tools/latest/bin/sdkmanager.bat"
PKG=ru.appswire.newday
APK=android/app/build/outputs/apk/release/app-release.apk

APIS="32,33,34,35,36"
WITH_REBOOT=""
KEEP=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --api) shift; APIS="$1" ;;
    --with-reboot) WITH_REBOOT="--with-reboot" ;;
    --keep) KEEP=1 ;;                      # не удалять AVD после прогона
    --only) shift; ONLY="--only $1" ;;
  esac
  shift
done

# Как называется версия: в отчёте «Android 13», а не «api 33» — так понятнее.
name_of() {
  case "$1" in
    31) echo "Android 12" ;;
    32) echo "Android 12L" ;;
    33) echo "Android 13" ;;
    34) echo "Android 14" ;;
    35) echo "Android 15" ;;
    36) echo "Android 16" ;;
    *) echo "API $1" ;;
  esac
}

if [ ! -f "$APK" ]; then
  echo "Нет собранного APK: $APK"
  echo "Соберите: cd android && ./gradlew assembleRelease"
  exit 1
fi

# Итоги складываем по мере прогона: если что-то упадёт на середине, уже
# пройденное не потеряется.
REPORT=$(mktemp -t newday-matrix-XXXXXX)
echo "версия|успешно|провалено|итог" > "$REPORT"

boot_emulator() {
  local avd=$1 waited=0
  "$EMU" -avd "$avd" -no-snapshot-save -no-boot-anim -no-audio -gpu swiftshader_indirect -dns-server 8.8.8.8,1.1.1.1 \
    >/dev/null 2>&1 &
  "$ADB" wait-for-device
  while [ "$waited" -lt 300 ]; do
    if [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      # Ещё немного: сразу после boot_completed система продолжает
      # разворачиваться, и установка APK в этот момент часто отваливается.
      sleep 8
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

# Гасим всё, что осталось от прошлого прогона.
stop_emulator() {
  # `adb emu kill` гасит только тот, к которому подключён adb. Сценарий с
  # выключением телефона поднимает эмулятор сам, и после него их бывает два:
  # следующая версия видела «more than one device» и не запускалась вовсе.
  "$ADB" emu kill >/dev/null 2>&1
  sleep 3
  taskkill //F //IM qemu-system-x86_64.exe >/dev/null 2>&1 || true
  taskkill //F //IM emulator.exe >/dev/null 2>&1 || true
  sleep 2
  # adb помнит устройства, которых уже нет: перезапуск сервера чистит список
  "$ADB" kill-server >/dev/null 2>&1
  sleep 1
  "$ADB" start-server >/dev/null 2>&1
  local waited=0
  while [ "$waited" -lt 40 ]; do
    [ -z "$("$ADB" devices | grep 'emulator-')" ] && return 0
    sleep 2
    waited=$((waited + 2))
  done
  echo "  предупреждение: эмулятор всё ещё в списке устройств"
}

IFS=',' read -ra LIST <<< "$APIS"
for api in "${LIST[@]}"; do
  human=$(name_of "$api")
  echo
  echo "████ $human (api $api)"

  img="system-images;android-${api};google_apis;x86_64"
  if [ ! -d "$SDK/system-images/android-${api}/google_apis/x86_64" ]; then
    echo "  образа нет, ставлю $img"
    "$SDKMAN" "$img" >/dev/null 2>&1
  fi
  if [ ! -d "$SDK/system-images/android-${api}/google_apis/x86_64" ]; then
    echo "  ПРОПУСК: образ не установился"
    echo "$human|—|—|образа нет" >> "$REPORT"
    continue
  fi

  avd="newday_api${api}"
  stop_emulator
  if [ "$KEEP" = "0" ]; then
    echo no | "$AVDMAN" delete avd -n "$avd" >/dev/null 2>&1
  fi
  if ! "$AVDMAN" list avd 2>/dev/null | grep -q "Name: $avd"; then
    echo no | "$AVDMAN" create avd -n "$avd" -k "$img" -d pixel_6 --force >/dev/null 2>&1
  fi

  # Замки от убитых прогонов: эмулятор, снятый через taskkill, не успевает
  # убрать `hardware-qemu.ini.lock` и `multiinstance.lock`, а следующий запуск
  # видит их, считает AVD занятым и молча выходит.
  AVD_DIR="${USERPROFILE}/.android/avd/${avd}.avd"
  rm -rf "$AVD_DIR/hardware-qemu.ini.lock" "$AVD_DIR/multiinstance.lock"          "$AVD_DIR/userdata-qemu.img.lock" "$AVD_DIR/snapshot.lock" 2>/dev/null || true

  echo "  поднимаю эмулятор"
  if ! boot_emulator "$avd"; then
    echo "  ПРОВАЛ: эмулятор не загрузился"
    echo "$human|—|—|не загрузился" >> "$REPORT"
    stop_emulator
    continue
  fi

  ver=$("$ADB" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
  sdkv=$("$ADB" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
  echo "  на устройстве: Android $ver (sdk $sdkv)"

  # Сверяем версию с заказанной. Один раз уже случилось: от прошлого прогона
  # остался живой эмулятор, adb подключился к нему, и отчёт уверенно сообщил
  # «Android 12L» про Android 14. Отчёт, который врёт про версию, хуже
  # отсутствующего — на него ведь смотрят, чтобы решить, где чинить.
  if [ "$sdkv" != "$api" ]; then
    echo "  ПРОВАЛ: подключились не к той версии (просили $api, отвечает $sdkv)"
    echo "$human|—|—|не та версия ($sdkv)" >> "$REPORT"
    stop_emulator
    continue
  fi

  echo "  ставлю приложение"
  # Если на AVD осталась сборка с другой подписью, обновление поверх неё
  # Android запрещает — сносим и ставим заново, стенд чистый.
  if ! "$ADB" install -r -g "$APK" >/dev/null 2>&1; then
    "$ADB" uninstall $PKG >/dev/null 2>&1
    "$ADB" install -g "$APK" >/dev/null 2>&1 || {
      echo "  ПРОВАЛ: APK не установился"
      echo "$human|—|—|APK не встал" >> "$REPORT"
      stop_emulator
      continue
    }
  fi

  # Разрешения, которые на устройстве выдаёт человек. -g при установке даёт
  # runtime-разрешения, но не особые: их выдаём отдельно, иначе половина
  # сценариев провалится не из-за кода, а из-за неотвеченного вопроса.
  "$ADB" shell appops set $PKG SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1
  "$ADB" shell appops set $PKG SCHEDULE_EXACT_ALARM allow >/dev/null 2>&1
  "$ADB" shell dumpsys deviceidle whitelist +$PKG >/dev/null 2>&1
  "$ADB" shell cmd notification allow_listener "$PKG/$PKG" >/dev/null 2>&1

  log=$(mktemp -t newday-matrix-log-XXXXXX)
  AVD_NAME="$avd" bash tools/alarm-emulator-test.sh $WITH_REBOOT $ONLY 2>&1 | tee "$log" | sed 's/^/    /'
  # `grep -c` при нуле совпадений возвращает и «0», и код 1 — а `|| echo 0`
  # дописывал второй ноль, и дальше сравнение падало на «0\n0». Считаем так,
  # чтобы ноль оставался нулём.
  pass=$(grep -c '^  + ' "$log" 2>/dev/null; true)
  fail=$(grep -c 'ПРОВАЛ' "$log" 2>/dev/null; true)
  pass=${pass:-0}; fail=${fail:-0}
  verdict=$([ "$fail" -eq 0 ] && echo "всё сошлось" || echo "есть провалы")
  echo "$human|$pass|$fail|$verdict" >> "$REPORT"

  stop_emulator
done

echo
echo "════ Итог по версиям ════"
column -t -s '|' < "$REPORT" 2>/dev/null || cat "$REPORT"
echo
bad=$(tail -n +2 "$REPORT" | awk -F'|' '$4 != "всё сошлось"' | wc -l)
if [ "$bad" -eq 0 ]; then
  echo "На всех версиях будильник отработал."
else
  echo "Версий с замечаниями: $bad"
fi
[ "$bad" -eq 0 ]
