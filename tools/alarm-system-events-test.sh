#!/usr/bin/env bash
#
# Три системных события, после которых будильник обязан остаться живым.
#   bash tools/alarm-system-events-test.sh [--only 1,2,3]
#
# Требуется запущенный эмулятор и установленный APK (rustore release).
#
#  1. Перезагрузка ДО первой разблокировки. На устройствах с шифрованием файлов
#     (FBE — всё, начиная с Android 10) BOOT_COMPLETED приходит только после
#     первой разблокировки: телефон, перезагрузившийся ночью сам, утром не
#     звонит вовсе. Проверяется по-настоящему: задаётся пин, телефон
#     перезагружается и НЕ отпирается — будильник обязан зазвонить поверх
#     локскрина.
#  2. Смена часового пояса. Будильники стоят по абсолютному времени эпохи,
#     поэтому после перелёта «подъём в 07:00» звонит по прежнему поясу.
#     Проверяется сменой пояса на устройстве: fireAt обязан пересчитаться на то
#     же местное время, а отложенный — остаться на месте.
#  3. Смена размера шрифта во время звонка. Без fontScale в configChanges экран
#     пересоздаётся, и решённые задачи приходится решать заново.
#
# Почему рут: `setprop persist.sys.timezone` от имени shell на Android 14+
# отклоняется системой («Failed to set property»), пояс молча не меняется — и
# сценарий 2 проверял бы неизменившийся пояс, то есть ничего. Поэтому adbd
# перезапускается рутом, а если пояс всё равно не сменился, сценарий честно
# говорит «стенд», а не «успешно».

set -u

# Временные файлы — в .tmp проекта, с уборкой на выходе
. "$(dirname "$0")/lib/tmp.sh"

ADB="${LOCALAPPDATA}/Android/Sdk/platform-tools/adb.exe"
PKG=${NEWDAY_PKG:-ru.appswire.newday}
HOME_TZ=${NEWDAY_TZ_FROM:-Europe/Moscow}
AWAY_TZ=${NEWDAY_TZ_TO:-Asia/Novosibirsk}
PIN=1234

ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) shift; ONLY=",${1}," ;;
  esac
  shift
done
want() { [ -z "$ONLY" ] || [ "${ONLY#*,$1,}" != "$ONLY" ]; }

PASS=0
FAIL=0
ok()    { echo "  + $1"; PASS=$((PASS + 1)); }
bad()   { echo "  - $1  ПРОВАЛ"; FAIL=$((FAIL + 1)); }
stand() { echo "  ! СТЕНД: $1"; }

log_tail() { "$ADB" logcat -d -s NewDayAlarm 2>&1 | tr -d '\r' | tail -"${1:-8}" | sed 's/^/      /'; }

# ── Мост в вебвью ────────────────────────────────────────────────
# Плагин зовём так же, как его зовёт настоящая веб-часть: через мост
# Capacitor. Обходной путь (am broadcast, adb shell) проверял бы не то, что
# работает у людей.

cdp() {
  local pid
  pid=$("$ADB" shell pidof $PKG | tr -d '\r')
  "$ADB" forward --remove-all >/dev/null 2>&1
  "$ADB" forward tcp:9222 localabstract:webview_devtools_remote_"$pid" >/dev/null 2>&1
  sleep 1
}

wv() {
  local out i pid
  for i in 1 2 3 4 5 6 7 8; do
    pid=$("$ADB" shell pidof $PKG 2>/dev/null | tr -d '\r')
    if [ -z "$pid" ]; then
      "$ADB" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
      "$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
      sleep 4
    fi
    cdp
    out=$(node tools/webview-eval.js "$1" 2>/dev/null | tail -1)
    [ -n "$out" ] && [ "$out" != "null" ] && { echo "$out"; return 0; }
    sleep 2
  done
  echo ""
  return 1
}

app_up() {
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
  "$ADB" logcat -c >/dev/null 2>&1
  "$ADB" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
  "$ADB" shell wm dismiss-keyguard >/dev/null 2>&1
  sleep 1
  "$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
  local tries=0
  sleep 3
  while [ -z "$("$ADB" shell pidof $PKG 2>/dev/null | tr -d '\r')" ] && [ "$tries" -lt 5 ]; do
    "$ADB" shell am start -n $PKG/ru.appswire.newday.MainActivity >/dev/null 2>&1
    sleep 3
    tries=$((tries + 1))
  done
  # Приложение, если оно с аккаунтом, само отправляет свой список будильников и
  # заменяет им всё, что стоит на устройстве. Дождаться его обязательно: иначе
  # наш будильник снимет первая же синхронизация — и «не зазвонил» соврёт.
  local waited=0
  while [ "$waited" -lt 20 ]; do
    "$ADB" logcat -d -s NewDayAlarm 2>&1 | grep -q "SYNCED" && break
    sleep 2
    waited=$((waited + 2))
  done
  [ -n "$(wv 'location.href')" ] || stand "вебвью не ответил после запуска"
}

# ── Экран ────────────────────────────────────────────────────────

UI_POSIX=$(nd_tmpfile newday-se)
UI_WIN=$(cygpath -w "$UI_POSIX" 2>/dev/null || echo "$UI_POSIX")
dump_ui() {
  MSYS_NO_PATHCONV=1 "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  MSYS_NO_PATHCONV=1 "$ADB" pull /sdcard/ui.xml "$UI_WIN" >/dev/null 2>&1
}

on_screen() { LC_ALL=C grep -aqF "$1" "$UI_POSIX"; }

# Нажать клавишу с таким текстом. Берём ПОСЛЕДНЕЕ совпадение нарочно: введённый
# ответ показывается в поле выше клавиатуры тем же текстом, и первое совпадение
# «7» — это поле ответа, а не клавиша.
tap_key() {
  local bounds nums x y
  bounds=$(tr '>' '\n' < "$UI_POSIX" \
    | LC_ALL=C grep -aF "text=\"$1\"" \
    | LC_ALL=C grep -ao 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | tail -1)
  [ -z "$bounds" ] && return 1
  nums=$(echo "$bounds" | grep -o '[0-9]*' | tr '\n' ' ')
  # shellcheck disable=SC2086
  set -- $nums
  x=$(( ($1 + $3) / 2 ))
  y=$(( ($2 + $4) / 2 ))
  "$ADB" shell input tap "$x" "$y" >/dev/null 2>&1
  sleep 1
}

ringing() { "$ADB" shell dumpsys activity activities 2>/dev/null | grep -q "AlarmActivity"; }

await_screen() {
  local deadline=$1 waited=0
  while [ "$waited" -lt "$deadline" ]; do
    ringing && { echo "      экран будильника поднялся через ${waited} с"; return 0; }
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# ── Пояс ─────────────────────────────────────────────────────────

tz_now() { "$ADB" shell getprop persist.sys.timezone | tr -d '\r'; }

# Пояс меняем тем же путём, которым его меняет человек в настройках, — через
# системный определитель пояса.
#
# `adb shell setprop persist.sys.timezone` — первое, что приходит в голову, и
# оно врёт: пояс действительно меняется (date показывает новое время), но
# широковещания система при этом не рассылает вовсе — в истории рассылок
# TIMEZONE_CHANGED нет ни одной записи. Проверено на Android 16. Сценарий на
# setprop проверял бы, что приёмник не позвали, и объявлял бы провалом
# работающий код. Заодно от имени shell этот setprop на 14+ просто отклоняется.
tz_set() {
  local want=$1 try
  [ "$(tz_now)" = "$want" ] && return 0
  # Ручное указание пояса система принимает только при выключенном
  # автоопределении — иначе оно тут же вернёт своё. Первая попытка сразу после
  # загрузки иногда уходит в никуда: определитель ещё разворачивается.
  for try in 1 2 3; do
    "$ADB" shell cmd time_zone_detector set_auto_detection_enabled false >/dev/null 2>&1
    "$ADB" shell cmd time_zone_detector suggest_manual_time_zone --zone_id "$want" >/dev/null 2>&1
    sleep 5
    [ "$(tz_now)" = "$want" ] && return 0
  done
  if [ "$(tz_now)" != "$want" ]; then
    "$ADB" root >/dev/null 2>&1
    sleep 3
    "$ADB" wait-for-device
    "$ADB" shell setprop persist.sys.timezone "$want" >/dev/null 2>&1
    sleep 4
    [ "$(tz_now)" = "$want" ] &&
      stand "пояс сменён через setprop — система о таком не сообщает, приёмник ждать нечего"
  fi
  [ "$(tz_now)" = "$want" ]
}

logged() { "$ADB" logcat -d -s NewDayAlarm 2>&1 | tr -d '\r' | grep -qF "$1"; }

# ── Пин и локскрин ───────────────────────────────────────────────

pin_set()   { "$ADB" shell locksettings set-pin $PIN >/dev/null 2>&1 || "$ADB" shell locksettings set-pin --old $PIN $PIN >/dev/null 2>&1; }
pin_clear() { "$ADB" shell locksettings clear --old $PIN >/dev/null 2>&1; }

user_state() { "$ADB" shell dumpsys user 2>/dev/null | tr -d '\r' | grep -m1 -o 'RUNNING_[A-Z_]*'; }

unlock_with_pin() {
  "$ADB" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
  sleep 1
  "$ADB" shell input swipe 500 1600 500 400 >/dev/null 2>&1
  sleep 1
  "$ADB" shell input text $PIN >/dev/null 2>&1
  "$ADB" shell input keyevent KEYCODE_ENTER >/dev/null 2>&1
  local waited=0
  while [ "$waited" -lt 40 ]; do
    [ "$(user_state)" = "RUNNING_UNLOCKED" ] && return 0
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

wait_boot() {
  "$ADB" wait-for-device
  local waited=0
  while [ "$waited" -lt 240 ]; do
    [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && return 0
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

# ── Настройки отключения ─────────────────────────────────────────
# Пишем прямо через setConfig: сервера у стенда может не быть, а нам нужны
# ровно эти настройки, а не те, что придут из профиля.
set_config() {
  local types=$1 count=$2 grace=$3
  wv "Capacitor.Plugins.NewDayAlarm.setConfig({ config: { types: $types, count: $count, difficulty: 1, timeoutSec: 120, snoozeAllowed: false, volumeRamp: false, graceEnabled: $grace, graceSec: 60 } }).then(r => 'cfg=' + r.config.count + '/' + r.config.graceEnabled)"
}

# JS-помощники: стенное время в произвольном поясе и обратно. Нужны, чтобы
# посчитать fireAt так же, как его считает веб-часть, — по местному времени
# и поясу, а не по смещению «на глазок».
JS_TZ='const zparts=(tz,d)=>{const f=new Intl.DateTimeFormat("en-CA",{timeZone:tz,hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});const o={};for(const p of f.formatToParts(d))o[p.type]=p.value;return o;};const wall2epoch=(tz,y,mo,da,h,mi)=>{const want=Date.UTC(y,mo-1,da,h,mi);let g=want;for(let i=0;i<4;i++){const p=zparts(tz,new Date(g));const cur=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);g+=want-cur;}return g;};'

echo "════ Будильник против системных событий ════"
echo "устройство: Android $("$ADB" shell getprop ro.build.version.release | tr -d '\r') (sdk $("$ADB" shell getprop ro.build.version.sdk | tr -d '\r')), шифрование: $("$ADB" shell getprop ro.crypto.type | tr -d '\r')"

# ── 1. Перезагрузка до первой разблокировки ──────────────────────

if want 1; then
echo
echo "== 1. Перезагрузка ночью, телефон не разблокирован =="

if [ "$("$ADB" shell getprop ro.crypto.type | tr -d '\r')" != "file" ]; then
  stand "на устройстве нет шифрования файлов (FBE) — сценарий проверяет не то"
fi

# Эмулятор при каждой загрузке возвращает пояс к GMT — это свойство стенда, а
# не телефона. Ставим будильник сразу в том поясе, в котором устройство
# окажется после перезагрузки: иначе честный пересчёт по местному времени
# (сценарий 2) сдвинет будильник на разницу поясов, и «не зазвонил» соврёт про
# работающий код. На настоящем телефоне пояс перезагрузку переживает.
BOOT_TZ=${NEWDAY_TZ_BOOT:-GMT}
tz_set "$BOOT_TZ" >/dev/null 2>&1
echo "      пояс до перезагрузки: $(tz_now)"

app_up
set_config "['math']" 1 false >/dev/null
# Будильник ставим настоящим путём — через тот же schedule, которым его ставит
# веб-часть: с номером строки расписания и датой.
planned=$(wv "$JS_TZ (() => { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; const fireAt = Date.now() + 330000; const p = zparts(tz, new Date(fireAt)); return Capacitor.Plugins.NewDayAlarm.schedule({ alarms: [{ id: 770101, fireAt, title: 'Подъём', body: 'ночная перезагрузка', kind: 'alarm', profile: 'wakeup', date: p.year + '-' + p.month + '-' + p.day }], config: { types: ['math'], count: 1, difficulty: 1, graceEnabled: false, snoozeAllowed: false, volumeRamp: false }, enabled: true }).then(r => 'scheduled=' + r.scheduled + ' fireAt=' + fireAt); })()")
echo "      поставлен: $planned"
case "$planned" in
  *scheduled=1*) ;;
  *) stand "будильник не поставился через вебвью — дальше проверять нечего" ;;
esac

pin_set
echo "      пин задан: $("$ADB" shell locksettings verify --old $PIN 2>&1 | tr -d '\r')"
# Признак «остановлено принудительно» — стенд, который умеет соврать, и ставит
# его сам прогон своим force-stop. Остановленному приложению Android не даёт ни
# BOOT_COMPLETED, ни LOCKED_BOOT_COMPLETED — это её правило. Запуск приложения
# признак снимает, но на диск это записывается с задержкой: перезагрузка сразу
# после запуска возвращала прежнее «остановлено», и будильник законно оставался
# без широковещания — прогон при этом обвинял приложение. Снимаем явно и даём
# записаться.
"$ADB" shell cmd package unstop $PKG >/dev/null 2>&1
sleep 12
echo "      перед перезагрузкой: $("$ADB" shell dumpsys package $PKG 2>/dev/null | tr -d '\r' | grep -o 'stopped=[a-z]*' | head -1), будильников в системе: $("$ADB" shell dumpsys alarm 2>/dev/null | tr -d '\r' | grep -c newday)"
"$ADB" reboot
sleep 5
if wait_boot; then
  st=$(user_state)
  echo "      после загрузки состояние пользователя: $st"
  if [ "$st" = "RUNNING_UNLOCKED" ]; then
    stand "телефон разблокирован сам — сценарий «до первой разблокировки» не воспроизведён"
  fi
  [ "$(tz_now)" = "$BOOT_TZ" ] || stand "после загрузки пояс стал $(tz_now) вместо $BOOT_TZ — будильник законно переехал по местному времени"
  after_stopped=$("$ADB" shell dumpsys package $PKG 2>/dev/null | tr -d '\r' | grep -o 'stopped=[a-z]*' | head -1)
  echo "      после загрузки: $after_stopped, будильников в системе: $("$ADB" shell dumpsys alarm 2>/dev/null | tr -d '\r' | grep -c newday), падений: $("$ADB" logcat -d 2>/dev/null | tr -d '\r' | grep -ciE 'FATAL EXCEPTION|AndroidRuntime.*newday')"
  if await_screen 300; then
    ok "будильник зазвонил до первой разблокировки"
  elif [ "$after_stopped" = "stopped=true" ]; then
    stand "приложение загрузилось «остановленным» — Android такому широковещаний не даёт, проверен не код"
  else
    bad "будильник до первой разблокировки не зазвонил"
  fi
  echo "      лог будильника после загрузки:"
  log_tail 12
  echo "      состояние пользователя: $(user_state)"
  # Звук: до разблокировки системный рингтон лежит в credential-хранилище и
  # может не открыться вовсе — это видно только по логу.
  "$ADB" logcat -d -s NewDayAlarm 2>&1 | tr -d '\r' | grep -E "звук|Звук" | tail -3 | sed 's/^/      звук: /'
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
  unlock_with_pin && echo "      телефон отперт пином, состояние: $(user_state)" || stand "не удалось отпереть телефон пином"
else
  stand "устройство не поднялось после перезагрузки"
fi
pin_clear
fi

# ── 2. Смена часового пояса ──────────────────────────────────────

if want 2; then
echo
echo "== 2. Смена часового пояса =="

if ! tz_set "$HOME_TZ"; then
  stand "не удалось задать пояс $HOME_TZ (сейчас $(tz_now)) — сценарий не проверен"
else
echo "      пояс до перелёта: $(tz_now), время: $("$ADB" shell date | tr -d '\r')"
app_up

# Будильник ставим на местное время, которое НАСТУПИТ через ~3 минуты в новом
# поясе. Пока телефон в старом поясе, до него ещё часы — то есть без пересчёта
# он не зазвонит, и это ровно то, что должно чиниться.
plan=$(wv "$JS_TZ (() => { const here = Intl.DateTimeFormat().resolvedOptions().timeZone; const target = Date.now() + 190000; const p = zparts('$AWAY_TZ', new Date(target)); const date = p.year + '-' + p.month + '-' + p.day; const fireAt = wall2epoch(here, +p.year, +p.month, +p.day, +p.hour, +p.minute); const snoozedAt = Date.now() + 3600000; const sp = zparts(here, new Date(snoozedAt)); return Capacitor.Plugins.NewDayAlarm.schedule({ alarms: [ { id: 770201, fireAt, title: 'Подъём', body: 'после перелёта', kind: 'alarm', profile: 'wakeup', date }, { id: 770202, fireAt: snoozedAt, title: 'Отложенный', body: 'через 5 минут', kind: 'alarm', profile: 'gentle', date: sp.year + '-' + sp.month + '-' + sp.day, snoozed: true } ], config: { types: ['math'], count: 1, difficulty: 1, graceEnabled: false, snoozeAllowed: false, volumeRamp: false }, enabled: true }).then(() => 'wall=' + p.hour + ':' + p.minute + ' date=' + date + ' fireAt=' + fireAt + ' snoozedAt=' + snoozedAt); })()")
echo "      поставлено: $plan"

before=$(wv "Capacitor.Plugins.NewDayAlarm.list().then(r => r.alarms.map(a => a.id + ':' + a.fireAt + ':' + (a.localHm || '-') + ':' + a.snoozed).join(' '))")
echo "      до смены пояса: $before"

if ! tz_set "$AWAY_TZ"; then
  stand "не удалось сменить пояс на $AWAY_TZ"
else
  sleep 8
  echo "      пояс после перелёта: $(tz_now), время: $("$ADB" shell date | tr -d '\r')"
  after=$(wv "Capacitor.Plugins.NewDayAlarm.list().then(r => r.alarms.map(a => a.id + ':' + a.fireAt + ':' + (a.localHm || '-') + ':' + a.snoozed).join(' '))")
  echo "      после смены пояса: $after"

  # Кавычки снимаем: мост отдаёт значение как JSON-строку, и «"770201:…» не
  # совпадает с образцом «^770201:» — сравнение молча получало пустоту.
  f0=$(echo "$before" | tr -d '"' | tr ' ' '\n' | grep '^770201:' | cut -d: -f2)
  f1=$(echo "$after"  | tr -d '"' | tr ' ' '\n' | grep '^770201:' | cut -d: -f2)
  s0=$(echo "$before" | tr -d '"' | tr ' ' '\n' | grep '^770202:' | cut -d: -f2)
  s1=$(echo "$after"  | tr -d '"' | tr ' ' '\n' | grep '^770202:' | cut -d: -f2)
  if [ -n "$f0" ] && [ -n "$f1" ] && [ "$f0" != "$f1" ]; then
    echo "      подъём: $f0 → $f1 (сдвиг $(( (f1 - f0) / 60000 )) мин)"
    ok "fireAt подъёма пересчитан на новый пояс"
  else
    echo "      подъём: $f0 → $f1"
    bad "fireAt подъёма не пересчитался"
  fi

  if [ -n "$s0" ] && [ "$s0" = "$s1" ]; then
    ok "отложенный будильник не сдвинулся"
  else
    echo "      отложенный: $s0 → $s1"
    bad "отложенный будильник сдвинули (а «через 5 минут» к местному времени не привязано)"
  fi

  echo "      лог пересчёта:"
  log_tail 6

  if await_screen 240; then
    ok "будильник зазвонил по местному времени нового пояса"
  else
    bad "будильник по местному времени нового пояса не зазвонил"
  fi
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1

  # Главный случай — приложение не открыто: человек прилетел и телефон включил,
  # а планировщик дня не запускал. Процесс убиваем (не «остановить
  # принудительно»: остановленному приложению система широковещаний не даёт
  # вовсе — это её правило, а не наша беда) и меняем пояс обратно.
  app_up >/dev/null 2>&1
  "$ADB" shell am kill $PKG >/dev/null 2>&1
  sleep 2
  "$ADB" logcat -c >/dev/null 2>&1
  if tz_set "$HOME_TZ"; then
    sleep 6
    if logged "TZ_SHIFT"; then
      ok "пояс пересчитан и при закрытом приложении (процесс поднят широковещанием)"
      log_tail 3
    else
      bad "при закрытом приложении смена пояса прошла мимо"
    fi
  else
    stand "не удалось вернуть пояс $HOME_TZ"
  fi

  # Перевод часов вручную. Настоящего события система по команде не рассылает,
  # поэтому шлём его сами от рута: это проверяет только нашу обработку —
  # имя действия (TIME_SET, а не TIME_CHANGED) и то, что приёмник его понимает.
  "$ADB" root >/dev/null 2>&1
  sleep 2
  "$ADB" wait-for-device
  "$ADB" logcat -c >/dev/null 2>&1
  "$ADB" shell am broadcast -a android.intent.action.TIME_SET -p $PKG >/dev/null 2>&1
  sleep 5
  if logged "TIME_SET"; then
    ok "перевод часов приёмник понимает (действие TIME_SET)"
  else
    stand "искусственное TIME_SET до приёмника не дошло"
    log_tail 4
  fi
fi
tz_set "$HOME_TZ" >/dev/null 2>&1
fi
fi

# ── 3. Размер шрифта во время звонка ─────────────────────────────

if want 3; then
echo
echo "== 3. Размер шрифта меняется во время звонка =="
"$ADB" shell settings put system font_scale 1.0 >/dev/null 2>&1
app_up
set_config "['math']" 3 false
got=$(wv "Capacitor.Plugins.NewDayAlarm.testAlarm({ delaySec: 10, profile: 'wakeup' }).then(r => 'fireAt=' + r.fireAt)")
case "$got" in
  *fireAt=*) ;;
  *) stand "проверочный будильник не поставился" ;;
esac

if ! await_screen 90; then
  stand "экран будильника не поднялся — проверять нечего"
else
  sleep 2
  dump_ui
  if on_screen "ЗАДАЧА 1 ИЗ 3"; then
    echo "      на экране: задача 1 из 3"
  else
    stand "на экране не задача 1 из 3"
  fi
  # Решаем первую задачу: пример читаем с экрана, ответ вводим клавиатурой
  # будильника — так же, как это делает человек.
  ex=$(tr '>' '\n' < "$UI_POSIX" | LC_ALL=C grep -ao 'text="[0-9]* + [0-9]* ="' | head -1)
  a=$(echo "$ex" | grep -o '[0-9]*' | head -1)
  b=$(echo "$ex" | grep -o '[0-9]*' | sed -n 2p)
  if [ -z "$a" ] || [ -z "$b" ]; then
    stand "пример с экрана не прочитался ($ex)"
  else
    sum=$((a + b))
    echo "      пример: $a + $b = $sum"
    for d in $(echo "$sum" | grep -o .); do dump_ui; tap_key "$d"; done
    dump_ui; tap_key "OK"
    sleep 2
    dump_ui
    if on_screen "ЗАДАЧА 2 ИЗ 3"; then
      ok "первая задача принята, идёт вторая"
      "$ADB" shell settings put system font_scale 1.3 >/dev/null 2>&1
      sleep 5
      dump_ui
      if on_screen "ЗАДАЧА 2 ИЗ 3"; then
        ok "после смены размера шрифта прогресс на месте (задача 2 из 3)"
      elif on_screen "ЗАДАЧА 1 ИЗ 3"; then
        bad "после смены размера шрифта экран пересоздался — прогресс сброшен на задачу 1"
      else
        bad "после смены размера шрифта на экране не задача 2 из 3"
      fi
      starts=$("$ADB" logcat -d -s NewDayAlarm 2>&1 | tr -d '\r' | grep -c "Экран отключения: будильник")
      echo "      экран отключения создавался раз: $starts"
    else
      stand "первая задача не принялась — нечего терять при смене шрифта"
    fi
  fi
fi
"$ADB" shell settings put system font_scale 1.0 >/dev/null 2>&1
"$ADB" shell am force-stop $PKG >/dev/null 2>&1
fi

echo
echo "Итог: успешно $PASS, провалено $FAIL"
[ "$FAIL" -eq 0 ]
