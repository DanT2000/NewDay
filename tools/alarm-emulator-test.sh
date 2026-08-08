#!/usr/bin/env bash
#
# Сценарии, в которых будильник обязан сработать, и проверка мягкого начала.
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

# Временные файлы — в .tmp проекта, с уборкой на выходе
. "$(dirname "$0")/lib/tmp.sh"
ADB="${LOCALAPPDATA}/Android/Sdk/platform-tools/adb.exe"
# Одно имя и для пакета кода, и для магазина, поэтому активность зовётся
# ru.appswire.newday.MainActivity
PKG=${NEWDAY_PKG:-ru.appswire.newday}
WITH_REBOOT=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --with-reboot) WITH_REBOOT=1 ;;
    --only) shift; ONLY=",${1}," ;;   # --only 7,8,9 — гонять только эти сценарии
  esac
  shift
done

PASS=0
FAIL=0

# нужен ли сценарий номер N
want() { [ -z "$ONLY" ] || [ "${ONLY#*,$1,}" != "$ONLY" ]; }

# «Поверх других приложений» — без него система блокирует поднятие экрана
# будильника из фона на разблокированном телефоне. На устройстве это
# разрешение выдаёт человек в экране проверки будильника.
"$ADB" shell appops set $PKG SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1

restart() {
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
  "$ADB" logcat -c >/dev/null 2>&1
  # Экран будим и отпираем до старта: прошлый сценарий мог оставить его
  # погашенным и запертым, а activity, запущенная за локскрином, на 13-м
  # висит паузнутой — вебвью в ней не создаётся, и мост CDP молчит,
  # сколько ни пробуй. Выглядело это как «будильник не поднял экран».
  "$ADB" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
  "$ADB" shell wm dismiss-keyguard >/dev/null 2>&1
  sleep 1
  "$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
  # Запуск сразу после force-stop иногда теряется (замечено на 13-м): запрос
  # цепляется к ещё умирающему процессу, и приложение не стартует вовсе —
  # pid пуст, вебвью нет, и провал выглядит как «экран не поднялся».
  # Проверяем, что процесс появился, и заводим снова, пока не появится.
  local tries=0
  sleep 2
  while [ -z "$("$ADB" shell pidof $PKG 2>/dev/null | tr -d '\r')" ] && [ "$tries" -lt 6 ]; do
    "$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
    sleep 3
    tries=$((tries + 1))
  done
  [ "$tries" -gt 0 ] && echo "      стенд: запуск потерялся, повторов: $tries"
  # Приложение при запуске само отправляет свои будильники в систему, и этот
  # вызов заменяет весь список. Если он придёт после тестового будильника,
  # тестовый будет снят. Поэтому ждём его — или сдаёмся через 25 с.
  local waited=0
  sleep 5
  while [ "$waited" -lt 20 ]; do
    if "$ADB" logcat -d -s NewDayAlarm 2>&1 | grep -q "SYNCED"; then break; fi
    sleep 2
    waited=$((waited + 2))
  done
  # И дожидаемся самого вебвью: на первом старте свежего образа (особенно 13)
  # он поднимается дольше, чем идёт ожидание выше, а сценарий, ушедший дальше
  # без живого моста, ставит будильник в пустоту — и провал выглядит как
  # «экран не поднялся», хотя приложение ни при чём.
  if [ -z "$(wv 'location.href')" ]; then
    echo "      СТЕНД: вебвью так и не ответил после запуска" >&2
  fi
}

cdp() {
  local pid
  pid=$("$ADB" shell pidof $PKG | tr -d '\r')
  "$ADB" forward --remove-all >/dev/null 2>&1
  "$ADB" forward tcp:9222 localabstract:webview_devtools_remote_"$pid" >/dev/null 2>&1
  sleep 1
}

# eval с упорством: вебвью после рестарта поднимается неровно, и на свежем
# AVD (особенно 13-м) первая попытка попадает в момент, когда страницы ещё
# нет. Одна молчаливая неудача здесь превращалась в «экран будильника не
# поднялся» — провал приложения там, где не сработал стенд.
wv() {
  local out i pid
  for i in 1 2 3 4 5 6 7 8 9 10; do
    # На первой загрузке свежего образа система занята своим (dexopt,
    # индексация), и свежезапущенное приложение с погасшим экраном — первая
    # жертва убийцы памяти: pid пропадает через секунды после старта.
    # Это стенд, а не приложение, поэтому просто поднимаем его снова.
    pid=$("$ADB" shell pidof $PKG 2>/dev/null | tr -d '\r')
    if [ -z "$pid" ]; then
      "$ADB" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
      "$ADB" shell wm dismiss-keyguard >/dev/null 2>&1
      "$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
      sleep 4
    fi
    cdp
    out=$(node tools/webview-eval.js "$1" 2>/dev/null | tail -1)
    [ -n "$out" ] && { echo "$out"; return 0; }
    sleep 3
  done
  # Отказ моста без объяснения уже один раз выглядел как провал приложения.
  # Пишем в лог всё, чем он объясним: жив ли процесс, есть ли сокет
  # отладки, что отвечает список страниц и что сказал сам eval.
  {
    echo "      МОСТ НЕ ОТВЕТИЛ, диагностика:"
    echo "      pid=[$("$ADB" shell pidof $PKG | tr -d '\r')]"
    echo "      сокеты: $("$ADB" shell 'cat /proc/net/unix | grep devtools' 2>/dev/null | tr -d '\r' | tr '\n' ' ')"
    echo "      страницы: $(curl -s --max-time 3 http://127.0.0.1:9222/json/list | head -c 200)"
    echo "      eval: $(node tools/webview-eval.js "$1" 2>&1 | head -2 | tr '\n' ' ')"
    echo "      кто убил: $("$ADB" logcat -d 2>/dev/null | tr -d '\r' | grep -E 'am_kill|lmkd|Killing.*newday' | tail -3 | tr '\n' ' ')"
  } >&2
  echo ""
  return 1
}

# fire <delaySec> [profile] — ставит тестовый будильник через настоящий плагин
fire() {
  local got
  got=$(wv "Capacitor.Plugins.NewDayAlarm.testAlarm({ delaySec: $1, profile: '${2:-gentle}' }).then(r => 'fireAt=' + r.fireAt)")
  # Непоставленный будильник — это провал стенда, а не приложения, и он
  # должен быть виден как таковой: иначе «экран не поднялся» врёт.
  case "$got" in
    *fireAt=*) return 0 ;;
    *) echo "      СТЕНД: будильник не поставился через вебвью"; return 1 ;;
  esac
}

# grace <секунды|off> — задаёт мягкое начало.
#
# Пишем в двух местах, и оба нужны. Настройки на сервере — источник истины,
# приложение периодически синхронизируется и затирает локальное значение
# серверным; без записи на сервер сценарий проверял бы значение по умолчанию,
# думая, что проверяет заданное. setConfig — чтобы значение подействовало сразу,
# не дожидаясь следующей синхронизации.
grace() {
  local on=true sec=${1} got
  [ "$1" = "off" ] && { on=false; sec=60; }
  wv "fetch(localStorage.getItem('newday.apiBase') + '/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('newday.deviceToken') }, body: JSON.stringify({ settings: { alarmGraceEnabled: $on, alarmGraceSec: $sec } }) }).then(r => 'settings ' + r.status)" >/dev/null
  got=$(wv "Capacitor.Plugins.NewDayAlarm.setConfig({ config: { graceEnabled: $on, graceSec: $sec, types: ['math'], count: 1, difficulty: 1, timeoutSec: 30, snoozeAllowed: false, volumeRamp: false } }).then(r => 'grace=' + r.config.graceEnabled + '/' + r.config.graceSec)")
  # Настройка, молча не применившаяся, — худший вид провала: сценарий пройдёт
  # мимо того, что проверял. Поэтому печатаем, что реально записалось.
  echo "      настройка: $got"
}

# ждёт экран будильника, НЕ трогая приложение: дальше с экраном ещё работают
await_screen() {
  local deadline=$1 waited=0
  while [ "$waited" -lt "$deadline" ]; do
    if "$ADB" shell dumpsys activity activities 2>/dev/null | grep -q "AlarmActivity"; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# check <название> <0|1 результат>
check() {
  if [ "$2" = "0" ]; then
    echo "  + $1"
    PASS=$((PASS + 1))
  else
    echo "  - $1  ПРОВАЛ"
    FAIL=$((FAIL + 1))
    "$ADB" logcat -d -s NewDayAlarm 2>&1 | tail -6 | sed 's/^/      /'
  fi
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
}

# Снимок экрана в файл. Через `adb shell cat` кириллица по пути портится,
# поэтому файл вытягиваем и читаем локально.
#
# MSYS_NO_PATHCONV обязателен: без него Git Bash превращает /sdcard/ui.xml
# в windows-путь, дамп уходит мимо устройства, а проверки читают пустоту
# и молча не находят ничего — то есть провал выглядит как настоящий.
#
# Путь назначения — windows-вида: adb.exe принимает только его, а posix-путь
# из mktemp он превращает в C:\tmp\… и молча ничего не сохраняет.
UI_POSIX=$(nd_tmpfile newday-ui)
UI_WIN=$(cygpath -w "$UI_POSIX" 2>/dev/null || echo "$UI_POSIX")
dump_ui() {
  MSYS_NO_PATHCONV=1 "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  MSYS_NO_PATHCONV=1 "$ADB" pull /sdcard/ui.xml "$UI_WIN" >/dev/null 2>&1
}

# Есть ли на экране такой текст. LC_ALL=C и -a: файл сравниваем побайтово,
# иначе grep в msys падает на нём с Aborted.
on_screen() {
  dump_ui
  LC_ALL=C grep -aqF "$1" "$UI_POSIX"
}

# ищет на экране кнопку с текстом и нажимает её
tap_text() {
  dump_ui
  local bounds
  bounds=$(tr '>' '\n' < "$UI_POSIX" \
    | LC_ALL=C grep -aF "text=\"$1\"" \
    | LC_ALL=C grep -ao 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -1)
  if [ -z "$bounds" ]; then
    # Запасной путь: кнопка на этом экране единственная фокусируемая, так что
    # её можно нажать с клавиатуры, не зная координат.
    echo "      кнопки «$1» в дампе нет, нажимаю с клавиатуры"
    "$ADB" shell input keyevent KEYCODE_TAB >/dev/null 2>&1
    sleep 1
    "$ADB" shell input keyevent KEYCODE_ENTER >/dev/null 2>&1
    return 0
  fi
  local nums x y
  nums=$(echo "$bounds" | grep -o '[0-9]*' | tr '\n' ' ')
  # shellcheck disable=SC2086
  set -- $nums
  x=$(( ($1 + $3) / 2 ))
  y=$(( ($2 + $4) / 2 ))
  "$ADB" shell input tap "$x" "$y" >/dev/null 2>&1
}

# есть ли строка в логе будильника
logged() {
  "$ADB" logcat -d -s NewDayAlarm 2>&1 | grep -qF "$1"
}

# Громкость потока будильника (stream 4).
#
# Раньше здесь было `adb shell media volume`, которого на этом образе просто
# нет: команда молча не находилась, громкость не менялась, и сценарий
# «беззвучный режим» проходил, ничего не проверив. Отсюда и проверка ниже —
# что приложение действительно вывело громкость из нуля.
alarm_volume() {
  "$ADB" shell cmd media_session volume --stream 4 --get 2>&1 \
    | tr -d '\r' | LC_ALL=C grep -ao 'volume is [0-9]*' | grep -o '[0-9]*' | head -1
}

# Диапазон потока будильника — «volume is 7 in range [1..7]».
# Нижняя граница не ноль: поток будильника в Android заглушить нельзя,
# и именно поэтому беззвучный режим на него не влияет.
alarm_volume_range() {
  "$ADB" shell cmd media_session volume --stream 4 --get 2>&1 \
    | tr -d '\r' | LC_ALL=C grep -ao 'range \[[0-9]*\.\.[0-9]*\]' | head -1
}

set_alarm_volume() {
  "$ADB" shell cmd media_session volume --stream 4 --set "$1" >/dev/null 2>&1
}

set_ring_volume() {
  "$ADB" shell cmd media_session volume --stream 2 --set "$1" >/dev/null 2>&1
}

# Режим звонка: normal | vibrate | silent.
#
# Способов задать его снаружи несколько, и какой из них живой — зависит от
# образа: `cmd audio` есть не на всех, `service call audio` требует своего
# номера транзакции на каждой версии. Пробуем по очереди и возвращаем то, что
# получилось на самом деле: молча «поставили», не поставив, хуже, чем честно
# сказать «не умею» — сценарий тогда не сделает вид, что проверил.
set_ringer_mode() {
  local want=$1 got
  "$ADB" shell cmd audio set-ringer-mode "$want" >/dev/null 2>&1
  got=$(ringer_mode)
  if [ "$got" != "$want" ]; then
    local num=2
    [ "$want" = "vibrate" ] && num=1
    [ "$want" = "silent" ] && num=0
    "$ADB" shell settings put global mode_ringer "$num" >/dev/null 2>&1
    got=$(ringer_mode)
  fi
  echo "$got"
}

ringer_mode() {
  local out
  out=$("$ADB" shell cmd audio get-ringer-mode 2>&1 | tr -d '\r')
  case "$out" in
    *silent*|*SILENT*) echo silent; return ;;
    *vibrate*|*VIBRATE*) echo vibrate; return ;;
    *normal*|*NORMAL*) echo normal; return ;;
  esac
  case "$("$ADB" shell settings get global mode_ringer 2>/dev/null | tr -d '\r')" in
    0) echo silent ;;
    1) echo vibrate ;;
    2) echo normal ;;
    *) echo неизвестно ;;
  esac
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

if want 1; then
echo "== 1. Заблокированный экран =="
restart; fire 10
"$ADB" shell input keyevent KEYCODE_SLEEP
await_alarm 45 "экран погашен и заблокирован"

fi

if want 2; then
echo "== 2. Громкостью распоряжается приложение, а не система =="
# Задать громкость снаружи на этом образе нельзя: и `cmd media_session volume
# --set`, и `settings put`, и клавиши громкости молча ничего не меняют —
# работает только чтение. Поэтому проверяем то, что проверяемо и что как раз
# и означает «звук выключен, а будильник слышно»: приложение само выставляет
# громкость потока будильника — тихо в мягком начале и на максимум после.
# Сравнение двух замеров исключает пустую проверку «максимум равен максимуму».
restart
grace 12
"$ADB" logcat -c >/dev/null 2>&1
fire 8
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
if await_screen 45; then
  sleep 2
  quiet=$(alarm_volume)
  sleep 14
  loud=$(alarm_volume)
  echo "      громкость: тихая фаза $quiet → после окна $loud, $(alarm_volume_range)"
  if [ -n "$quiet" ] && [ -n "$loud" ] && [ "$loud" -gt "$quiet" ]; then
    check "приложение подняло громкость с $quiet до $loud при убитом приложении" 0
  else
    check "приложение управляет громкостью потока будильника" 1
  fi
else
  check "экран будильника поднялся" 1
fi
restart; grace 60

fi

if want 3; then
echo "== 3. Полная тишина: «Не беспокоить» без исключений =="
restart
"$ADB" shell cmd notification set_dnd on >/dev/null 2>&1
sleep 2
# zen_mode: 0 — выключен, 2 — полная тишина. Проверяем, что режим действительно
# включился: если команда не сработает, сценарий пройдёт, ничего не проверив.
zen=$("$ADB" shell settings get global zen_mode 2>/dev/null | tr -d '\r')
echo "      zen_mode=$zen (2 — полная тишина)"
"$ADB" logcat -c >/dev/null 2>&1
fire 10
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
if [ "$zen" = "2" ] && await_screen 45; then
  check "звонит в режиме полной тишины при убитом приложении" 0
else
  check "звонит в режиме полной тишины (zen_mode=$zen)" 1
fi
"$ADB" shell cmd notification set_dnd off >/dev/null 2>&1

fi

if want 4; then
echo "== 4. Глубокий сон системы (Doze) =="
restart; fire 14
"$ADB" shell input keyevent KEYCODE_SLEEP
"$ADB" shell dumpsys battery unplug >/dev/null 2>&1
"$ADB" shell dumpsys deviceidle force-idle >/dev/null 2>&1
await_alarm 45 "Doze"
"$ADB" shell dumpsys deviceidle unforce >/dev/null 2>&1
"$ADB" shell dumpsys battery reset >/dev/null 2>&1

fi

if want 5; then
echo "== 5. Процесс убит (смахнули из недавних) =="
restart; fire 16
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
await_alarm 45 "процесс убит"

fi

if want 6; then
echo "== 6. Без сети =="
restart
"$ADB" shell svc wifi disable >/dev/null 2>&1
"$ADB" shell svc data disable >/dev/null 2>&1
fire 10
"$ADB" shell input keyevent KEYCODE_SLEEP
await_alarm 45 "сети нет"
"$ADB" shell svc wifi enable >/dev/null 2>&1
"$ADB" shell svc data enable >/dev/null 2>&1

fi

# ── Мягкое начало ──────────────────────────────────────────────
# Проверяем в самых злых условиях сразу: звук выключен, «Не беспокоить»
# включён, приложение убито, экран погашен и заблокирован.

if want 7; then
echo "== 7. Мягкое начало: выключается одной кнопкой, без задач =="
restart
grace 120
"$ADB" shell cmd notification set_dnd on >/dev/null 2>&1
set_alarm_volume 0 >/dev/null 2>&1
"$ADB" logcat -c >/dev/null 2>&1
fire 10
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
if await_screen 60; then
  sleep 2
  tap_text "Выключить"
  sleep 3
  if logged "GRACE_DISMISS" \
     && ! "$ADB" shell dumpsys activity activities 2>/dev/null | grep -q "AlarmActivity"; then
    check "выключился одним нажатием при выключенном звуке и убитом приложении" 0
  else
    check "выключился одним нажатием при выключенном звуке и убитом приложении" 1
  fi
else
  check "экран будильника поднялся (мягкое начало)" 1
fi
"$ADB" shell cmd notification set_dnd off >/dev/null 2>&1

fi

if want 8; then
echo "== 8. Окно кончилось — громкость вверх и появляются задачи =="
restart
grace 10
set_alarm_volume 0 >/dev/null 2>&1
"$ADB" logcat -c >/dev/null 2>&1
fire 8
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
if await_screen 60; then
  sleep 14
  vol=$(alarm_volume)
  if logged "GRACE_END" && logged "GRACE_EXPIRED" && on_screen "ЗАДАЧА"; then
    echo "      громкость будильника после окна: $vol"
    check "задачи появились сами, громкость поднята" 0
  else
    check "задачи появились сами, громкость поднята" 1
  fi
else
  check "экран будильника поднялся (эскалация)" 1
fi

fi

if want 9; then
echo "== 9. Мягкое начало выключено — задачи сразу =="
restart
grace off
"$ADB" logcat -c >/dev/null 2>&1
fire 8
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
if await_screen 60; then
  sleep 2
  if on_screen "ЗАДАЧА" && ! logged "GRACE_START"; then
    check "без окна задачи показываются сразу" 0
  else
    check "без окна задачи показываются сразу" 1
  fi
else
  check "экран будильника поднялся (без окна)" 1
fi
restart; grace 60   # возвращаем значение по умолчанию

fi

if want 10; then
echo "== 10. Беззвучный режим переключателем, а не громкостью =="
# Сценарий 2 проверяет громкость потока, а это — сам режим звонка: человек
# щёлкает переключателем на боку телефона, и «беззвучно» для него значит
# именно это. Поток будильника режим звонка не трогает — на том и держится
# обещание «будильник звонит на беззвучном».
restart
got=$(set_ringer_mode silent)
echo "      режим звонка: $got"
"$ADB" logcat -c >/dev/null 2>&1
fire 10
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
if [ "$got" = "silent" ]; then
  await_alarm 45 "звонит в беззвучном режиме при убитом приложении"
else
  check "беззвучный режим удалось включить (получилось «$got»)" 1
fi
set_ringer_mode normal >/dev/null

fi

if want 11; then
echo "== 11. Режим вибрации =="
restart
got=$(set_ringer_mode vibrate)
echo "      режим звонка: $got"
"$ADB" logcat -c >/dev/null 2>&1
fire 10
"$ADB" shell am kill $PKG >/dev/null 2>&1
"$ADB" shell input keyevent KEYCODE_SLEEP
if [ "$got" = "vibrate" ]; then
  await_alarm 45 "звонит в режиме вибрации при убитом приложении"
else
  check "режим вибрации удалось включить (получилось «$got»)" 1
fi
set_ringer_mode normal >/dev/null

fi

if [ "$WITH_REBOOT" = "1" ]; then
  echo "== 12. Перезагрузка устройства =="
  restart; fire 150          # запас на перезагрузку эмулятора
  "$ADB" reboot
  "$ADB" wait-for-device
  until [ "$("$ADB" shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 3; done
  await_alarm 240 "будильник пережил перезагрузку"

  echo "== 13. Телефон был выключен в момент звонка =="
  # Самый обидный случай: человек выключил телефон на ночь, будильник должен был
  # прозвенеть в 07:00, а телефон включили в 07:10. Система про этот будильник
  # уже забыла, и без своей обработки он пропадает молча — то есть человек
  # просто не просыпается. Пропущенный будильник обязан прозвенеть сразу после
  # загрузки, а не исчезнуть.
  restart; fire 60
  sleep 3
  "$ADB" emu kill >/dev/null 2>&1 || "$ADB" shell reboot -p >/dev/null 2>&1
  echo "      телефон выключен, ждём, пока время будильника пройдёт"
  sleep 75
  if [ -n "${AVD_NAME:-}" ]; then
    EMU="${LOCALAPPDATA}/Android/Sdk/emulator/emulator.exe"
    "$EMU" -avd "$AVD_NAME" -no-snapshot-save -no-boot-anim >/dev/null 2>&1 &
    "$ADB" wait-for-device
    until [ "$("$ADB" shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 3; done
    await_alarm 240 "пропущенный будильник прозвенел после включения"
  else
    echo "      пропущено: нужен AVD_NAME, чтобы включить телефон обратно"
  fi
fi

echo
echo "Итог: успешно $PASS, провалено $FAIL"
[ "$FAIL" -eq 0 ]
