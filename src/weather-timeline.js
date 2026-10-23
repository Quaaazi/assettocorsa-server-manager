// Таймлайн погоды и времени суток (CSP WeatherFX) для AssettoServer.
// 1) Превращает ключевые кадры таймлайна в секции [WEATHER_N] для server_cfg.ini
// 2) Пока сервер запущен — ведёт игровые часы и переключает погоду командами админа.

// Идентификаторы WeatherFxType из AssettoServer (CSP)
const WEATHER_FX_TYPES = {
    LightThunderstorm: 0, Thunderstorm: 1, HeavyThunderstorm: 2,
    LightDrizzle: 3, Drizzle: 4, HeavyDrizzle: 5,
    LightRain: 6, Rain: 7, HeavyRain: 8,
    LightSnow: 9, Snow: 10, HeavySnow: 11,
    LightSleet: 12, Sleet: 13, HeavySleet: 14,
    Clear: 15, FewClouds: 16, ScatteredClouds: 17, BrokenClouds: 18, OvercastClouds: 19,
    Fog: 20, Mist: 21, Smoke: 22, Haze: 23, Sand: 24, Dust: 25,
    Squalls: 26, Tornado: 27, Hurricane: 28, Cold: 29, Hot: 30, Windy: 31, Hail: 32
};

// Ванильная графика — для клиентов без CSP и как основа строки GRAPHICS
const VANILLA_GRAPHICS = {
    Clear: '3_clear', FewClouds: '4_mid_clear', ScatteredClouds: '5_light_clouds',
    BrokenClouds: '6_mid_clouds', OvercastClouds: '7_heavy_clouds',
    Fog: '1_heavy_fog', Mist: '2_light_fog', Haze: '2_light_fog', Smoke: '2_light_fog',
    Hot: '3_clear', Cold: '4_mid_clear', Windy: '5_light_clouds'
};

const DEFAULT_KEYFRAME = {
    time: 12 * 60, type: 'Clear', ambient: 20, road: 26,
    windMin: 0, windMax: 5, windDir: 0, transition: 120
};

const DEFAULT_TIMELINE = {
    enabled: false,
    timeMult: 1,
    keyframes: [
        { ...DEFAULT_KEYFRAME, time: 8 * 60, type: 'FewClouds', ambient: 16, road: 19 },
        { ...DEFAULT_KEYFRAME, time: 14 * 60, type: 'Clear', ambient: 24, road: 32 },
        { ...DEFAULT_KEYFRAME, time: 20 * 60, type: 'BrokenClouds', ambient: 18, road: 21 }
    ]
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const toNum = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);

function formatTime(minutes) {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// AssettoServer: SUN_ANGLE 0 = 13:00, 16° на час, допустимо от -80 (08:00) до 80 (18:00).
// Ночное время выставляется уже на лету командой /settime.
function timeToSunAngle(minutes) {
    return clamp(Math.round((minutes / 60 - 13) * 16), -80, 80);
}

function normalizeTimeline(raw) {
    const src = raw && typeof raw === 'object' ? raw : DEFAULT_TIMELINE;
    const keyframes = (Array.isArray(src.keyframes) && src.keyframes.length > 0 ? src.keyframes : DEFAULT_TIMELINE.keyframes)
        .map(k => ({
            time: clamp(Math.round(toNum(k.time, DEFAULT_KEYFRAME.time)), 0, 1439),
            type: WEATHER_FX_TYPES[k.type] !== undefined ? k.type : 'Clear',
            ambient: clamp(toNum(k.ambient, DEFAULT_KEYFRAME.ambient), -20, 50),
            road: clamp(toNum(k.road, DEFAULT_KEYFRAME.road), -20, 70),
            windMin: clamp(toNum(k.windMin, 0), 0, 100),
            windMax: clamp(toNum(k.windMax, 0), 0, 100),
            windDir: clamp(toNum(k.windDir, 0), 0, 359),
            transition: clamp(toNum(k.transition, DEFAULT_KEYFRAME.transition), 0, 3600)
        }))
        .sort((a, b) => a.time - b.time);

    return { enabled: Boolean(src.enabled), timeMult: clamp(toNum(src.timeMult, 1), 0, 60), keyframes };
}

// Ключевые кадры -> { WEATHER_0: {...}, WEATHER_1: {...} }
function buildWeatherSections(timeline, weatherFxEnabled) {
    const sections = {};
    timeline.keyframes.forEach((k, i) => {
        const vanilla = VANILLA_GRAPHICS[k.type] || '7_heavy_clouds';
        sections[`WEATHER_${i}`] = {
            // Суффикс _type=N читает CSP WeatherFX; ванильные клиенты используют префикс
            GRAPHICS: weatherFxEnabled ? `${vanilla}_type=${WEATHER_FX_TYPES[k.type]}` : vanilla,
            BASE_TEMPERATURE_AMBIENT: Math.round(k.ambient),
            BASE_TEMPERATURE_ROAD: Math.round(k.road - k.ambient), // в AC это смещение относительно воздуха
            VARIATION_AMBIENT: 1,
            VARIATION_ROAD: 1,
            WIND_BASE_SPEED_MIN: Math.round(Math.min(k.windMin, k.windMax)),
            WIND_BASE_SPEED_MAX: Math.round(Math.max(k.windMin, k.windMax)),
            WIND_BASE_DIRECTION: Math.round(k.windDir),
            WIND_VARIATION_DIRECTION: 15
        };
    });
    return sections;
}

// Убирает старые [WEATHER_N] из server_cfg и записывает новые + время суток
function applyTimelineToServerCfg(serverCfg, timeline, weatherFxEnabled) {
    for (const key of Object.keys(serverCfg)) {
        if (/^WEATHER_\d+$/.test(key)) delete serverCfg[key];
    }
    Object.assign(serverCfg, buildWeatherSections(timeline, weatherFxEnabled));
    if (!serverCfg.SERVER) serverCfg.SERVER = {};
    serverCfg.SERVER.SUN_ANGLE = timeToSunAngle(timeline.keyframes[0].time);
    serverCfg.SERVER.TIME_OF_DAY_MULT = timeline.timeMult;
    return serverCfg;
}

// Обратная операция: если weather_timeline.json ещё нет — собираем таймлайн из server_cfg
function timelineFromServerCfg(serverCfg) {
    const weatherKeys = Object.keys(serverCfg || {}).filter(k => /^WEATHER_\d+$/.test(k))
        .sort((a, b) => parseInt(a.slice(8)) - parseInt(b.slice(8)));
    if (weatherKeys.length === 0) return normalizeTimeline(DEFAULT_TIMELINE);

    const sunAngle = toNum(serverCfg.SERVER?.SUN_ANGLE, 0);
    const startMinutes = clamp(Math.round((13 + sunAngle / 16) * 60), 0, 1439);
    const step = Math.floor(1440 / weatherKeys.length);

    const keyframes = weatherKeys.map((key, i) => {
        const w = serverCfg[key];
        const graphics = String(w.GRAPHICS || '3_clear');
        const typeMatch = graphics.match(/_type=(\d+)/);
        const byId = typeMatch ? Object.keys(WEATHER_FX_TYPES).find(n => WEATHER_FX_TYPES[n] === parseInt(typeMatch[1])) : null;
        const byVanilla = Object.keys(VANILLA_GRAPHICS).find(n => graphics.startsWith(VANILLA_GRAPHICS[n]));
        const ambient = toNum(w.BASE_TEMPERATURE_AMBIENT, 20);
        return {
            time: (startMinutes + i * step) % 1440,
            type: byId || byVanilla || 'Clear',
            ambient,
            road: ambient + toNum(w.BASE_TEMPERATURE_ROAD, 6),
            windMin: toNum(w.WIND_BASE_SPEED_MIN, 0),
            windMax: toNum(w.WIND_BASE_SPEED_MAX, 0),
            windDir: toNum(w.WIND_BASE_DIRECTION, 0),
            transition: DEFAULT_KEYFRAME.transition
        };
    });
    return normalizeTimeline({ enabled: weatherKeys.length > 1, timeMult: toNum(serverCfg.SERVER?.TIME_OF_DAY_MULT, 1), keyframes });
}

// --- ПЛАНИРОВЩИК: работает только пока запущен AssettoServer ---
class WeatherScheduler {
    constructor() {
        this.timer = null;
        this.timeline = null;
        this.sendCommand = null;
        this.onLog = null;
        this.gameMinutes = 0;
        this.activeIndex = -1;
    }

    // sendCommand(cmd) -> boolean; onLog(text) — вывод в консоль менеджера
    start(timeline, { sendCommand, onLog, weatherFxEnabled }) {
        this.stop();
        if (!timeline || !timeline.enabled || timeline.keyframes.length === 0) return;

        this.timeline = timeline;
        this.sendCommand = sendCommand;
        this.onLog = onLog;
        this.weatherFxEnabled = weatherFxEnabled;
        this.gameMinutes = timeline.keyframes[0].time;

        this.sendCommand(`/settime ${formatTime(this.gameMinutes)}`);
        this.applyKeyframe(0);

        let lastTick = Date.now();
        this.timer = setInterval(() => {
            const now = Date.now();
            const prev = this.gameMinutes;
            // TIME_OF_DAY_MULT = 1 -> 1 игровая секунда за 1 реальную
            this.gameMinutes = (this.gameMinutes + ((now - lastTick) / 60000) * timeline.timeMult) % 1440;
            lastTick = now;

            const crossed = this.findCrossedKeyframe(prev, this.gameMinutes);
            if (crossed !== -1 && crossed !== this.activeIndex) this.applyKeyframe(crossed);
        }, 1000);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.activeIndex = -1;
    }

    // Индекс кадра, время которого попало в интервал (prev, curr], с учётом перехода через полночь
    findCrossedKeyframe(prev, curr) {
        const inRange = t => (prev <= curr ? t > prev && t <= curr : t > prev || t <= curr);
        let found = -1;
        this.timeline.keyframes.forEach((k, i) => { if (inRange(k.time)) found = i; });
        return found;
    }

    applyKeyframe(index) {
        const k = this.timeline?.keyframes[index];
        if (!k || !this.sendCommand) return false;
        this.activeIndex = index;
        const ok = this.sendCommand(`/setweather ${index}`);
        if (this.weatherFxEnabled) this.sendCommand(`/setcspweather ${WEATHER_FX_TYPES[k.type]} ${Math.round(k.transition)}`);
        if (this.onLog) this.onLog(`>>> [WEATHER] ${formatTime(k.time)} → ${k.type}, ${Math.round(k.ambient)}°C (${k.transition}s)`);
        return ok;
    }

    getState() {
        return { running: Boolean(this.timer), gameTime: formatTime(this.gameMinutes), activeIndex: this.activeIndex };
    }
}

module.exports = {
    WEATHER_FX_TYPES,
    DEFAULT_TIMELINE,
    normalizeTimeline,
    buildWeatherSections,
    applyTimelineToServerCfg,
    timelineFromServerCfg,
    formatTime,
    weatherScheduler: new WeatherScheduler()
};
