# Звуки будильника и уведомлений

Всё, что здесь лежит, — записи из открытых источников под лицензиями,
совместимыми с MIT (Apache-2.0, CC0, public domain). Синтезированного набора,
который был здесь раньше, больше нет: `tools/make-sounds.mjs` остался как
запасной путь, но в сборку идут файлы из этой папки.

Формат — OGG Vorbis. Он играет и в браузере (`<audio>` в шторке выбора), и в
`MediaPlayer` на Android, а весит на порядок меньше WAV: весь набор — 710 КБ
против 5,2 МБ у прежних восьми WAV, и это при двенадцати файлах вместо восьми.
Самый тяжёлый файл — 114 КБ.

## Откуда что

| Файл | Название | Вид | Настроение | Источник | Лицензия |
|---|---|---|---|---|---|
| `dawn.ogg` | Рассвет | будильник | мягкий | AOSP `frameworks/base/data/sounds/alarms/ogg/Argon.ogg` | Apache-2.0 |
| `harp.ogg` | Арфа | будильник | мягкий | freesound.org [#594067](https://freesound.org/s/594067/) «Harp and Pad Fm Complicated Loop», автор f-r-a-g-i-l-e | CC0 |
| `birds.ogg` | Птицы | будильник | мягкий | Wikimedia Commons [«Reggelirigók.ogg»](https://commons.wikimedia.org/wiki/File:Reggelirig%C3%B3k.ogg), автор Ödönke | public domain |
| `alert.ogg` | Резкий сигнал | будильник | злой | AOSP `frameworks/base/data/sounds/Alarm_Beep_03.ogg` | Apache-2.0 |
| `rooster.ogg` | Петух | будильник | злой | AOSP `frameworks/base/data/sounds/Alarm_Rooster_02.ogg` | Apache-2.0 |
| `klaxon.ogg` | Клаксон | будильник | злой | Wikimedia Commons [«Car Horn.wav»](https://commons.wikimedia.org/wiki/File:Car_Horn.wav), автор 15HPanska_Ruttner_Jan (изначально freesound [#461679](https://freesound.org/s/461679/)) | CC0 |
| `siren.ogg` | Сирена | будильник | злой | Wikimedia Commons [«Civil-defense-siren-waver.ogg»](https://commons.wikimedia.org/wiki/File:Civil-defense-siren-waver.ogg), автор Techtonic | public domain |
| `reveille.ogg` | Подъём | будильник | злой | Wikimedia Commons [«Reveille on bugle.ogg»](https://commons.wikimedia.org/wiki/File:Reveille_on_bugle.ogg), исполнение United States Army Band | public domain |
| `gymnopedie.ogg` | Гимнопедия | будильник | мягкий | Wikimedia Commons [«Erik Satie - gymnopedies - la 1 ere. lent et douloureux.ogg»](https://commons.wikimedia.org/wiki/File:Erik_Satie_-_gymnopedies_-_la_1_ere._lent_et_douloureux.ogg), исполнение Robin Alciatore | public domain |
| `clairdelune.ogg` | Лунный свет | будильник | мягкий | Wikimedia Commons [«Clair de Lune by Claude Debussy (1905, piano solo).opus»](https://commons.wikimedia.org/wiki/File:Clair_de_Lune_by_Claude_Debussy_(1905,_piano_solo).opus) | public domain |
| `lullaby.ogg` | Колыбельная | будильник | мягкий | Wikimedia Commons [«Lullaby wound up clock.ogg»](https://commons.wikimedia.org/wiki/File:Lullaby_wound_up_clock.ogg), автор stephan | public domain |
| `windchimes.ogg` | Колокольчики | будильник | мягкий | Wikimedia Commons [«Windglockenspiel.Koshi.ogg»](https://commons.wikimedia.org/wiki/File:Windglockenspiel.Koshi.ogg), автор Membeth | CC0 |
| `bowl.ogg` | Поющая чаша | будильник | мягкий | Wikimedia Commons [«SingingBowl1.ogg»](https://commons.wikimedia.org/wiki/File:SingingBowl1.ogg), автор BambooBeast | public domain |
| `platinum.ogg` | Платина | будильник | мягкий | AOSP `frameworks/base/data/sounds/alarms/ogg/Platinum.ogg` | Apache-2.0 |
| `krypton.ogg` | Криптон | будильник | злой | AOSP `frameworks/base/data/sounds/alarms/ogg/Krypton.ogg` | Apache-2.0 |
| `helium.ogg` | Гелий | будильник | злой | AOSP `frameworks/base/data/sounds/alarms/ogg/Helium.ogg` | Apache-2.0 |
| `drop.ogg` | Капля | уведомление | мягкий | AOSP `frameworks/base/data/sounds/notifications/Drip.ogg` | Apache-2.0 |
| `chime.ogg` | Колокольчик | уведомление | мягкий | AOSP `frameworks/base/data/sounds/notifications/Tinkerbell.ogg` | Apache-2.0 |
| `bubble.ogg` | Пузырёк | уведомление | мягкий | AOSP `frameworks/base/data/sounds/notifications/Plastic_Pipe.ogg` | Apache-2.0 |
| `key.ogg` | Клавиша | уведомление | мягкий | AOSP `frameworks/base/data/sounds/effects/ogg/KeypressStandard_120_48k.ogg` | Apache-2.0 |

### Про лицензии

**AOSP.** Файлы из `frameworks/base/data/sounds` покрыты
`default_applicable_licenses: ["Android-Apache-2.0"]` — это объявлено в
[`data/sounds/Android.bp`](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/data/sounds/Android.bp)
того же каталога, и каждый взятый файл перечислен там же в `srcs` модулей
`frameworks_alarm_sounds`, `frameworks_notifications_sounds` и
`frameworks_ui_48k_sounds`. Apache-2.0 требует сохранять уведомление о
лицензии — этим служит настоящий файл. Каталог `newwavelabs/` из того же
дерева намеренно не трогали: у тех записей отдельная история происхождения.

**Wikimedia Commons.** Лицензия каждого файла взята не со страницы поиска, а
из `extmetadata` по API (`LicenseShortName`, `UsageTerms`, `Artist`).
`Reveille on bugle.ogg` — запись оркестра армии США, произведение
федерального служащего США, отсюда public domain.

**freesound.org.** Фильтру поиска «CC0» не доверяли: у кандидата открывали
страницу звука и требовали, чтобы на ней стояла ровно ссылка на
`creativecommons.org/publicdomain/zero/1.0/` и никакой другой лицензии.
Скачано hq-превью (Vorbis) — оригинал закрыт за авторизацией, а лицензия CC0
распространяется на саму запись, а не на конкретный файл-контейнер.

**Что отвергли.** mixkit.co — его Free License разрешает использование, но
запрещает передавать файл дальше отдельно от проекта; под MIT, который прямо
разрешает sublicense и распространение, это не кладётся. Записей с CC BY и
CC BY-SA не брали: они требуют указания автора у каждого получателя копии.

## Как собран каждый файл

Скрипт сборки лежал во временной папке и в репозиторий не входит — здесь
записано то, что он делал, чтобы результат можно было повторить.

* **Взяты как есть.** `dawn.ogg` и `bubble.ogg` скопированы из источника
  байт в байт: они уже OGG Vorbis нужной длины и громкости, а перекодирование
  добавило бы второе поколение потерь — оно слышно как раз на тихих хвостах
  колокольчиков.
* **Только громкость.** `drop.ogg` (+3,4 дБ), `chime.ogg` (−10,5 дБ),
  `key.ogg` (−1,5 дБ) — исходники AOSP разных лет расходились по громкости на
  14 дБ, что при переключении звука в списке слышно как скачок.
* **Собраны из куска.** `harp.ogg` — один проход 12-секундной петли из
  24-секундного исходника. `birds.ogg` — отрезок 132–144 с (самый ровный
  участок хора) плюс фильтр ниже 250 Гц, где только гул ветра. `siren.ogg` —
  17–29 с, ровная «полка» воя. `reveille.ogg` — 0–13,05 с, сигнал там
  заканчивается паузой.
* **Собраны повтором.** `alert.ogg` (4 повтора), `rooster.ogg` (5),
  `klaxon.ogg` (4) — короткие исходники доведены до 8–9,5 с.

* **Вторая партия (сентябрь 2026).** Просили больше мягких. Из AOSP взяли
  только то, что прямо перечислено в `srcs` модуля `frameworks_alarm_sounds`
  (там 12 файлов из 23 лежащих в каталоге), и выбирали не на слух, а по
  замерам: мягкие — с низким спектральным центроидом и небольшим
  крест-фактором (Platinum: 913 Гц и 4,5 — рядом с Argon, 873 Гц и 3,6),
  злые — наоборот (Krypton: 4580 Гц и 10,4; Helium: 2010 Гц и 10,8).
  Promethium побайтно повторяет Platinum, Neptunium — Carbon, их не брали.
  С Commons — только public domain и CC0 по `extmetadata`. Пьесы Сати и
  Дебюсси — отрывок в 26 с от первой ноты (после вступительной тишины 2,2 и
  5,7 с), колокольчики и колыбельная — 20 с от начала, поющая чаша целиком.
  У отрывков мягкий вход 0,4 с и уход 2,5 с: повтор по кругу начинается с
  тишины и не щёлкает. Громкость — тем же `volume` по замеру, мягкие к
  −24 LUFS, злые к −18; у «Гелия» потолок пика не дал подняться выше −19,2.
* **Мягкие громче (15 сентября 2026).** Жалоба: «слишком тихо играет
  музыка». Замер подтвердил: у пьес и звонов медиана кратковременной
  громкости была −26…−29 LUFS, пятая часть времени — тише −30, то есть на
  полной громкости будильника в 2–4 раза тише сирены. Все мягкие будильники
  пересобраны: сначала уровень к −24, у музыки, звонов, чаши и птиц —
  компрессор (`acompressor` порог −30 дБ, 3:1, атака 15 мс, отпускание
  300 мс), затем `volume` к −18 LUFS и `alimiter` с потолком −2 дБFS и
  `latency=1`. Лимитер почти не работал (0,003 % сэмплов у «Колыбельной»,
  у остальных ноль) — прибавка целиком от компрессора и усиления. Тихая
  пятая часть поднялась на 7–11 дБ. Исходники — те же вырезки до усиления,
  `dawn.ogg` — снова из AOSP Argon, «Арфа» и «Птицы» — из прежних файлов
  (их первоисточники не сохранились). Кодирование q4 вместо q3.

### Громкость

Все будильники звучат вровень, а мягкость — это тембр и нарастание громкости
в `AlarmService` (тихое начало 15 %, дальше подъём до максимума), а не
тихий файл. Раньше мягкие были на 6 дБ тише злых «для градиента», и на
полной громкости будильника музыку было не слышно — см. третий проход выше.

* будильники, мягкие и злые, — около −18 LUFS (у «Гелия» −19,2: не дал пик);
* уведомления — RMS самого громкого окна 100 мс приведён к −19 дБFS.
  Интегральная LUFS для них не считается вовсе: `ebur128` требует не меньше
  400 мс, а «Клавиша» длится 0,11 с.

Истинный пик у всех не выше −1 дБFS.

### Зацикливание

`AlarmService` играет будильник с `isLooping = true`, поэтому стык конца и
начала не должен щёлкать. Событийные звуки (`alert`, `rooster`, `klaxon`,
`reveille`) начинаются и кончаются тишиной — там склеивать нечего.
Непрерывные (`harp`, `birds`, `siren`) собраны с «заворотом»: в начало куска
подмешан затухающий хвост следующего за ним отрезка равномощным кроссфейдом.
Тогда конец переходит в начало по материалу, а не проваливается в тишину,
как было бы от обычного fade.

Проверяли не на глаз: скачок амплитуды на шве сравнивали с 99,9-м процентилем
обычных межсэмпловых скачков внутри того же файла. У всех вышло не больше
×1,11, то есть шов не выделяется на фоне самого материала.

Отдельная грабля: `alimiter` из ffmpeg по умолчанию добавляет тишину в
начало потока (задержка предпросмотра) и ломает ровно тот стык, ради
которого всё делалось. С `latency=1` он эту задержку компенсирует: в
третьем проходе сдвиг начала относительно исходника проверен корреляцией —
0 сэмплов, длина совпадает до сэмпла. Без `latency=1` его не брать.

Компрессор в начале файла стартует «холодным» — у непрерывных звуков это
могло бы дать всплеск на каждом повторе. Проверено: соотношение «конец →
начало» у «Птиц» и «Арфы» то же, что до пересборки, скачок на шве ×0,12 и
×0,36.

## Совместимость со старыми настройками

Раньше файлы были `.wav`, теперь `.ogg`, и часть имён сменилась. В профилях
людей могло сохраниться `soundFile: "dawn.wav"` (или `"bell.wav"` — этого
звука больше нет вовсе).

Молчащего будильника из этого не выйдет. `AlarmService.startSound` пробует
источники по очереди:

```
openAssetPlayer(cfg.soundFile)      // public/sounds/<файл> в ассетах APK
  ?: openCustomPlayer(cfg.soundFile) // filesDir/sounds/<файл>, свой звук
  ?: openSystemPlayer()              // системный сигнал будильника
```

Для `dawn.wav` первые два вернут `null` (в лог уйдёт
`Звук 'dawn.wav' не открылся: … — беру системный`), сработает третий, и
человек услышит штатный сигнал телефона. Поле `player` везде используется
через `?.`, так что даже полный отказ всех трёх путей сервис не роняет —
останется вибрация.

Цена всё же есть: до того, как человек зайдёт в настройки и выберет звук
заново, будильник будет звонить системным сигналом, а не выбранным когда-то
«Рассветом». Само по себе это чинится одним заходом в шторку выбора звука.

`MediaPlayer` читает OGG Vorbis из ассетов через `openFd` без оговорок —
формат поддерживается Android с первых версий, отдельного кодека не нужно.
