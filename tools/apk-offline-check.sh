#!/usr/bin/env bash
#
# Работает ли приложение без сети — проверка в настоящем APK, а не в браузере.
#
#   bash tools/apk-offline-check.sh [--api 34] [--base https://newday.appswire.ru]
#                                   [--mail ... --pass ...]
#
# Браузерная проверка (tools/offline-check.mjs) ничего не говорит про APK: там
# другой origin, другое хранилище и другой способ достучаться до сервера.
# Здесь то же самое проверяется в приложении: ставим APK, входим, гасим сеть
# командой adb, перезапускаем приложение и смотрим, что осталось на экране.

set -u
SDK="${LOCALAPPDATA}/Android/Sdk"
ADB="$SDK/platform-tools/adb.exe"
EMU="$SDK/emulator/emulator.exe"
AVDMAN="$SDK/cmdline-tools/latest/bin/avdmanager.bat"
PKG=ru.appswire.newday
APK=android/app/build/outputs/apk/release/app-release.apk
API=34
BASE="https://newday.appswire.ru"
MAIL="alonecentral2001@gmail.com"
PASS="DanT2000"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --api) shift; API="$1" ;;
    --base) shift; BASE="$1" ;;
    --mail) shift; MAIL="$1" ;;
    --pass) shift; PASS="$1" ;;
    --keep) KEEP=1 ;;
  esac
  shift
done

PASSED=0
FAILED=0
проба() {
  if [ "$2" = "0" ]; then echo "  + $1${3:+ — $3}"; PASSED=$((PASSED + 1));
  else echo "  - $1  ПРОВАЛ${3:+ — $3}"; FAILED=$((FAILED + 1)); fi
}

avd="newday_api${API}"
"$ADB" emu kill >/dev/null 2>&1; sleep 3
taskkill //F //IM qemu-system-x86_64.exe >/dev/null 2>&1 || true
sleep 2
"$ADB" kill-server >/dev/null 2>&1; sleep 1; "$ADB" start-server >/dev/null 2>&1

if ! "$AVDMAN" list avd 2>/dev/null | grep -q "Name: $avd"; then
  echo no | "$AVDMAN" create avd -n "$avd" \
    -k "system-images;android-${API};google_apis;x86_64" -d pixel_6 --force >/dev/null 2>&1
fi

# Замки от убитых прогонов.
#
# Эмулятор, снятый через taskkill, не успевает убрать за собой
# `hardware-qemu.ini.lock` и `multiinstance.lock`. Следующий запуск видит их,
# считает, что этот AVD уже запущен, и молча выходит — в логе остаётся одна
# строка «поднимаю эмулятор», и кажется, что он просто долго грузится.
AVD_DIR="${USERPROFILE}/.android/avd/${avd}.avd"
rm -rf "$AVD_DIR/hardware-qemu.ini.lock" "$AVD_DIR/multiinstance.lock" \
       "$AVD_DIR/userdata-qemu.img.lock" "$AVD_DIR/snapshot.lock" 2>/dev/null || true

echo "поднимаю эмулятор"
"$EMU" -avd "$avd" -no-snapshot-save -no-boot-anim -no-audio -gpu swiftshader_indirect -dns-server 8.8.8.8,1.1.1.1 >/dev/null 2>&1 &
"$ADB" wait-for-device
waited=0
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 5; waited=$((waited + 5))
  [ "$waited" -gt 420 ] && { echo "эмулятор не загрузился"; exit 1; }
done

# Убеждаемся, что перед нами живое устройство, а не доживающее предыдущее.
# Уже случилось: adb отвечал на остатке прошлого эмулятора, загрузка «прошла»
# мгновенно, а установка тут же упиралась в «no devices» — и выглядело это как
# поломка APK, хотя ставить было просто некуда.
sleep 8
alive=0
for _ in 1 2 3 4 5 6; do
  if [ "$("$ADB" shell echo ok 2>/dev/null | tr -d '\r')" = "ok" ]; then
    alive=$((alive + 1))
  else
    alive=0
    echo "  устройство пропало, жду ещё"
  fi
  [ "$alive" -ge 3 ] && break
  sleep 4
done
if [ "$alive" -lt 3 ]; then
  echo "эмулятор не держится: adb то видит устройство, то нет"
  exit 1
fi

# Установка с объяснением, если не вышло.
ставим() {
  local out
  out=$("$ADB" install -r -g "$APK" 2>&1)
  case "$out" in
    *Success*) return 0 ;;
  esac
  # Самая частая причина — прошлая сборка подписана другим ключом: обновление
  # поверх неё Android запрещает. Сносим и ставим заново, это чистый стенд.
  echo "  первая попытка не прошла: $(echo "$out" | tr -d '\r' | tail -1)"
  "$ADB" uninstall $PKG >/dev/null 2>&1
  out=$("$ADB" install -g "$APK" 2>&1)
  case "$out" in
    *Success*) echo "  поставили после переустановки"; return 0 ;;
  esac
  echo "APK не встал: $(echo "$out" | tr -d '\r' | tail -1)"
  return 1
}
sdkv=$("$ADB" shell getprop ro.build.version.sdk | tr -d '\r')
echo "на устройстве: Android $("$ADB" shell getprop ro.build.version.release | tr -d '\r') (sdk $sdkv)"

# Сверяем версию с заказанной: проверка уже один раз уверенно отчиталась про
# Android 14, разговаривая с оставшимся живым Android 16.
if [ "$sdkv" != "$API" ]; then
  echo "ПРОВАЛ: подключились не к той версии (просили $API, отвечает $sdkv)"
  exit 2
fi

# И что у устройства вообще есть интернет: без него «приложение не видит
# сервер» ничего не говорит о приложении.
#
# Спрашиваем систему, а не пингуем: эмулятор не пропускает ICMP от обычных
# приложений, и `ping` не проходит даже при живом интернете. Первая версия
# этой проверки именно так и соврала — объявила, что сети нет, на устройстве,
# где она была. Система же знает точно: у сети есть признак VALIDATED, если
# Android сходил наружу и убедился.
net=$("$ADB" shell "dumpsys connectivity" 2>/dev/null | tr -d '\r' | grep -c "VALIDATED" || true)
if [ "${net:-0}" -lt 1 ]; then
  echo "ПРОВАЛ: у эмулятора нет проверенной сети — связь с сервером проверять бессмысленно"
  exit 2
fi
# И что имя сервера разрешается. Признака VALIDATED мало: сеть бывает
# «проверенной», а нужный домен не разрешается — эмулятор берёт DNS у хоста, и
# один раз он честно отвечал «unknown host» на наш адрес. Тогда «приложение не
# видит сервер» — это про стенд, а не про приложение, и сказать надо именно так.
host=${BASE#*://}
host=${host%%/*}
dns=$("$ADB" shell "ping -c 1 -W 2 $host" 2>&1 | tr -d '\r' | grep -c "unknown host" || true)
if [ "${dns:-0}" -gt 0 ]; then
  echo "ПРОВАЛ: эмулятор не разрешает имя $host — это ограничение стенда, не приложения"
  exit 2
fi
echo "интернет есть, имя $host разрешается"

ставим || exit 1

# ── Мост в вебвью приложения ──
cdp() {
  local pid
  pid=$("$ADB" shell pidof $PKG | tr -d '\r')
  [ -z "$pid" ] && return 1
  "$ADB" forward --remove-all >/dev/null 2>&1
  "$ADB" forward tcp:9222 localabstract:webview_devtools_remote_"$pid" >/dev/null 2>&1
  sleep 1
}
# Значение из вебвью строкой.
js() {
  # webview-eval печатает JSON, поэтому строки приходят в кавычках: без их
  # снятия проверка «непустая строка» проходила на пустой строке `""`.
  node tools/webview-eval.js "$1" 2>/dev/null | tail -1 | sed 's/^"//; s/"$//'
}

# То же, но с показом ошибки: когда что-то не выходит, молчание бесполезно
jsv() { node tools/webview-eval.js "$1" 2>&1 | tail -2; }

# Запуск приложения с ожиданием вебвью.
start_app() {
  "$ADB" shell am force-stop $PKG >/dev/null 2>&1
  sleep 1
  "$ADB" shell am start -n $PKG/.MainActivity >/dev/null 2>&1
  # Фиксированной паузы мало: без сети запуск идёт другим путём и занимает
  # другое время. Ждём, пока вебвью действительно ответит, — иначе проверка
  # читает пустоту и объявляет, что экран не собрался, хотя он ещё грузится.
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    cdp || continue
    [ -n "$(js 'location.href')" ] && return 0
  done
  echo "  вебвью не отвечает: приложение живо? pid=$("$ADB" shell pidof $PKG | tr -d '\r')"
  return 1
}

сеть() {
  if [ "$1" = "off" ]; then
    "$ADB" shell svc wifi disable >/dev/null 2>&1
    "$ADB" shell svc data disable >/dev/null 2>&1
  else
    "$ADB" shell svc wifi enable >/dev/null 2>&1
    "$ADB" shell svc data enable >/dev/null 2>&1
  fi
  sleep 4
}

echo
echo "── Со связью: вход в приложении ──"
start_app
проба "приложение открылось" "$([ -n "$(js 'location.href')" ] && echo 0 || echo 1)" "$(js 'location.href')"

# Входим тем же путём, что и человек: через форму на странице входа
js "localStorage.setItem('newday.apiBase', '$BASE')" >/dev/null
# Сначала проверяем, что из приложения вообще виден сервер: без этого «вход не
# прошёл» ничего не объясняет — может, дело в сети эмулятора, а не в коде.
reach=$(js "fetch('$BASE/api/health').then(r => 'здоровье ' + r.status).catch(e => 'сеть недоступна: ' + e.message)")
проба "сервер виден из приложения" "$(echo "$reach" | grep -q 'здоровье 200' && echo 0 || echo 1)" "$reach"

login_ok=$(js "fetch('$BASE/api/v1/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ emailOrUsername:'$MAIL', password:'$PASS', issueDeviceToken:true, deviceName:'Проверка', platform:'android' }) })
  .then(r => r.json()).then(d => { if (d.deviceToken) localStorage.setItem('newday.deviceToken', d.deviceToken); return d.deviceToken ? 'ok' : ('ответ без токена: ' + JSON.stringify(d).slice(0, 120)); })
  .catch(e => 'запрос упал: ' + e.message)")
проба "вход выдал токен устройства" "$([ "$login_ok" = "ok" ] && echo 0 || echo 1)" "$login_ok"

# открываем веб-версию и даём ей загрузить день
js "location.replace('/web.html')" >/dev/null
sleep 9
cdp
nodes_on=$(js "document.querySelectorAll('.wroot *').length")
проба "со связью день собрался" "$([ "${nodes_on:-0}" -gt 50 ] && echo 0 || echo 1)" "узлов ${nodes_on:-0}"
saved=$(js "(() => { const s = localStorage.getItem('newday.local.settings');
  if (!s) return 'копии настроек нет';
  const t = JSON.parse(s).value.today;
  const d = localStorage.getItem('newday.local.day.' + t);
  return d ? 'строк в копии: ' + (JSON.parse(d).value.schedule || []).length : 'копии дня нет'; })()")
проба "день сохранён на устройстве" "$(echo "$saved" | grep -q 'строк в копии: [1-9]' && echo 0 || echo 1)" "$saved"

echo
echo "── Без сети ──"
сеть off
online=$(js "navigator.onLine")
echo "  navigator.onLine: $online"

# Сеть должна быть погашена на самом деле.
#
# `navigator.onLine` в эмуляторе остаётся true и после `svc wifi disable` —
# верить ему нельзя. Если сеть на деле жива, вся эта часть проверяет не офлайн,
# а обычную работу со связью и радостно рапортует об успехе. Спрашиваем прямо:
# доходит ли запрос до сервера. Дошёл — проверка недостоверна, и надо сказать
# это, а не выдать зелёный итог.
still=$(js "fetch('$BASE/api/health', { cache: 'no-store' }).then(() => 'дошёл').catch(() => 'не дошёл')")
if [ "$still" = "дошёл" ]; then
  echo "ПРОВАЛ: сеть не погасла — запрос всё ещё доходит до сервера, офлайн проверить нечем"
  exit 2
fi
echo "  сеть погашена: запрос до сервера не доходит"

# Перезапускаем приложение целиком: именно так человек открывает его в метро
start_app
sleep 6
cdp
href=$(js "location.href")
nodes_off=$(js "document.querySelectorAll('.wroot *').length")
проба "без сети приложение открывается" "$([ "${nodes_off:-0}" -gt 50 ] && echo 0 || echo 1)" "узлов ${nodes_off:-0}, адрес $href"
[ "${nodes_off:-0}" -le 50 ] && echo "      текст: $(js "(document.body.innerText || '').slice(0, 140)")"

day_off=$(js "document.querySelector('.wphead-num')?.textContent || document.querySelector('.wtop-num')?.textContent || ''")
проба "день виден без сети" "$([ -n "$day_off" ] && echo 0 || echo 1)" "«$day_off»"
banner=$(js "document.querySelector('.wnotice')?.className || 'нет'")
проба "полоса «нет связи» спокойная" "$(echo "$banner" | grep -q calm && echo 0 || echo 1)" "$banner"

clicked=$(js "(() => { const b = [...document.querySelectorAll('.wbtn-dashed')].find(x => x.textContent.includes('Всё расписание'));
  if (!b) return -1; b.click(); return -2; })()")
sleep 2
cdp
sheet_rows=$(js "document.querySelectorAll('.wmodal .wsheet-row').length")
проба "всё расписание доступно без сети" "$([ "${sheet_rows:-0}" -gt 0 ] && echo 0 || echo 1)" "clicked ${sheet_rows:-0}"

echo
echo "── Связь вернулась ──"
сеть on
sleep 6
cdp
js "document.dispatchEvent(new Event('visibilitychange'))" >/dev/null
sleep 5
banner_back=$(js "document.querySelector('.wnotice')?.className || 'нет'")
проба "со связью полоса уходит" "$([ "$banner_back" = "нет" ] && echo 0 || echo 1)" "$banner_back"

echo
echo "── Итог в APK ──"
echo "$PASSED успешно, $FAILED провалено"
[ "$KEEP" = "1" ] || { "$ADB" emu kill >/dev/null 2>&1; sleep 3; taskkill //F //IM qemu-system-x86_64.exe >/dev/null 2>&1 || true; }
[ "$FAILED" -eq 0 ]
