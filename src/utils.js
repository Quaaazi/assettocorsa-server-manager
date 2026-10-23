const { exec } = require('child_process');
const fs = require('fs');

const DEFAULT_SURFACES_INI = `[SURFACE_0]
KEY=ROAD
FRICTION=1
DAMPING=0
WAV=
WAV_PITCH=0
FF_EFFECT=NULL
DIRT_ADDITIVE=0
BLACK_FLAG_TIME=0
IS_VALID_TRACK=1
SIN_HEIGHT=0
SIN_LENGTH=0
IS_PITLANE=0
VIBRATION_GAIN=0
VIBRATION_LENGTH=0

[SURFACE_1]
KEY=GRASS
FRICTION=0.6
DAMPING=0
WAV=grass.wav
WAV_PITCH=0
FF_EFFECT=NULL
DIRT_ADDITIVE=1
IS_VALID_TRACK=0
BLACK_FLAG_TIME=0
SIN_HEIGHT=0.03
SIN_LENGTH=0.5
IS_PITLANE=0
VIBRATION_GAIN=0.2
VIBRATION_LENGTH=0.6

[SURFACE_2]
KEY=KERB
FRICTION=0.92
DAMPING=0
WAV=kerb.wav
WAV_PITCH=1.3
FF_EFFECT=1
DIRT_ADDITIVE=0
BLACK_FLAG_TIME=0
IS_VALID_TRACK=1
SIN_HEIGHT=0
SIN_LENGTH=0
IS_PITLANE=0
VIBRATION_GAIN=1.0
VIBRATION_LENGTH=1.5

[SURFACE_3]
KEY=SAND
FRICTION=0.8
DAMPING=0.1
WAV=sand.wav
WAV_PITCH=0
FF_EFFECT=0
DIRT_ADDITIVE=1
IS_VALID_TRACK=0
BLACK_FLAG_TIME=0
SIN_HEIGHT=0.04
SIN_LENGTH=0.5
IS_PITLANE=0
VIBRATION_GAIN=0.2
VIBRATION_LENGTH=0.3
`;

function parseAcIni(content) {
    const result = {};
    let currentSection = null;
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || isIniComment(line)) continue;
        if (line.startsWith('[') && line.endsWith(']')) {
            currentSection = line.slice(1, -1).trim();
            result[currentSection] = result[currentSection] || {};
        } else if (currentSection) {
            const eqIdx = line.indexOf('=');
            if (eqIdx !== -1) {
                const key = line.slice(0, eqIdx).trim();
                let val = line.slice(eqIdx + 1).trim();
                if (val.startsWith('"') && val.endsWith('"')) {
                    val = val.slice(1, -1);
                }
                result[currentSection][key] = val;
            }
        }
    }
    return result;
}

function stringifyAcIni(obj) {
    let out = '';
    for (const [section, keys] of Object.entries(obj)) {
        if (!keys || typeof keys !== 'object') continue;
        out += `[${section}]\r\n`;
        for (const [k, v] of Object.entries(keys)) {
            out += `${k}=${v !== undefined && v !== null ? v : ''}\r\n`;
        }
        out += '\r\n';
    }
    return out;
}

// В INI-файлах AC комментарии начинаются с ";" (иногда "//" или "#")
function isIniComment(line) {
    return line.startsWith(';') || line.startsWith('//') || line.startsWith('#');
}

const formatIniValue = v => (v !== undefined && v !== null ? v : '');

// Записывает obj поверх существующего текста INI: комментарии, пустые строки и порядок ключей сохраняются,
// значения обновляются, удалённые ключи/секции убираются, новые дописываются в конец своей секции.
function mergeAcIni(originalText, obj) {
    const out = [];
    const seenSections = new Set();
    let current = null;
    let skipSection = false;
    let written = new Set();

    const flushSection = () => {
        if (current === null || skipSection) return;
        const trailing = [];
        while (out.length && out[out.length - 1].trim() === '') trailing.unshift(out.pop());
        for (const [k, v] of Object.entries(obj[current] || {})) {
            if (!written.has(k)) out.push(`${k}=${formatIniValue(v)}`);
        }
        out.push(...(trailing.length ? trailing : ['']));
    };

    for (const raw of String(originalText || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[') && line.endsWith(']')) {
            flushSection();
            current = line.slice(1, -1).trim();
            skipSection = !(obj[current] && typeof obj[current] === 'object');
            written = new Set();
            if (!skipSection) { seenSections.add(current); out.push(raw); }
            continue;
        }
        if (skipSection) continue;
        if (current === null || !line || isIniComment(line)) { out.push(raw); continue; }

        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) { out.push(raw); continue; }
        const key = line.slice(0, eqIdx).trim();
        if (!(key in obj[current]) || written.has(key)) continue;
        out.push(`${key}=${formatIniValue(obj[current][key])}`);
        written.add(key);
    }
    flushSection();

    for (const [section, keys] of Object.entries(obj)) {
        if (seenSections.has(section) || !keys || typeof keys !== 'object') continue;
        if (out.length && out[out.length - 1].trim() !== '') out.push('');
        out.push(`[${section}]`);
        for (const [k, v] of Object.entries(keys)) out.push(`${k}=${formatIniValue(v)}`);
        out.push('');
    }
    while (out.length > 1 && out[out.length - 1].trim() === '' && out[out.length - 2].trim() === '') out.pop();
    return out.join('\r\n');
}

function extractArchiveSmart(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        exec(`tar -xf "${archivePath}" -C "${destDir}"`, (err) => {
            if (!err && fs.readdirSync(destDir).length > 0) return resolve();

            const tools = [
                'C:\\Program Files\\7-Zip\\7z.exe',
                'C:\\Program Files (x86)\\7-Zip\\7z.exe',
                'C:\\Program Files\\WinRAR\\WinRAR.exe',
                'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe'
            ];

            const foundTool = tools.find(t => fs.existsSync(t));
            if (foundTool) {
                const cmd = foundTool.toLowerCase().includes('winrar')
                    ? `"${foundTool}" x -ibck -y "${archivePath}" "${destDir}\\"`
                    : `"${foundTool}" x "${archivePath}" -o"${destDir}" -y`;

                exec(cmd, (err2) => {
                    if (!err2 && fs.readdirSync(destDir).length > 0) return resolve();
                    reject(new Error('Не удалось распаковать архив с помощью найденной программы.'));
                });
            } else if (archivePath.toLowerCase().endsWith('.zip')) {
                exec(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, (err3) => {
                    if (!err3) return resolve();
                    reject(new Error('Ошибка PowerShell при распаковке ZIP.'));
                });
            } else {
                reject(new Error('Не найден распаковщик (установите 7-Zip или WinRAR).'));
            }
        });
    });
}

module.exports = {
    DEFAULT_SURFACES_INI,
    parseAcIni,
    stringifyAcIni,
    mergeAcIni,
    extractArchiveSmart
};