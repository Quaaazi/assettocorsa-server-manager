const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const yaml = require('yaml');

// Подключаем вынесенные модули
const { DEFAULT_SURFACES_INI, parseAcIni, stringifyAcIni, mergeAcIni, extractArchiveSmart } = require('./src/utils.js');
const liveMonitor = require('./src/live-monitor.js');
const discordWebhook = require('./src/discord-webhook.js');
const weatherTimeline = require('./src/weather-timeline.js');
const rcon = require('./src/rcon-client.js');
const diagnostics = require('./src/diagnostics.js');
const backups = require('./src/backups.js');
const accessLists = require('./src/access-lists.js');
const playerHistory = require('./src/player-history.js');
const { serverSchedule, normalizeSchedule } = require('./src/server-schedule.js');
const i18n = require('./src/i18n.js');

// Сообщения main-процесса переводятся тем же словарём, что и интерфейс
const T = text => i18n.t(text);

let mainWindow;
let serverProcess = null;
let isManualStop = false;
let autoRestartEnabled = false;
let restartTimeout = null;

const APP_CONFIG_PATH = path.join(app.getPath('userData'), 'launcher_config.json');

const SERVER_DIR = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'server_instance')
    : path.join(app.getAppPath(), 'server_instance');

const PROFILES_DIR = path.join(SERVER_DIR, 'profiles');

function loadLauncherConfig() {
    if (fs.existsSync(APP_CONFIG_PATH)) {
        try { return JSON.parse(fs.readFileSync(APP_CONFIG_PATH, 'utf-8')); } 
        catch (e) { return {}; }
    }
    return {};
}

function saveLauncherConfig(data) {
    const current = loadLauncherConfig();
    fs.writeFileSync(APP_CONFIG_PATH, JSON.stringify({ ...current, ...data }, null, 2), 'utf-8');
}

function createWindow() {
    const iconPath = fs.existsSync(path.join(__dirname, 'icon.ico')) 
        ? path.join(__dirname, 'icon.ico') 
        : path.join(__dirname, 'icon.png');

    mainWindow = new BrowserWindow({
        width: 1240,
        height: 820,
        minWidth: 1024,
        minHeight: 680,
        frame: false,
        backgroundColor: '#090a0d',
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    mainWindow.loadFile('index.html');

    const cfg = loadLauncherConfig();
    discordWebhook.configure({
        url: cfg.webhookUrl || '',
        enabled: cfg.webhookEnabled || false
    });

    i18n.setLang(cfg.language || 'ru');
    autoRestartEnabled = Boolean(cfg.autoRestart);
    playerHistory.init(SERVER_DIR);
    rcon.onStatus = connected => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('live:rconStatus', { connected }); };

    liveMonitor.init(mainWindow, SERVER_DIR, {
        onConnect: (player, count) => {
            playerHistory.onConnect(player);
            discordWebhook.notifyPlayerConnect(player, count);
        },
        onDisconnect: (name, count, player) => {
            playerHistory.onDisconnect(player);
            discordWebhook.notifyPlayerDisconnect(name, count);
        }
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    isManualStop = true;
    stopServerProcess();
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('win:minimize', () => mainWindow.minimize());
ipcMain.on('win:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow.close());

ipcMain.on('launcher:saveTheme', (e, theme) => saveLauncherConfig({ theme }));
ipcMain.on('launcher:saveLanguage', (e, lang) => {
    saveLauncherConfig({ language: lang });
    i18n.setLang(lang);
});

ipcMain.handle('webhook:save', (e, { url, enabled }) => {
    saveLauncherConfig({ webhookUrl: url, webhookEnabled: enabled });
    discordWebhook.configure({ url, enabled });
    return { success: true };
});

ipcMain.handle('webhook:test', async (e, { url }) => {
    discordWebhook.configure({ url, enabled: true });
    const ok = await discordWebhook.sendEmbed({
        title: `🔔 ${T('Тестовое уведомление!')}`,
        description: T('Интеграция **Assetto Corsa Server Manager** с Discord успешно настроена и работает!'),
        color: 0x3b82f6
    });
    const cfg = loadLauncherConfig();
    discordWebhook.configure({ url: cfg.webhookUrl || url, enabled: cfg.webhookEnabled ?? true });
    return { success: ok };
});

function autoDetectAssettoCorsa() {
    const candidates = new Set();
    const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

    const vdfLocations = [
        'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf',
        'C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf',
        'D:\\Steam\\steamapps\\libraryfolders.vdf'
    ];

    for (const vdf of vdfLocations) {
        if (fs.existsSync(vdf)) {
            try {
                const content = fs.readFileSync(vdf, 'utf-8');
                const matches = content.matchAll(/"path"\s+"([^"]+)"/g);
                for (const m of matches) {
                    const libPath = m[1].replace(/\\\\/g, '\\');
                    candidates.add(path.join(libPath, 'steamapps', 'common', 'assettocorsa'));
                }
            } catch (e) {}
        }
    }

    for (const d of drives) {
        candidates.add(`${d}:\\Program Files (x86)\\Steam\\steamapps\\common\\assettocorsa`);
        candidates.add(`${d}:\\Program Files\\Steam\\steamapps\\common\\assettocorsa`);
        candidates.add(`${d}:\\SteamLibrary\\steamapps\\common\\assettocorsa`);
        candidates.add(`${d}:\\Steam\\steamapps\\common\\assettocorsa`);
        candidates.add(`${d}:\\Games\\Steam\\steamapps\\common\\assettocorsa`);
        candidates.add(`${d}:\\Games\\assettocorsa`);
        candidates.add(`${d}:\\assettocorsa`);
    }

    for (const folder of candidates) {
        try {
            if (fs.existsSync(path.join(folder, 'assettocorsa.exe')) || 
                fs.existsSync(path.join(folder, 'content', 'cars'))) {
                return folder;
            }
        } catch (e) {}
    }
    return null;
}

ipcMain.handle('launcher:init', async () => {
    const config = loadLauncherConfig();
    let acPath = config.acPath || '';
    let autoDetected = false;

    if (!acPath || !fs.existsSync(acPath)) {
        const found = autoDetectAssettoCorsa();
        if (found) {
            acPath = found;
            autoDetected = true;
            saveLauncherConfig({ acPath });
        }
    }

    const isInitialized = fs.existsSync(path.join(SERVER_DIR, 'cfg', 'server_cfg.ini'));
    const hasServerExe = fs.existsSync(path.join(SERVER_DIR, 'AssettoServer.exe'));

    return {
        acPath,
        autoDetected,
        serverDir: SERVER_DIR,
        installedVersion: config.serverVersion || T('Не установлен'),
        autoRestart: config.autoRestart || false,
        theme: config.theme || 'dark',
        language: config.language || 'ru',
        webhookUrl: config.webhookUrl || '',
        webhookEnabled: config.webhookEnabled || false,
        isInitialized,
        hasServerExe
    };
});

ipcMain.handle('launcher:autoDetectAC', () => autoDetectAssettoCorsa());

ipcMain.handle('dialog:selectFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: T('Выберите корневую папку Assetto Corsa')
    });
    return canceled ? null : filePaths[0];
});

ipcMain.handle('track:importAiFile', async (e, { trackId, trackConfig }) => {
    const { acPath } = loadLauncherConfig();
    if (!acPath || !trackId) return { success: false, error: T('Не выбрана папка игры или карта') };

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: T('Выберите архив с трафиком (.7z, .zip, .rar) или файл fast_lane.ai'),
        filters: [
            { name: T('Трафик (Архивы и AI файлы)'), extensions: ['7z', 'zip', 'rar', 'ai', 'aip', 'aic1'] },
            { name: T('Архивы (.7z, .zip, .rar)'), extensions: ['7z', 'zip', 'rar'] },
            { name: T('Файлы траекторий (.ai, .aip)'), extensions: ['ai', 'aip', 'aic1'] }
        ]
    });

    if (canceled || !filePaths[0]) return { canceled: true };

    const srcFile = filePaths[0];
    const ext = path.extname(srcFile).toLowerCase();
    const trackDir = path.join(acPath, 'content', 'tracks', trackId);

    try {
        if (['.ai', '.aip', '.aic1'].includes(ext)) {
            const destFileName = ext === '.aip' ? 'fast_lane.aip' : (ext === '.aic1' ? path.basename(srcFile) : 'fast_lane.ai');
            const rootAiDir = path.join(trackDir, 'ai');
            fs.mkdirSync(rootAiDir, { recursive: true });
            fs.copyFileSync(srcFile, path.join(rootAiDir, destFileName));

            if (trackConfig) {
                const cfgAiDir = path.join(trackDir, trackConfig, 'ai');
                fs.mkdirSync(cfgAiDir, { recursive: true });
                fs.copyFileSync(srcFile, path.join(cfgAiDir, destFileName));
            }
            return { success: true };
        }

        const tempExtractDir = path.join(SERVER_DIR, `temp_ai_import_${Date.now()}`);
        fs.mkdirSync(tempExtractDir, { recursive: true });

        try {
            await extractArchiveSmart(srcFile, tempExtractDir);
            const processExtractedFolder = (currentDir) => {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(currentDir, entry.name);
                    if (entry.isDirectory()) {
                        const folderName = entry.name.toLowerCase();
                        if (folderName.includes('_pa') || folderName.includes('layout') || folderName === 'ai') {
                            copyFolderRecursiveSync(fullPath, path.join(trackDir, entry.name));
                        } else {
                            processExtractedFolder(fullPath);
                        }
                    }
                }
            };
            processExtractedFolder(tempExtractDir);

            const bestAi = findBestAiFolderInTrack(trackDir, trackConfig);
            if (bestAi) {
                copyFolderRecursiveSync(bestAi, path.join(trackDir, 'ai'));
                if (trackConfig) copyFolderRecursiveSync(bestAi, path.join(trackDir, trackConfig, 'ai'));
            }

            return { success: true };
        } finally {
            if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('shell:openFolder', (e, folderPath) => {
    if (typeof folderPath === 'string' && fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) shell.openPath(folderPath);
});

// Внешние ссылки открываем только по http(s), чтобы описание сервера не могло запустить file:// или протоколы приложений
ipcMain.handle('shell:openExternal', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
});

ipcMain.on('shell:showItemInFolder', (e, filePath) => {
    if (typeof filePath === 'string' && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

ipcMain.handle('fs:isAcFolder', (e, folder) => {
    if (typeof folder !== 'string' || !folder) return false;
    return fs.existsSync(path.join(folder, 'assettocorsa.exe')) || fs.existsSync(path.join(folder, 'content'));
});

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'AssettoCorsa-ServerManager' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) return resolve(httpsGetJson(res.headers.location));
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(T('Ошибка ответа GitHub'))); }
            });
        }).on('error', reject);
    });
}

function downloadFileWithRedirects(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'AssettoCorsa-ServerManager' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) return resolve(downloadFileWithRedirects(res.headers.location, destPath, onProgress));
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

            const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
            let downloadedBytes = 0;
            const fileStream = fs.createWriteStream(destPath);

            res.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes > 0 && onProgress) onProgress(Math.round((downloadedBytes / totalBytes) * 100));
            });

            res.pipe(fileStream);
            fileStream.on('finish', () => fileStream.close(resolve));
            fileStream.on('error', reject);
        }).on('error', reject);
    });
}

ipcMain.handle('server:downloadUpdate', async () => {
    try {
        isManualStop = true;
        stopServerProcess();
        mainWindow.webContents.send('download:progress', { percent: 5, text: T('Проверка релизов на GitHub...') });

        const release = await httpsGetJson('https://api.github.com/repos/compujuckel/AssettoServer/releases/latest');
        const tag = release.tag_name || 'Latest';
        const asset = (release.assets || []).find(a => a.name.includes('win-x64') && a.name.endsWith('.zip'));

        if (!asset) throw new Error(T('Файл win-x64.zip не найден на GitHub.'));

        fs.mkdirSync(SERVER_DIR, { recursive: true });
        const zipPath = path.join(SERVER_DIR, 'as_update_temp.zip');
        const extractDir = path.join(SERVER_DIR, 'as_extract_temp');

        mainWindow.webContents.send('download:progress', { percent: 15, text: `${T('Скачивание')} AssettoServer ${tag}...` });

        await downloadFileWithRedirects(asset.browser_download_url, zipPath, (p) => {
            const scaled = 15 + Math.round(p * 0.7);
            mainWindow.webContents.send('download:progress', { percent: scaled, text: `${T('Скачивание')}: ${p}%` });
        });

        mainWindow.webContents.send('download:progress', { percent: 85, text: T('Распаковка архива...') });

        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });

        await extractArchiveSmart(zipPath, extractDir);

        const copyUpdateFiles = (src, dest) => {
            fs.mkdirSync(dest, { recursive: true });
            for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                const s = path.join(src, entry.name);
                const d = path.join(dest, entry.name);
                if (entry.isDirectory()) copyUpdateFiles(s, d);
                else {
                    if (dest.endsWith('cfg') && fs.existsSync(d)) continue;
                    fs.copyFileSync(s, d);
                }
            }
        };

        copyUpdateFiles(extractDir, SERVER_DIR);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });

        saveLauncherConfig({ serverVersion: tag });
        mainWindow.webContents.send('download:progress', { percent: 100, text: `AssettoServer ${tag} ${T('установлен!')}` });
        return { success: true, version: tag };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('server:setup', async (e, acPath) => {
    try {
        const cfgDir = path.join(SERVER_DIR, 'cfg');
        const systemDataDir = path.join(SERVER_DIR, 'system', 'data');
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.mkdirSync(systemDataDir, { recursive: true });
        fs.mkdirSync(PROFILES_DIR, { recursive: true });

        const steamDllSrc = path.join(acPath, 'steam_api64.dll');
        if (fs.existsSync(steamDllSrc)) {
            fs.copyFileSync(steamDllSrc, path.join(SERVER_DIR, 'steam_api64.dll'));
        }

        const surfacesSrc = path.join(acPath, 'system', 'data', 'surfaces.ini');
        if (fs.existsSync(surfacesSrc)) {
            fs.copyFileSync(surfacesSrc, path.join(systemDataDir, 'surfaces.ini'));
        } else {
            fs.writeFileSync(path.join(systemDataDir, 'surfaces.ini'), DEFAULT_SURFACES_INI, 'utf-8');
        }

        const serverCfgPath = path.join(cfgDir, 'server_cfg.ini');
        if (!fs.existsSync(serverCfgPath)) {
            const defaultIni = {
                SERVER: {
                    NAME: 'Assetto Corsa Server', ADMIN_PASSWORD: 'adminpassword123', UDP_PORT: 9600, TCP_PORT: 9600, HTTP_PORT: 8081,
                    MAX_CLIENTS: 20, REGISTER_TO_LOBBY: 0, LOOP_MODE: 1, PICKUP_MODE_ENABLED: 1, LOCKED_ENTRY_LIST: 0, CLIENT_SEND_INTERVAL_HZ: 60,
                    NUM_THREADS: 4, ABS_ALLOWED: 1, TC_ALLOWED: 1, STABILITY_ALLOWED: 0, AUTOCLUTCH_ALLOWED: 1, TYRE_BLANKETS_ALLOWED: 1,
                    FORCE_VIRTUAL_MIRROR: 0, FUEL_RATE: 0, DAMAGE_MULTIPLIER: 0, TYRE_WEAR_RATE: 0, ALLOWED_TYRES_OUT: 4, MAX_BALLAST_KG: 0,
                    START_RULE: 0, RACE_GAS_PENALTY_DISABLED: 0, SUN_ANGLE: -80, TIME_OF_DAY_MULT: 1, KICK_QUORUM: 85, VOTING_QUORUM: 80,
                    VOTE_DURATION: 20, BLACKLIST_MODE: 1, MAX_CONTACTS_PER_KM: -1, SLEEP_TIME: 1, QUALIFY_MAX_WAIT_PERC: 120, RACE_EXTRA_LAP: 0,
                    REVERSED_GRID_RACE_POSITIONS: 0, RACE_OVER_TIME: 60, RESULT_SCREEN_TIME: 60, TRACK: '', CONFIG_TRACK: '', CARS: ''
                },
                PRACTICE: { NAME: 'Practice', TIME: 500, IS_OPEN: 1 },
                WEATHER_0: { GRAPHICS: '3_clear', BASE_TEMPERATURE_AMBIENT: 18, BASE_TEMPERATURE_ROAD: 22, VARIATION_AMBIENT: 1, VARIATION_ROAD: 1, WIND_BASE_SPEED_MIN: 0, WIND_BASE_SPEED_MAX: 0, WIND_BASE_DIRECTION: 0, WIND_VARIATION_DIRECTION: 0 }
            };
            fs.writeFileSync(serverCfgPath, stringifyAcIni(defaultIni), 'utf-8');
        }

        const extraCfgPath = path.join(cfgDir, 'extra_cfg.yml');
        if (!fs.existsSync(extraCfgPath)) {
            const defaultYaml = {
                UseSteamAuth: false, EnableAntiAfk: true, MaxAfkTimeMinutes: 10, AfkKickBehavior: 'PlayerInput', MaxPing: 500, MaxPingSeconds: 10, ForceLights: false, DisableWrongWayPenalty: false,
                NetworkBubbleDistance: 500, OutsideNetworkBubbleRefreshRateHz: 4, EnableServerDetails: true, ServerDescription: 'Powered by Assetto Corsa: Server Manager', EnableRealTime: false, EnableWeatherFx: true, RainTrackGripReductionPercent: 0, EnableAi: true,
                IgnoreConfigurationErrors: { MissingCarChecksums: true, MissingTrackParams: true, WrongServerDetails: true, UnsafeAdminWhitelist: true },
                AiParams: { PlayerRadiusMeters: 200, PlayerPositionOffsetMeters: 100, PlayerAfkTimeoutSeconds: 10, MaxPlayerDistanceToAiSplineMeters: 15, MinSpawnDistancePoints: 50, MaxSpawnDistancePoints: 400, MinAiSafetyDistanceMeters: 10, MaxAiSafetyDistanceMeters: 70, StateSpawnDistanceMeters: 1000, MinStateDistanceMeters: 200, StateTieBreakerDistanceMeters: 250, SpawnSafetyDistanceToPlayerMeters: 100, MinSpawnProtectionTimeSeconds: 4, MaxSpawnProtectionTimeSeconds: 8, MinCollisionStopTimeSeconds: 1, MaxCollisionStopTimeSeconds: 3, MaxSpeedKph: 80, RightLaneOffsetKph: 15, MaxSpeedVariationPercent: 0.15, DefaultDeceleration: 8.5, DefaultAcceleration: 2.5, MaxAiTargetCount: 250, AiPerPlayerTargetCount: 30, HideAiCars: true, TwoWayTraffic: false, NamePrefix: 'Traffic' }
            };
            fs.writeFileSync(extraCfgPath, yaml.stringify(defaultYaml), 'utf-8');
        }

        saveLauncherConfig({ acPath });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

function hasAiSplineFiles(aiFolderPath) {
    if (!fs.existsSync(aiFolderPath)) return false;
    try {
        const files = fs.readdirSync(aiFolderPath).map(f => f.toLowerCase());
        if (files.includes('traffic.json')) return true;
        if (files.some(f => f.endsWith('.ai') || f.endsWith('.aip') || f.endsWith('.aic1'))) return true;
        const dataPath = path.join(aiFolderPath, 'data');
        if (fs.existsSync(dataPath)) {
            const dataFiles = fs.readdirSync(dataPath).map(f => f.toLowerCase());
            if (dataFiles.includes('traffic.json') || dataFiles.some(f => f.endsWith('.ai') || f.endsWith('.aip'))) return true;
        }
    } catch (e) {}
    return false;
}

function findBestAiFolderInTrack(trackPath, preferredConfig = '', allTracksRoot = '') {
    const checkFolder = (folder) => {
        if (hasAiSplineFiles(folder)) return folder;
        if (hasAiSplineFiles(path.join(folder, 'data'))) return path.join(folder, 'data');
        return null;
    };

    if (preferredConfig && checkFolder(path.join(trackPath, preferredConfig))) return path.join(trackPath, preferredConfig);
    if (checkFolder(trackPath)) return trackPath;

    const searchRecursive = (dirPath, maxDepth = 3) => {
        if (maxDepth < 0 || !fs.existsSync(dirPath)) return null;
        if (hasAiSplineFiles(dirPath)) return dirPath;
        try {
            for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
                if (entry.isDirectory() && !['ui', 'skins', 'texture'].includes(entry.name)) {
                    const found = searchRecursive(path.join(dirPath, entry.name), maxDepth - 1);
                    if (found) return found;
                }
            }
        } catch (e) {}
        return null;
    };

    const insideTrack = searchRecursive(trackPath, 3);
    if (insideTrack) return insideTrack;

    const trackId = path.basename(trackPath);
    const insideServer = searchRecursive(path.join(SERVER_DIR, 'content', 'tracks', trackId), 3);
    if (insideServer) return insideServer;

    if (allTracksRoot && fs.existsSync(allTracksRoot)) {
        const prefix = trackId.split('_')[0].toLowerCase();
        if (prefix.length >= 3 && prefix !== 'ks') {
            try {
                for (const sib of fs.readdirSync(allTracksRoot, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.toLowerCase().startsWith(prefix) && d.name !== trackId)) {
                    const sibFound = searchRecursive(path.join(allTracksRoot, sib.name), 3);
                    if (sibFound) return sibFound;
                }
            } catch (e) {}
        }
    }
    return null;
}

function findTrackPreview(trackPath, layoutName = '') {
    const exts = ['png', 'jpg', 'jpeg'];
    const checkPaths = [];
    if (layoutName) exts.forEach(ext => checkPaths.push(path.join(trackPath, 'ui', layoutName, `preview.${ext}`)));
    exts.forEach(ext => checkPaths.push(path.join(trackPath, 'ui', `preview.${ext}`)));
    exts.forEach(ext => checkPaths.push(path.join(trackPath, `preview.${ext}`)));
    if (layoutName) {
        exts.forEach(ext => checkPaths.push(path.join(trackPath, layoutName, `preview.${ext}`)));
        exts.forEach(ext => checkPaths.push(path.join(trackPath, layoutName, 'ui', `preview.${ext}`)));
    }
    try {
        const uiDir = path.join(trackPath, 'ui');
        if (fs.existsSync(uiDir)) {
            const found = fs.readdirSync(uiDir).find(f => f.toLowerCase().startsWith('preview.') && exts.some(ext => f.toLowerCase().endsWith(ext)));
            if (found) checkPaths.push(path.join(uiDir, found));
        }
    } catch(e) {}

    for (const p of checkPaths) {
        if (fs.existsSync(p)) return `file://${p.replace(/\\/g, '/')}`;
    }
    return '';
}

ipcMain.handle('content:scan', async () => {
    const { acPath } = loadLauncherConfig();
    if (!acPath || !fs.existsSync(acPath)) return { cars: [], tracks: [] };

    const carsDir = path.join(acPath, 'content', 'cars');
    const tracksDir = path.join(acPath, 'content', 'tracks');
    const cars = [];
    const tracks = [];

    if (fs.existsSync(carsDir)) {
        for (const dir of fs.readdirSync(carsDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
            const carId = dir.name;
            const carPath = path.join(carsDir, carId);
            if (!fs.existsSync(path.join(carPath, 'data.acd')) && !fs.existsSync(path.join(carPath, 'data'))) continue;

            let carName = carId;
            let brand = '';
            let tags = [];
            
            if (fs.existsSync(path.join(carPath, 'ui', 'ui_car.json'))) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(path.join(carPath, 'ui', 'ui_car.json'), 'utf-8').replace(/[\u0000-\u0019]+/g, " "));
                    if (parsed.name) carName = parsed.name;
                    if (parsed.brand) brand = parsed.brand;
                    if (Array.isArray(parsed.tags)) tags = parsed.tags.map(t => String(t).toLowerCase());
                } catch (e) {}
            }

            let skins = [];
            let previewUrl = '';
            if (fs.existsSync(path.join(carPath, 'skins'))) {
                skins = fs.readdirSync(path.join(carPath, 'skins'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
                for (const s of skins) {
                    if (fs.existsSync(path.join(carPath, 'skins', s, 'preview.jpg'))) { previewUrl = `file://${path.join(carPath, 'skins', s, 'preview.jpg').replace(/\\/g, '/')}`; break; }
                    if (fs.existsSync(path.join(carPath, 'skins', s, 'preview.png'))) { previewUrl = `file://${path.join(carPath, 'skins', s, 'preview.png').replace(/\\/g, '/')}`; break; }
                }
            }

            const badgeFile = path.join(carPath, 'ui', 'badge.png');
            cars.push({ id: carId, name: carName, brand, skins, previewUrl, badgeUrl: fs.existsSync(badgeFile) ? `file://${badgeFile.replace(/\\/g, '/')}` : '', isTraffic: carId.toLowerCase().includes('traffic') || carName.toLowerCase().includes('traffic') || tags.some(t => t.includes('traffic')) });
        }
    }

    if (fs.existsSync(tracksDir)) {
        for (const dir of fs.readdirSync(tracksDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
            const trackId = dir.name;
            const trackPath = path.join(tracksDir, trackId);
            const layouts = [];
            const trackFamilyHasAi = Boolean(findBestAiFolderInTrack(trackPath, '', tracksDir));

            if (fs.existsSync(path.join(trackPath, 'ui'))) {
                for (const sub of fs.readdirSync(path.join(trackPath, 'ui'), { withFileTypes: true }).filter(d => d.isDirectory())) {
                    if (fs.existsSync(path.join(trackPath, 'ui', sub.name, 'ui_track.json'))) {
                        let lName = `${trackId} (${sub.name})`;
                        try {
                            const parsed = JSON.parse(fs.readFileSync(path.join(trackPath, 'ui', sub.name, 'ui_track.json'), 'utf-8').replace(/[\u0000-\u0019]+/g, ' '));
                            if (parsed.name) lName = parsed.name;
                        } catch (e) {}
                        layouts.push({ config: sub.name, name: lName, hasAi: Boolean(findBestAiFolderInTrack(trackPath, sub.name, tracksDir)) || trackFamilyHasAi, previewUrl: findTrackPreview(trackPath, sub.name) });
                    }
                }
                const rootUiJson = path.join(trackPath, 'ui', 'ui_track.json');
                if (fs.existsSync(rootUiJson) && (layouts.length === 0 || fs.existsSync(path.join(trackPath, 'models.ini')) || fs.existsSync(path.join(trackPath, `${trackId}.kn5`)))) {
                    let tName = trackId;
                    try {
                        const parsed = JSON.parse(fs.readFileSync(rootUiJson, 'utf-8').replace(/[\u0000-\u0019]+/g, ' '));
                        if (parsed.name) tName = parsed.name;
                    } catch (e) {}
                    layouts.unshift({ config: '', name: tName, hasAi: hasAiSplineFiles(path.join(trackPath, 'ai')) || (layouts.length === 0 && trackFamilyHasAi), previewUrl: findTrackPreview(trackPath, '') });
                }
            }
            if (layouts.length === 0) layouts.push({ config: '', name: trackId, hasAi: trackFamilyHasAi, previewUrl: findTrackPreview(trackPath, '') });
            tracks.push({ id: trackId, layouts });
        }
    }
    return { cars, tracks };
});

ipcMain.handle('config:load', () => {
    const serverCfg = fs.existsSync(path.join(SERVER_DIR, 'cfg', 'server_cfg.ini')) ? parseAcIni(fs.readFileSync(path.join(SERVER_DIR, 'cfg', 'server_cfg.ini'), 'utf-8')) : {};
    const extraCfg = fs.existsSync(path.join(SERVER_DIR, 'cfg', 'extra_cfg.yml')) ? yaml.parse(fs.readFileSync(path.join(SERVER_DIR, 'cfg', 'extra_cfg.yml'), 'utf-8')) : {};
    let preset = null;
    try { if (fs.existsSync(path.join(SERVER_DIR, 'cfg', 'manager_preset.json'))) preset = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'cfg', 'manager_preset.json'), 'utf-8')); } catch (e) {}
    let weather = null;
    try { if (fs.existsSync(path.join(SERVER_DIR, 'cfg', 'weather_timeline.json'))) weather = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'cfg', 'weather_timeline.json'), 'utf-8')); } catch (e) {}
    const timeline = weather ? weatherTimeline.normalizeTimeline(weather) : weatherTimeline.timelineFromServerCfg(serverCfg);
    return { serverCfg, extraCfg, preset, weatherTimeline: timeline };
});

ipcMain.handle('config:save', async (e, { serverCfg, extraCfg, playerCars, trafficCars, weatherTimeline: rawTimeline }) => {
    try {
        const { acPath } = loadLauncherConfig();
        const cfgDir = path.join(SERVER_DIR, 'cfg');
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.mkdirSync(path.join(SERVER_DIR, 'system', 'data'), { recursive: true });

        if (!serverCfg.SERVER) serverCfg.SERVER = {};
        // Пароль больше не дополняется молча: AssettoServer требует минимум 8 символов, сообщаем об этом явно
        const currentPass = String(serverCfg.SERVER.ADMIN_PASSWORD || '').trim();
        if (currentPass.length < 8) return { success: false, error: 'admin_password_short' };

        // Снимок текущих настроек до перезаписи (одинаковые подряд не дублируются)
        try { backups.createSnapshot(SERVER_DIR, { kind: 'auto', reason: 'save' }); } catch (err) {}

        const tracksRoot = acPath ? path.join(acPath, 'content', 'tracks') : '';
        const srcTrackDir = tracksRoot ? path.join(tracksRoot, serverCfg.SERVER.TRACK) : '';
        const bestAiSrc = srcTrackDir ? findBestAiFolderInTrack(srcTrackDir, serverCfg.SERVER.CONFIG_TRACK, tracksRoot) : null;

        extraCfg.EnableAi = Boolean(bestAiSrc) && extraCfg.EnableAi && trafficCars.length > 0;
        // IgnoreConfigurationErrors больше не навязывается: его задаёт переключатель на вкладке «Настройки сервера»

        const uniqueCarIds = [...new Set([...playerCars.map(c => c.id), ...(extraCfg.EnableAi ? trafficCars.map(c => c.id) : [])])];
        serverCfg.SERVER.CARS = uniqueCarIds.join(';');

        const entryList = {};
        let carIndex = 0;

        for (const car of playerCars) {
            const skins = car.skins && car.skins.length > 0 ? car.skins : ['default'];
            const count = Math.max(1, parseInt(car.slots) || 1);
            for (let i = 0; i < count; i++) {
                // Скины раздаются по кругу: entry_list.ini не меняется, если настройки не менялись
                entryList[`CAR_${carIndex++}`] = { MODEL: car.id, SKIN: skins[i % skins.length], SPECTATOR_MODE: 0, DRIVERNAME: '', TEAM: '', GUID: '', BALLAST: 0, RESTRICTOR: 0 };
            }
        }

        if (extraCfg.EnableAi && trafficCars.length > 0) {
            let addedAiEntries = 0;
            for (const car of trafficCars) {
                if (addedAiEntries >= 65) break;
                const skins = car.skins && car.skins.length > 0 ? car.skins : ['default'];
                const count = trafficCars.length > 25 ? Math.min(Math.max(1, parseInt(car.slots) || 1), 2) : Math.max(1, parseInt(car.slots) || 1);
                for (let i = 0; i < count; i++) {
                    if (addedAiEntries >= 65) break;
                    entryList[`CAR_${carIndex++}`] = { MODEL: car.id, SKIN: skins[i % skins.length], SPECTATOR_MODE: 0, DRIVERNAME: '', TEAM: '', GUID: '', BALLAST: 0, RESTRICTOR: 0, AI: 'fixed' };
                    addedAiEntries++;
                }
            }
        }

        serverCfg.SERVER.MAX_CLIENTS = Math.max(carIndex, 2);

        if (acPath && fs.existsSync(acPath)) {
            sendSaveProgress('track');
            const sysSurfDest = path.join(SERVER_DIR, 'system', 'data', 'surfaces.ini');
            if (!fs.existsSync(sysSurfDest)) {
                if (fs.existsSync(path.join(acPath, 'system', 'data', 'surfaces.ini'))) await copyFileIfChanged(path.join(acPath, 'system', 'data', 'surfaces.ini'), sysSurfDest);
                else fs.writeFileSync(sysSurfDest, DEFAULT_SURFACES_INI, 'utf-8');
            }

            const destTrackDir = path.join(SERVER_DIR, 'content', 'tracks', serverCfg.SERVER.TRACK);
            if (serverCfg.SERVER.TRACK && fs.existsSync(srcTrackDir)) {
                fs.mkdirSync(destTrackDir, { recursive: true });
                for (const f of fs.readdirSync(srcTrackDir, { withFileTypes: true })) {
                    if (f.isFile() && f.name.endsWith('.ini')) await copyFileIfChanged(path.join(srcTrackDir, f.name), path.join(destTrackDir, f.name));
                }
                await copyFolderAsync(path.join(srcTrackDir, 'ui'), path.join(destTrackDir, 'ui'));

                if (bestAiSrc) {
                    await copyFolderAsync(bestAiSrc, path.join(destTrackDir, 'ai'));
                    if (serverCfg.SERVER.CONFIG_TRACK) await copyFolderAsync(bestAiSrc, path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'ai'));

                    const findAllSplines = (dir, filesList = []) => {
                        if (!fs.existsSync(dir)) return filesList;
                        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                            if (f.isDirectory() && !['skins', 'texture', 'ui', 'sfx', 'showroom'].includes(f.name.toLowerCase())) findAllSplines(path.join(dir, f.name), filesList);
                            else if (f.name.toLowerCase().match(/\.(ai|aip|aic1)$/)) filesList.push(path.join(dir, f.name));
                        }
                        return filesList;
                    };

                    let allSplines = findAllSplines(srcTrackDir);
                    if (allSplines.length > 0) {
                        fs.mkdirSync(path.join(destTrackDir, 'ai'), { recursive: true });
                        await copyFileIfChanged(allSplines[0], path.join(destTrackDir, 'ai', 'fast_lane.ai'));
                        if (serverCfg.SERVER.CONFIG_TRACK) {
                            fs.mkdirSync(path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'ai'), { recursive: true });
                            await copyFileIfChanged(allSplines[0], path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'ai', 'fast_lane.ai'));
                        }
                    } else {
                        fs.mkdirSync(path.join(destTrackDir, 'ai'), { recursive: true });
                        fs.writeFileSync(path.join(destTrackDir, 'ai', 'fast_lane.ai'), Buffer.alloc(0));
                        if (!fs.existsSync(path.join(destTrackDir, 'ai', 'traffic.json'))) fs.writeFileSync(path.join(destTrackDir, 'ai', 'traffic.json'), JSON.stringify({}));
                        if (serverCfg.SERVER.CONFIG_TRACK) {
                            fs.mkdirSync(path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'ai'), { recursive: true });
                            fs.writeFileSync(path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'ai', 'fast_lane.ai'), Buffer.alloc(0));
                            if (!fs.existsSync(path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'ai', 'traffic.json'))) fs.writeFileSync(path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'ai', 'traffic.json'), JSON.stringify({}));
                        }
                    }
                }

                if (fs.existsSync(path.join(srcTrackDir, 'data'))) {
                    await copyFolderAsync(path.join(srcTrackDir, 'data'), path.join(destTrackDir, 'data'));
                    if (serverCfg.SERVER.CONFIG_TRACK) await copyFolderAsync(path.join(srcTrackDir, 'data'), path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'data'));
                }
                if (serverCfg.SERVER.CONFIG_TRACK && fs.existsSync(path.join(srcTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'data'))) {
                    await copyFolderAsync(path.join(srcTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'data'), path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'data'));
                    await copyFolderAsync(path.join(srcTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'data'), path.join(destTrackDir, 'data'));
                }

                if (!fs.existsSync(path.join(destTrackDir, 'data', 'surfaces.ini'))) {
                    fs.mkdirSync(path.join(destTrackDir, 'data'), { recursive: true });
                    await copyFileIfChanged(sysSurfDest, path.join(destTrackDir, 'data', 'surfaces.ini'));
                }
                if (serverCfg.SERVER.CONFIG_TRACK && !fs.existsSync(path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'data', 'surfaces.ini'))) {
                    fs.mkdirSync(path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'data'), { recursive: true });
                    await copyFileIfChanged(sysSurfDest, path.join(destTrackDir, serverCfg.SERVER.CONFIG_TRACK, 'data', 'surfaces.ini'));
                }
            }

            for (const [carNum, cId] of uniqueCarIds.entries()) {
                sendSaveProgress('cars', { current: carNum + 1, total: uniqueCarIds.length });
                if (!fs.existsSync(path.join(acPath, 'content', 'cars', cId))) continue;
                fs.mkdirSync(path.join(SERVER_DIR, 'content', 'cars', cId), { recursive: true });
                if (fs.existsSync(path.join(acPath, 'content', 'cars', cId, 'data.acd'))) await copyFileIfChanged(path.join(acPath, 'content', 'cars', cId, 'data.acd'), path.join(SERVER_DIR, 'content', 'cars', cId, 'data.acd'));
                if (fs.existsSync(path.join(acPath, 'content', 'cars', cId, 'data'))) await copyFolderAsync(path.join(acPath, 'content', 'cars', cId, 'data'), path.join(SERVER_DIR, 'content', 'cars', cId, 'data'));
            }
        }

        const timeline = weatherTimeline.normalizeTimeline(rawTimeline);
        weatherTimeline.applyTimelineToServerCfg(serverCfg, timeline, Boolean(extraCfg.EnableWeatherFx));
        fs.writeFileSync(path.join(cfgDir, 'weather_timeline.json'), JSON.stringify(timeline, null, 2), 'utf-8');

        const serverCfgPath = path.join(cfgDir, 'server_cfg.ini');
        const previousServerCfg = fs.existsSync(serverCfgPath) ? fs.readFileSync(serverCfgPath, 'utf-8') : '';
        fs.writeFileSync(serverCfgPath, mergeAcIni(previousServerCfg, serverCfg), 'utf-8');
        fs.writeFileSync(path.join(cfgDir, 'entry_list.ini'), stringifyAcIni(entryList), 'utf-8');
        fs.writeFileSync(path.join(cfgDir, 'extra_cfg.yml'), yaml.stringify(extraCfg), 'utf-8');
        fs.writeFileSync(path.join(cfgDir, 'manager_preset.json'), JSON.stringify({ playerCars, trafficCars }, null, 2), 'utf-8');

        discordWebhook.configure({
            serverName: serverCfg.SERVER.NAME,
            trackName: `${serverCfg.SERVER.TRACK} ${serverCfg.SERVER.CONFIG_TRACK ? `(${serverCfg.SERVER.CONFIG_TRACK})` : ''}`
        });

        return { success: true, totalSlots: carIndex, aiEnabled: extraCfg.EnableAi };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

function sendSaveProgress(stage, extra = {}) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('save:progress', { stage, ...extra });
}

// Копирует файл, только если он отличается по размеру или дате — повторные сохранения не трогают диск зря
async function copyFileIfChanged(src, dest) {
    const [a, b] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dest).catch(() => null)]);
    if (b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000) return;
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    await fs.promises.utimes(dest, a.atime, a.mtime);
}

async function copyFolderAsync(source, target) {
    if (!fs.existsSync(source)) return;
    await fs.promises.mkdir(target, { recursive: true });
    for (const file of await fs.promises.readdir(source, { withFileTypes: true })) {
        const from = path.join(source, file.name), to = path.join(target, file.name);
        if (file.isDirectory()) await copyFolderAsync(from, to);
        else await copyFileIfChanged(from, to);
    }
}

function copyFolderRecursiveSync(source, target) {
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(source, { withFileTypes: true })) {
        if (file.isDirectory()) copyFolderRecursiveSync(path.join(source, file.name), path.join(target, file.name));
        else fs.copyFileSync(path.join(source, file.name), path.join(target, file.name));
    }
}

ipcMain.handle('profiles:list', () => {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
    return fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json')).map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf-8')); } catch (e) { return null; }
    }).filter(p => p).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
});

ipcMain.handle('profiles:save', (e, profileData) => {
    try {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
        const id = safeProfileId(profileData.id) || `profile_${Date.now()}`;
        const now = new Date();
        const fullProfile = { ...profileData, id, dateFormatted: `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getFullYear()).slice(-2)}`, timestamp: Date.now() };
        fs.writeFileSync(path.join(PROFILES_DIR, `${id}.json`), JSON.stringify(fullProfile, null, 2), 'utf-8');
        return { success: true, profile: fullProfile };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('profiles:delete', (e, id) => {
    const safeId = safeProfileId(id);
    if (safeId && fs.existsSync(path.join(PROFILES_DIR, `${safeId}.json`))) fs.unlinkSync(path.join(PROFILES_DIR, `${safeId}.json`));
    return { success: true };
});

// id профиля становится именем файла — не пропускаем "../" и прочие символы пути
function safeProfileId(id) {
    return /^[\w-]{1,80}$/.test(String(id || '')) ? String(id) : '';
}

ipcMain.on('server:toggleAutoRestart', (e, enabled) => {
    autoRestartEnabled = enabled;
    saveLauncherConfig({ autoRestart: enabled });
});

function sendLog(type, text) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:log', { type, text });
}

function readServerConfigs() {
    const cfgPath = path.join(SERVER_DIR, 'cfg', 'server_cfg.ini');
    const exPath = path.join(SERVER_DIR, 'cfg', 'extra_cfg.yml');
    const serverCfg = fs.existsSync(cfgPath) ? parseAcIni(fs.readFileSync(cfgPath, 'utf-8')) : {};
    let extraCfg = {};
    try { if (fs.existsSync(exPath)) extraCfg = yaml.parse(fs.readFileSync(exPath, 'utf-8')) || {}; } catch (e) {}
    return { serverCfg, extraCfg };
}

// --- КОМАНДЫ СЕРВЕРУ: RCON, а если он недоступен — консоль процесса ---
async function serverCommand(cmd) {
    if (!serverProcess) return false;
    if (rcon.connected) {
        try {
            const reply = await rcon.exec(cmd.replace(/^\//, ''));
            if (reply && reply.trim()) sendLog('info', `>>> [RCON] ${reply.trim()}`);
            return true;
        } catch (err) {
            sendLog('warn', `>>> [RCON] ${err.message} → stdin`);
        }
    }
    return liveMonitor.sendServerCommand(serverProcess, cmd);
}

async function connectRcon(port, password) {
    if (!port) return;
    for (let attempt = 1; attempt <= 5 && serverProcess; attempt++) {
        try {
            await rcon.connect({ port, password });
            sendLog('info', `>>> [RCON] ${T('Подключено к порту')} ${port}`);
            return;
        } catch (err) {
            if (err.message === 'RCON: wrong password') { sendLog('error', `>>> [RCON] ${T('Неверный пароль администратора')}`); return; }
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    sendLog('warn', `>>> [RCON] ${T('Не удалось подключиться, команды идут через консоль сервера')}`);
}

function stopServerProcess() {
    if (restartTimeout) clearTimeout(restartTimeout);
    weatherTimeline.weatherScheduler.stop();
    serverSchedule.stop();
    rcon.close();
    if (serverProcess) { serverProcess.kill(); serverProcess = null; }
}

async function startServer({ skipPreflight = false } = {}) {
    if (serverProcess) return { success: false, error: 'already_running' };
    if (!fs.existsSync(path.join(SERVER_DIR, 'AssettoServer.exe'))) {
        mainWindow.webContents.send('server:missingExe');
        return { success: false, error: 'exe_missing' };
    }

    const { serverCfg, extraCfg } = readServerConfigs();
    const sCfg = serverCfg.SERVER || {};

    if (!skipPreflight) {
        const items = await diagnostics.preflight({ serverDir: SERVER_DIR, serverCfg, extraCfg, serverRunning: false });
        if (items.some(i => i.level === 'error')) return { success: false, error: 'preflight', items };
    }

    isManualStop = false;
    liveMonitor.reset();

    sendLog('info', `>>> ${T('Запуск AssettoServer.exe...')}`);
    serverProcess = spawn(path.join(SERVER_DIR, 'AssettoServer.exe'), [], { cwd: SERVER_DIR });
    mainWindow.webContents.send('server:status', true);

    let notifiedStart = false;

    serverProcess.stdout.on('data', data => {
        const str = data.toString();
        sendLog('stdout', str);
        liveMonitor.parseLogChunk(str);

        if (!notifiedStart && str.includes('Starting update loop')) {
            notifiedStart = true;
            const fullTrack = `${sCfg.TRACK || ''} ${sCfg.CONFIG_TRACK ? `[${sCfg.CONFIG_TRACK}]` : ''}`.trim();
            discordWebhook.notifyServerStart(fullTrack, sCfg.MAX_CLIENTS || 20, Boolean(extraCfg.EnableAi));
            connectRcon(parseInt(extraCfg.RconPort) || 0, String(sCfg.ADMIN_PASSWORD || '')).finally(() => {
                startWeatherScheduler(Boolean(extraCfg.EnableWeatherFx));
                serverSchedule.start(loadLauncherConfig().schedule, {
                    send: serverCommand,
                    restart: restartServer,
                    warnText: min => `${T('Рестарт сервера через')} ${min} ${T('мин.')}`,
                    onLog: (code, params = {}) => sendLog('info', code === 'restart_now'
                        ? `>>> [SCHEDULE] ${T('Плановый рестарт сервера')}`
                        : `>>> [SCHEDULE] ${T('Плановый рестарт через')} ${params.hours} ${T('ч.')}`)
                });
            });
        }
    });

    serverProcess.stderr.on('data', data => sendLog('error', data.toString()));

    serverProcess.on('close', code => {
        liveMonitor.reset();
        playerHistory.closeAll();
        weatherTimeline.weatherScheduler.stop();
        serverSchedule.stop();
        rcon.close();
        // При ручной остановке процесс убивается и код равен null — это не ошибка
        sendLog(code === 0 || isManualStop ? 'info' : 'error', `>>> ${T('Процесс сервера остановлен')}${code === null ? '' : ` (${T('Код')}: ${code})`}`);
        serverProcess = null;
        mainWindow.webContents.send('server:status', false);

        const isCrash = !isManualStop && code !== 0;
        discordWebhook.notifyServerStop(isCrash, code);

        if (pendingRestart) {
            pendingRestart = false;
            restartTimeout = setTimeout(() => startServer({ skipPreflight: true }), 2000);
        } else if (isCrash && autoRestartEnabled) {
            sendLog('warn', `>>> [WATCHDOG] ${T('Перезапуск сервера через 3 секунды...')}`);
            restartTimeout = setTimeout(() => { if (autoRestartEnabled && !isManualStop) startServer({ skipPreflight: true }); }, 3000);
        }
    });

    return { success: true };
}

let pendingRestart = false;

function restartServer() {
    if (!serverProcess) return;
    pendingRestart = true;
    isManualStop = true;
    stopServerProcess();
}

ipcMain.handle('server:start', (e, opts = {}) => startServer({ skipPreflight: Boolean(opts.skipPreflight) }));

ipcMain.on('server:stop', () => {
    isManualStop = true;
    pendingRestart = false;
    if (restartTimeout) clearTimeout(restartTimeout);
    if (serverProcess) {
        sendLog('warn', `>>> ${T('Остановка сервера...')}`);
        stopServerProcess();
    }
});

// --- ДИАГНОСТИКА ---
ipcMain.handle('diag:ports', () => {
    const { serverCfg, extraCfg } = readServerConfigs();
    const s = serverCfg.SERVER || {};
    if (serverProcess) return { running: true, checks: [] };
    return diagnostics.checkPorts({
        udpPort: parseInt(s.UDP_PORT) || 9600,
        tcpPort: parseInt(s.TCP_PORT) || 9600,
        httpPort: parseInt(s.HTTP_PORT) || 8081,
        rconPort: parseInt(extraCfg.RconPort) || 0
    }).then(checks => ({ running: false, checks, addresses: diagnostics.localAddresses() }));
});

ipcMain.handle('diag:preflight', () => {
    const { serverCfg, extraCfg } = readServerConfigs();
    return diagnostics.preflight({ serverDir: SERVER_DIR, serverCfg, extraCfg, serverRunning: Boolean(serverProcess) });
});

// --- РАСПИСАНИЕ: рестарты и сообщения ---
ipcMain.handle('schedule:get', () => normalizeSchedule(loadLauncherConfig().schedule));
ipcMain.handle('schedule:save', (e, schedule) => {
    const clean = normalizeSchedule(schedule);
    saveLauncherConfig({ schedule: clean });
    // Изменения применяются сразу, если сервер уже работает
    if (serverProcess) {
        serverSchedule.start(clean, {
            send: serverCommand,
            restart: restartServer,
            warnText: min => `${T('Рестарт сервера через')} ${min} ${T('мин.')}`,
            onLog: () => {}
        });
    }
    return { success: true, schedule: clean };
});
ipcMain.handle('schedule:state', () => serverSchedule.getState());

// --- РЕЗЕРВНЫЕ КОПИИ ---
ipcMain.handle('backup:list', () => backups.list(SERVER_DIR));
ipcMain.handle('backup:create', () => {
    try { return { success: true, ...backups.createSnapshot(SERVER_DIR, { kind: 'manual' }) }; }
    catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('backup:restore', (e, id) => {
    if (serverProcess) return { success: false, error: 'server_running' };
    try { backups.restore(SERVER_DIR, id); return { success: true }; }
    catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('backup:delete', (e, id) => {
    try { backups.remove(SERVER_DIR, id); return { success: true }; }
    catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('backup:exportZip', async (e, id) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: T('Сохранить архив настроек'),
        defaultPath: path.join(app.getPath('documents'), `ASM_backup_${id}.zip`),
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    try { await backups.exportZip(SERVER_DIR, id, filePath); return { success: true, path: filePath }; }
    catch (err) { return { success: false, error: err.message }; }
});
ipcMain.on('backup:openFolder', () => {
    fs.mkdirSync(backups.backupsDir(SERVER_DIR), { recursive: true });
    shell.openPath(backups.backupsDir(SERVER_DIR));
});

// --- АДМИНЫ / БЕЛЫЙ / ЧЁРНЫЙ СПИСОК ---
ipcMain.handle('access:load', () => accessLists.loadAll(SERVER_DIR));
ipcMain.handle('access:save', (e, { list, entries }) => {
    try {
        backups.createSnapshot(SERVER_DIR, { kind: 'auto', reason: 'access' });
        return { success: true, entries: accessLists.saveList(SERVER_DIR, list, entries) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// --- ИСТОРИЯ ИГРОКОВ ---
ipcMain.handle('history:get', () => playerHistory.snapshot());
ipcMain.handle('history:clear', () => { playerHistory.clear(); return { success: true }; });

// --- СОХРАНЕНИЕ ЛОГА КОНСОЛИ В ФАЙЛ ---
ipcMain.handle('logs:save', async (e, text) => {
    const d = new Date();
    const name = `server_log_${d.toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: T('Сохранить лог консоли'),
        defaultPath: path.join(app.getPath('documents'), name),
        filters: [{ name: 'Text', extensions: ['txt', 'log'] }]
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    fs.writeFileSync(filePath, String(text || ''), 'utf-8');
    return { success: true, path: filePath };
});

// --- ТАЙМЛАЙН ПОГОДЫ (CSP WEATHER FX) ---
function loadSavedTimeline() {
    const p = path.join(SERVER_DIR, 'cfg', 'weather_timeline.json');
    try { return fs.existsSync(p) ? weatherTimeline.normalizeTimeline(JSON.parse(fs.readFileSync(p, 'utf-8'))) : null; }
    catch (e) { return null; }
}

function startWeatherScheduler(weatherFxEnabled) {
    const timeline = loadSavedTimeline();
    if (!timeline || !timeline.enabled) return;
    weatherTimeline.weatherScheduler.start(timeline, {
        weatherFxEnabled,
        sendCommand: serverCommand,
        onLog: text => sendLog('info', text)
    });
}

// Мгновенно применить кадр к запущенному серверу (кнопка «Применить сейчас»)
ipcMain.handle('weather:applyNow', async (e, { keyframe, index }) => {
    if (!serverProcess) return { success: false, error: 'server_offline' };
    const k = weatherTimeline.normalizeTimeline({ keyframes: [keyframe] }).keyframes[0];
    await serverCommand(`/settime ${weatherTimeline.formatTime(k.time)}`);
    if (Number.isInteger(index)) await serverCommand(`/setweather ${index}`);
    const ok = await serverCommand(`/setcspweather ${weatherTimeline.WEATHER_FX_TYPES[k.type]} ${Math.round(k.transition)}`);
    sendLog('info', `>>> [WEATHER] ${T('Применено вручную')}: ${k.type}, ${weatherTimeline.formatTime(k.time)}`);
    return { success: ok };
});

ipcMain.handle('weather:state', () => weatherTimeline.weatherScheduler.getState());

// --- LIVE МОНИТОРИНГ И КОМАНДЫ ---
ipcMain.handle('live:kick', async (e, sessionId) => {
    const ok = await liveMonitor.kickPlayer(serverCommand, sessionId);
    if (ok) sendLog('warn', `>>> ${T('Игрок кикнут с сервера')} (ID: ${sessionId})`);
    return { success: ok };
});

ipcMain.handle('live:ban', async (e, sessionId) => {
    const player = liveMonitor.players.get(String(sessionId));
    if (player) accessLists.rememberName(SERVER_DIR, player.steamId, player.name);
    const ok = await liveMonitor.banPlayer(serverCommand, sessionId);
    if (ok) sendLog('error', `>>> ${T('Игрок забанен и занесён в blacklist.txt')} (ID: ${sessionId})`);
    return { success: ok };
});

ipcMain.handle('live:broadcast', async (e, message) => {
    const ok = await liveMonitor.sendBroadcastChat(serverCommand, message);
    if (ok) sendLog('info', `>>> [${T('ЧАТ СЕРВЕРА')}]: ${message}`);
    return { success: ok };
});

ipcMain.handle('live:rconStatus', () => ({ connected: rcon.connected }));

const { createClientModpack } = require('./src/modpack-packer.js');

ipcMain.handle('modpack:create', async () => {
    const { acPath } = loadLauncherConfig();
    if (!acPath) return { success: false, error: T('Не указана папка Assetto Corsa') };

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: T('Сохранить клиентский мод-пак'),
        defaultPath: 'AssettoServer_Modpack.zip',
        filters: [{ name: T('ZIP Архивы'), extensions: ['zip'] }]
    });

    if (canceled || !filePath) return { canceled: true };

    try {
        await createClientModpack({
            acPath,
            serverDir: SERVER_DIR,
            outputZipPath: filePath
        });
        return { success: true, path: filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// --- РЕПОЗИТОРИЙ И МЕНЕДЖЕР ПЛАГИНОВ ---
const pluginsRegistryPath = path.join(__dirname, 'src', 'plugins-registry.json');

ipcMain.handle('plugins:list', () => {
    try {
        if (fs.existsSync(pluginsRegistryPath)) {
            const data = JSON.parse(fs.readFileSync(pluginsRegistryPath, 'utf-8'));
            const pluginsDir = path.join(SERVER_DIR, 'plugins');
            
            // Проверяем, установлен ли каждый плагин физически в папке сервера
            return (data.plugins || []).map(p => {
                const isInstalled = fs.existsSync(path.join(pluginsDir, p.id)) || 
                                    fs.existsSync(path.join(pluginsDir, p.configFileName));
                return { ...p, installed: isInstalled };
            });
        }
    } catch (e) {}
    return [];
});

ipcMain.handle('plugins:install', async (e, pluginId) => {
    try {
        if (!fs.existsSync(pluginsRegistryPath)) throw new Error('Реестр плагинов не найден');
        const data = JSON.parse(fs.readFileSync(pluginsRegistryPath, 'utf-8'));
        const plugin = (data.plugins || []).find(p => p.id === pluginId);
        if (!plugin) throw new Error('Плагин не найден в реестре');

        const pluginsDir = path.join(SERVER_DIR, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        const tempZip = path.join(SERVER_DIR, `plugin_${pluginId}_temp.zip`);
        
        // Скачиваем архив плагина
        await downloadFileWithRedirects(plugin.downloadUrl, tempZip);

        // Распаковываем в папку плагинов
        await extractArchiveSmart(tempZip, pluginsDir);

        if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('plugins:uninstall', async (e, pluginId) => {
    try {
        if (!fs.existsSync(pluginsRegistryPath)) throw new Error('Реестр плагинов не найден');
        const data = JSON.parse(fs.readFileSync(pluginsRegistryPath, 'utf-8'));
        const plugin = (data.plugins || []).find(p => p.id === pluginId);
        if (!plugin) throw new Error('Плагин не найден');

        const pluginsDir = path.join(SERVER_DIR, 'plugins');
        
        // Удаляем файлы конфигурации или папку плагина, если они существуют
        const targetPath = path.join(pluginsDir, plugin.id);
        if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });

        const configPath = path.join(pluginsDir, plugin.configFileName);
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});