// Плановые рестарты с предупреждениями в чат и повторяющиеся сообщения для игроков.
// Работает только пока сервер запущен; сам рестарт выполняет main.js через колбэк restart().
const WARN_MINUTES = [10, 5, 1];

const DEFAULT_SCHEDULE = {
    restartEnabled: false,
    restartEveryHours: 6,
    messagesEnabled: false,
    messageIntervalMinutes: 15,
    messages: []
};

function normalizeSchedule(raw = {}) {
    const clampNum = (v, min, max, def) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : def);
    return {
        restartEnabled: Boolean(raw.restartEnabled),
        restartEveryHours: clampNum(raw.restartEveryHours, 1, 48, DEFAULT_SCHEDULE.restartEveryHours),
        messagesEnabled: Boolean(raw.messagesEnabled),
        messageIntervalMinutes: clampNum(raw.messageIntervalMinutes, 1, 240, DEFAULT_SCHEDULE.messageIntervalMinutes),
        messages: (Array.isArray(raw.messages) ? raw.messages : []).map(m => String(m).trim()).filter(Boolean).slice(0, 20)
    };
}

class ServerSchedule {
    constructor() {
        this.timers = [];
        this.nextRestartAt = 0;
    }

    // send(cmd) -> Promise<boolean>; restart() перезапускает сервер; onLog(code, params); warnText(min) — текст в чат на языке менеджера
    start(schedule, { send, restart, onLog, warnText }) {
        this.stop();
        const cfg = normalizeSchedule(schedule);

        if (cfg.restartEnabled) {
            const totalMs = cfg.restartEveryHours * 3600000;
            this.nextRestartAt = Date.now() + totalMs;
            for (const min of WARN_MINUTES) {
                const at = totalMs - min * 60000;
                if (at > 0) this.timers.push(setTimeout(() => send(`/say ${warnText(min)}`), at));
            }
            this.timers.push(setTimeout(() => { onLog('restart_now'); restart(); }, totalMs));
            onLog('restart_planned', { hours: cfg.restartEveryHours });
        }

        if (cfg.messagesEnabled && cfg.messages.length) {
            let idx = 0;
            this.timers.push(setInterval(() => {
                send(`/say ${cfg.messages[idx % cfg.messages.length]}`);
                idx++;
            }, cfg.messageIntervalMinutes * 60000));
        }
    }

    stop() {
        for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
        this.timers = [];
        this.nextRestartAt = 0;
    }

    getState() {
        return { nextRestartAt: this.nextRestartAt };
    }
}

module.exports = { normalizeSchedule, DEFAULT_SCHEDULE, serverSchedule: new ServerSchedule() };
