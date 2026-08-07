/**
 * Генератор звуков будильника:  node tools/make-sounds.mjs
 *
 * Пишет в public/sounds/ восемь WAV-файлов и manifest.json с русскими
 * названиями. Оттуда `npx cap sync android` укладывает их в assets APK,
 * и AlarmService играет выбранный файл вместо системного сигнала.
 *
 * Почему синтез, а не готовые записи: у записей есть авторские права и
 * мегабайты, а у синтеза — воспроизводимость. Любой звук можно поправить
 * правкой числа и перегенерировать, и в репозитории лежит не бинарный
 * артефакт неизвестного происхождения, а его исходник.
 *
 * Формат: 16-бит PCM, 44100 Гц, моно. Моно — потому что динамик будильника
 * один, а стерео удвоило бы размер APK впустую. Каждый файл 6–10 секунд и
 * заметно меньше мегабайта.
 *
 * Зацикливание без щелчка — два приёма сразу:
 *  - непрерывные звуки (рассвет, сирена) строятся из частот, кратных 1/длине
 *    файла (loopHz): каждый осциллятор совершает целое число периодов, и
 *    конец файла математически совпадает с началом;
 *  - событийные звуки (капля, колокол, писки) заканчиваются тишиной или
 *    затухшим хвостом, а короткий edgeFade гасит края до строгого нуля —
 *    страховка от щелчка при любом поведении плеера на стыке петли.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'sounds');
const SR = 44100;
const TAU = 2 * Math.PI;

// ── Кирпичи синтеза ──────────────────────────────────────────

/** Ближайшая частота с целым числом периодов на файл: петля сходится сама. */
const loopHz = (f, dur) => Math.round(f * dur) / dur;

/**
 * Синус с накоплением фазы: freq может быть функцией времени (глиссандо,
 * вой сирены), и скачков фазы при этом не бывает. amp — тоже число или
 * функция-огибающая. Всё складывается в out поверх уже написанного.
 */
function tone(out, t0, dur, freq, amp) {
  const start = Math.round(t0 * SR);
  const n = Math.min(out.length - start, Math.round(dur * SR));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    phase += (typeof freq === 'function' ? freq(t) : freq) / SR;
    out[start + i] += Math.sin(TAU * phase) * (typeof amp === 'function' ? amp(t) : amp);
  }
}

/** Тон с обертонами: harmonics = [[номер гармоники, вес], ...]. */
function rich(out, t0, dur, freq, amp, harmonics) {
  for (const [n, w] of harmonics) {
    tone(
      out, t0, dur,
      typeof freq === 'function' ? (t) => n * freq(t) : n * freq,
      typeof amp === 'function' ? (t) => w * amp(t) : w * amp,
    );
  }
}

/**
 * Свой генератор случайности вместо Math.random: файлы должны получаться
 * одинаковыми на каждом прогоне, иначе перегенерация ради одного звука
 * меняла бы в git все восемь.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Плавные края: косинусный спад до нуля, чтобы стык петли молчал. */
function edgeFade(out, ms = 12) {
  const n = Math.round((SR * ms) / 1000);
  for (let i = 0; i < n; i++) {
    const g = (1 - Math.cos((Math.PI * i) / n)) / 2;
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
}

/** Пик к заданному уровню: у «мягких» звуков он ниже, чем у «злых». */
function normalize(out, peak) {
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max === 0) return;
  const k = peak / max;
  for (let i = 0; i < out.length; i++) out[i] *= k;
}

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);       // размер fmt-блока
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // моно
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);   // байт в секунду
  buf.writeUInt16LE(2, 32);        // байт на кадр
  buf.writeUInt16LE(16, 34);       // бит на отсчёт
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// ── Сами звуки ───────────────────────────────────────────────

/**
 * «Рассвет»: тёплое мажорное созвучие, где каждый голос дышит своим
 * медленным LFO — получается перелив, а не гудение органа. Все частоты и
 * скорости дыхания кратны 1/8 Гц, поэтому петля из 8 секунд бесшовна.
 */
function dawn() {
  const D = 8;
  const out = new Float64Array(D * SR);
  // A-мажор с октавами; веса убывают к верхам — тепло, а не звон
  const voices = [
    [110, 0.18, 1], [220, 0.30, 2], [277.18, 0.22, 3], [329.63, 0.24, 2],
    [440, 0.16, 5], [554.37, 0.11, 4], [659.26, 0.09, 3], [880, 0.05, 7],
  ];
  voices.forEach(([f0, a, cycles], i) => {
    const f = loopHz(f0, D);
    const lfo = cycles / D;
    const ph = i * 2.399; // золотой угол: фазы дыхания никогда не совпадают
    const amp = (t) => a * (0.55 + 0.45 * Math.sin(TAU * lfo * t + ph));
    tone(out, 0, D, f, amp);
    tone(out, 0, D, 2 * f, (t) => 0.22 * amp(t)); // капля второй гармоники — теплее
  });
  return out;
}

/**
 * «Капля»: короткое глиссандо вверх («блюп» — так звучит схлопывающийся
 * пузырёк) и затухающее эхо, с каждым отражением тише и чуть ниже. Хвост
 * уходит в тишину, поэтому петля — просто пауза между каплями.
 */
function drop() {
  const D = 6;
  const out = new Float64Array(D * SR);
  const splash = (t0, amp, f1, f2) => {
    const dur = 0.16;
    tone(
      out, t0, dur,
      (t) => f1 * Math.pow(f2 / f1, t / dur),
      (t) => amp * Math.exp(-t / 0.045) * Math.min(1, t / 0.004),
    );
  };
  splash(0.10, 1.0, 340, 940);
  let a = 0.42;
  let top = 850;
  for (let k = 1; k <= 6; k++) {
    splash(0.10 + k * 0.34, a, 320, top);
    a *= 0.55;
    top *= 0.96;
  }
  // вторая капля поменьше — капает, а не выстрелило один раз
  splash(3.10, 0.50, 400, 1050);
  splash(3.44, 0.22, 380, 1000);
  splash(3.78, 0.10, 370, 960);
  return out;
}

/**
 * «Колокол»: негармонические частичные тоны литого колокола — гул, основной,
 * минорная терция, квинта, номинал — у каждого своё время жизни: верха гаснут
 * за доли секунды, гул держится всю паузу. Пары чуть расстроенных мод дают
 * медленные биения, то самое «плывущее» звучание большого колокола.
 */
const BELL_PARTIALS = [
  [0.500, 0.55, 4.5], [0.502, 0.30, 4.2],           // гул и его двойник
  [1.000, 1.00, 2.8], [1.0035, 0.45, 2.6],          // основной, биение ~0.7 Гц
  [1.183, 0.60, 1.6],                               // минорная терция
  [1.506, 0.35, 1.2],                               // квинта
  [2.000, 0.55, 0.9],                               // номинал
  [2.514, 0.25, 0.60], [2.662, 0.20, 0.55],
  [3.011, 0.16, 0.50], [4.166, 0.09, 0.30],
];
function bell() {
  const D = 10;
  const out = new Float64Array(D * SR);
  const rnd = mulberry32(7);
  const strike = (t0, amp) => {
    for (const [r, a, tau] of BELL_PARTIALS) {
      const f = 196 * r * (1 + (rnd() - 0.5) * 0.002); // литьё не идеально
      const dur = Math.min(D - t0 - 0.02, tau * 4);
      tone(out, t0, dur, f, (t) => amp * a * Math.exp(-t / tau) * Math.min(1, t / 0.002));
    }
    // язык бьёт по бронзе: короткий металлический шорох в момент удара
    const n0 = Math.round(t0 * SR);
    const nn = Math.round(0.008 * SR);
    for (let i = 0; i < nn; i++) out[n0 + i] += (rnd() * 2 - 1) * amp * 0.4 * (1 - i / nn);
  };
  strike(0.08, 1.0);
  strike(2.42, 0.9);
  strike(4.76, 1.0);
  strike(7.10, 0.95);
  return out;
}

/**
 * «Птицы»: щебет — короткие свипы с быстрой трелью внутри. Три «птицы»
 * поют в своих полосах частот, фразы разбросаны по файлу зерном случайности
 * с фиксированным семенем, чтобы прогон был воспроизводим.
 */
function birds() {
  const D = 8;
  const out = new Float64Array(D * SR);
  const rnd = mulberry32(20260807);
  const bands = [[2300, 3400], [3100, 4500], [1900, 2700]];
  for (let phrase = 0; phrase < 9; phrase++) {
    const [lo, hi] = bands[Math.floor(rnd() * bands.length)];
    let t = 0.15 + rnd() * (D - 1.1);
    const syllables = 3 + Math.floor(rnd() * 5);
    for (let s = 0; s < syllables && t < D - 0.2; s++) {
      const dur = 0.045 + rnd() * 0.075;
      const f1 = lo + rnd() * (hi - lo) * 0.6;
      const f2 = f1 + (rnd() < 0.5 ? 1 : -1) * (150 + rnd() * 600);
      const wobHz = 40 + rnd() * 60;   // скорость трели
      const wobA = 30 + rnd() * 90;    // её размах
      const amp = 0.22 + rnd() * 0.16;
      tone(
        out, t, dur,
        (u) => f1 + ((f2 - f1) * u) / dur + wobA * Math.sin(TAU * wobHz * u),
        (u) => amp * Math.sin((Math.PI * u) / dur) ** 2,
      );
      t += dur + 0.025 + rnd() * 0.06;
    }
  }
  return out;
}

/**
 * «Сирена»: два ротора воют на кварту врозь и не в такт — как у настоящей
 * сирены воздушной тревоги, где пара тонов раскручивается независимо.
 * Спектр пилообразный (гармоники 1/n), четыре полных воя на файл — целое
 * число, поэтому петля бесшовна.
 */
function siren() {
  const D = 8;
  const out = new Float64Array(D * SR);
  const H = [[1, 1], [2, 0.5], [3, 0.33], [4, 0.25], [5, 0.2]];
  const wail = 4 / D;
  const rotor = (fc, dev, phase, gain) => {
    const f = loopHz(fc, D);
    rich(out, 0, D, (t) => f + dev * Math.sin(TAU * wail * t + phase), gain, H);
  };
  rotor(680, 300, 0, 0.55);
  rotor(907, 400, -0.9, 0.45);
  return out;
}

/**
 * «Клаксон»: пара недружных нот с богатым спектром и рычащим дрожанием
 * ~31 Гц — то, что делает гудок гудком, а не зуммером. Серия: три коротких,
 * один длинный, пауза; такт ровно 2 секунды, четыре такта на файл.
 */
function klaxon() {
  const D = 8;
  const out = new Float64Array(D * SR);
  const H = [[1, 1], [2, 0.6], [3, 0.45], [4, 0.3], [5, 0.22], [6, 0.15], [7, 0.1]];
  const honk = (t0, dur) => {
    const env = (t) =>
      Math.min(1, t / 0.012) * Math.min(1, (dur - t) / 0.05) *
      (1 + 0.18 * Math.sin(TAU * 31 * t));
    rich(out, t0, dur, 420, (t) => 0.5 * env(t), H);
    rich(out, t0, dur, 505, (t) => 0.42 * env(t), H);
  };
  for (let c = 0; c < 4; c++) {
    const base = c * 2;
    honk(base + 0.05, 0.26);
    honk(base + 0.45, 0.26);
    honk(base + 0.85, 0.26);
    honk(base + 1.25, 0.55);
  }
  return out;
}

/**
 * «Тревога»: пронзительный писк дымового датчика — нечётные гармоники дают
 * «квадратный» тембр, который невозможно не услышать. Четыре писка, пауза;
 * высота меняется каждый такт, чтобы ухо не привыкало.
 */
function alertBeeps() {
  const D = 6;
  const out = new Float64Array(D * SR);
  const H = [[1, 1], [3, 0.35], [5, 0.18]];
  for (let c = 0; c < 6; c++) {
    const f = c % 2 === 0 ? 2093 : 2489; // до и ре-диез седьмой октавы
    for (let b = 0; b < 4; b++) {
      rich(
        out, c + b * 0.16, 0.10, f,
        (t) => 0.8 * Math.min(1, t / 0.005) * Math.min(1, (0.10 - t) / 0.008),
        H,
      );
    }
  }
  return out;
}

/**
 * «Подъём»: горн — восходящий ре-мажорный ход и трель на вершине, без
 * остановки. Каждый второй такт на тон выше: подгоняет, но пара тактов
 * образует период, и петля не спотыкается.
 */
function reveille() {
  const D = 8;
  const out = new Float64Array(D * SR);
  const H = [[1, 1], [2, 0.5], [3, 0.3], [4, 0.18]];
  const note = (t0, f, dur, a) =>
    rich(out, t0, dur, f, (t) => a * Math.min(1, t / 0.006) * Math.min(1, (dur - t) / 0.03), H);
  for (let c = 0; c < 8; c++) {
    const base = c;
    const up = c % 2 ? 1.122 : 1;
    [587.33, 739.99, 880, 1174.66].forEach((f, i) => note(base + i * 0.125, f * up, 0.11, 0.55));
    for (let k = 0; k < 6; k++) {
      note(base + 0.52 + k * 0.06, (k % 2 ? 1318.5 : 1174.66) * up, 0.055, 0.5);
    }
    // остаток такта — вдох перед следующим заходом
  }
  return out;
}

// ── Прогон ───────────────────────────────────────────────────

/*
 * file — инвариант, за который держится Android-часть (DismissConfig.soundFile);
 * name — то, что видит человек, живёт только здесь и в вебе.
 * kind: alarm — годится будильнику, notify — короткий звук уведомления.
 * mood — подсказка интерфейсу, как группировать: щадящие и беспощадные.
 */
const SOUNDS = [
  { file: 'dawn.wav', name: 'Рассвет', kind: 'alarm', mood: 'мягкий', peak: 0.55, build: dawn },
  { file: 'drop.wav', name: 'Капля', kind: 'notify', mood: 'мягкий', peak: 0.70, build: drop },
  { file: 'bell.wav', name: 'Колокол', kind: 'alarm', mood: 'злой', peak: 0.95, build: bell },
  { file: 'birds.wav', name: 'Птицы', kind: 'alarm', mood: 'мягкий', peak: 0.60, build: birds },
  { file: 'siren.wav', name: 'Сирена', kind: 'alarm', mood: 'злой', peak: 0.92, build: siren },
  { file: 'klaxon.wav', name: 'Клаксон', kind: 'alarm', mood: 'злой', peak: 0.92, build: klaxon },
  { file: 'alert.wav', name: 'Тревога', kind: 'alarm', mood: 'злой', peak: 0.92, build: alertBeeps },
  { file: 'reveille.wav', name: 'Подъём', kind: 'alarm', mood: 'злой', peak: 0.90, build: reveille },
];

await fs.mkdir(OUT, { recursive: true });
for (const s of SOUNDS) {
  const samples = s.build();
  normalize(samples, s.peak);
  edgeFade(samples);
  const bytes = wav(samples);
  await fs.writeFile(path.join(OUT, s.file), bytes);
  console.log(
    `${s.file}: ${(samples.length / SR).toFixed(1)} с, ` +
    `${Math.round(bytes.length / 1024)} КиБ — ${s.name}`,
  );
}

// манифест пишется тем же прогоном: список звуков живёт в одном месте,
// и файл не может разойтись с тем, что реально сгенерировано
const manifest = SOUNDS.map(({ file, name, kind, mood }) => ({ file, name, kind, mood }));
await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json: ${manifest.length} записей`);
