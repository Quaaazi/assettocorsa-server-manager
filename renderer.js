// Доступ к main-процессу только через мост из preload.js (contextIsolation)
const ipcRenderer = window.api.ipc;
const shell = window.api.shell;

// Подключаем модуль локализации
const { t, setLang, getTranslations, changelogData } = window.i18n;

// Экранирование всего, что пришло из файлов модов, профилей, логов сервера и от игроков
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

let currentLang = 'ru';

function applyLanguage(lang) {
    currentLang = lang;
    setLang(lang);
    const dict = getTranslations(lang);
    if (!dict) return;

    const translateNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.nodeValue.trim();
            if (text && dict[text]) {
                const leadingSpace = node.nodeValue.match(/^\s*/)[0];
                const trailingSpace = node.nodeValue.match(/\s*$/)[0];
                node.nodeValue = leadingSpace + dict[text] + trailingSpace;
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.hasAttribute('placeholder')) {
                const ph = node.getAttribute('placeholder');
                if (dict[ph]) node.setAttribute('placeholder', dict[ph]);
            }
            if (node.hasAttribute('title')) {
                const title = node.getAttribute('title');
                if (dict[title]) node.setAttribute('title', dict[title]);
            }
            if (node.tagName === 'OPTION') {
                const optText = node.textContent.trim();
                if (dict[optText]) node.textContent = dict[optText];
            }
            if (node.tagName === 'BUTTON' || node.tagName === 'SPAN') {
                const originalText = node.textContent.trim();
                if (dict[originalText]) {
                    for (let i = 0; i < node.childNodes.length; i++) {
                        if (node.childNodes[i].nodeType === Node.TEXT_NODE) {
                            const txt = node.childNodes[i].nodeValue.trim();
                            if (dict[txt]) {
                                const leadingSpace = node.childNodes[i].nodeValue.match(/^\s*/)[0];
                                const trailingSpace = node.childNodes[i].nodeValue.match(/\s*$/)[0];
                                node.childNodes[i].nodeValue = leadingSpace + dict[txt] + trailingSpace;
                            }
                        }
                    }
                }
            }
            for (let i = 0; i < node.childNodes.length; i++) {
                translateNode(node.childNodes[i]);
            }
        }
    };

    translateNode(document.body);
    
    document.querySelectorAll('.switch-sub, .hint, .card-sub, .cm-editor-left label, .cm-editor-right label').forEach(el => {
        const text = el.textContent.trim();
        if (dict[text]) el.textContent = dict[text];
    });

    const langSelect = document.getElementById('app-language-select');
    if (langSelect) langSelect.value = lang;

    const profileBadge = document.getElementById('title-active-profile');
    if (profileBadge) {
        if (lang === 'en' && profileBadge.innerText.trim() === 'По умолчанию') profileBadge.innerText = 'Default';
        else if (lang === 'ru' && profileBadge.innerText.trim() === 'Default') profileBadge.innerText = 'По умолчанию';
    }

    updateChangelogUI(lang);
    applyKeyedTranslations(lang);
    refreshWeatherTypeLabels();

    const consoleContainer = document.getElementById('console-output');
    if (consoleContainer && consoleContainer.innerHTML.trim() === '') {
        const infoText = (lang === 'en') ? 'Program is ready. Configure the settings and click "Start Server".' : 'Программа готова к работе. Настройте параметры и нажмите «Запустить сервер».';
        const badgeText = (lang === 'en') ? 'INFORMATION' : 'ИНФОРМАЦИЯ';
        const timeText = (lang === 'en') ? 'START' : 'СТАРТ';
        consoleContainer.innerHTML = `
            <div class="log-group group-info">
                <div class="log-group-header">
                    <span class="log-badge">${badgeText}</span><span class="log-time">${timeText}</span>
                </div>
                <div class="log-group-body"><div class="log-item">${infoText}</div></div>
            </div>`;
    }

    if (appState.allCars.length > 0) {
        renderAvailableCars(carSearchInput.value);
        renderSelectedCarsColumns();
        updateDashboardSummary();
        renderProfilesList();
        applyTrackAiAutomation();
    }
}

let appState = {
    acPath: '', serverDir: '', installedVersion: 'Не установлен', theme: 'dark',
    allCars: [], allTracks: [], playerCars: [], trafficCars: [], profiles: [],
    activeFilter: 'all', currentTrackSupportsAi: true, serverCfg: {}, extraCfg: {},
    weatherTimeline: null
};

let lastLogGroup = { category: null, bodyEl: null, timestamp: 0 };
let mediaInsertMode = 'clickable';

const FALLBACK_CAR_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220"><rect width="400" height="220" fill="#161922"/></svg>`);
const FALLBACK_TRACK_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220"><rect width="400" height="220" fill="#161922"/></svg>`);

function updateChangelogUI(lang) {
    const container = document.getElementById('changelog-content');
    if (container) container.innerHTML = changelogData[lang] || changelogData['ru'];
}

const trackModal = document.getElementById('track-modal');
const openTrackModalBtn = document.getElementById('open-track-modal-btn');
const closeTrackModalBtn = document.getElementById('close-track-modal-btn');
const trackCardsGrid = document.getElementById('track-cards-grid');
const trackModalSearch = document.getElementById('track-modal-search');
const displayTrackName = document.getElementById('display-track-name');
const displayTrackLayout = document.getElementById('display-track-layout');
const modalRescanBtn = document.getElementById('modal-rescan-btn');

const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeIconSun = document.getElementById('theme-icon-sun');
const themeIconMoon = document.getElementById('theme-icon-moon');

function applyTheme(theme) {
    appState.theme = theme === 'light' ? 'light' : 'dark';
    if (appState.theme === 'light') {
        document.body.classList.add('light-theme');
        themeIconSun.classList.remove('hidden');
        themeIconMoon.classList.add('hidden');
    } else {
        document.body.classList.remove('light-theme');
        themeIconSun.classList.add('hidden');
        themeIconMoon.classList.remove('hidden');
    }
}

themeToggleBtn.addEventListener('click', () => {
    const nextTheme = appState.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    ipcRenderer.send('launcher:saveTheme', nextTheme);
    showToast(nextTheme === 'light' ? t("Тема оформления: Светлая") : t("Тема оформления: Темная"), 'info');
});

const carTooltip = document.getElementById('car-hover-tooltip');
const carTooltipImg = document.getElementById('car-tooltip-img');
const carTooltipBadge = document.getElementById('car-tooltip-badge');
const carTooltipTag = document.getElementById('car-tooltip-tag');
const carTooltipName = document.getElementById('car-tooltip-name');
const carTooltipId = document.getElementById('car-tooltip-id');
const carTooltipSkins = document.getElementById('car-tooltip-skins');

function showCarHoverCard(car, mouseEvent) {
    if (!carTooltip || !car) return;
    const fullCar = appState.allCars.find(c => c.id === car.id) || car;

    carTooltipImg.src = fullCar.previewUrl || FALLBACK_CAR_SVG;
    carTooltipImg.onerror = () => { carTooltipImg.src = FALLBACK_CAR_SVG; };

    if (fullCar.badgeUrl) {
        carTooltipBadge.src = fullCar.badgeUrl;
        carTooltipBadge.classList.remove('hidden');
    } else {
        carTooltipBadge.classList.add('hidden');
    }

    if (fullCar.isTraffic) {
        carTooltip.classList.add('traffic-theme');
        carTooltipTag.innerText = 'AI TRAFFIC';
    } else {
        carTooltip.classList.remove('traffic-theme');
        carTooltipTag.innerText = fullCar.brand ? fullCar.brand.toUpperCase() : 'STREET / TRACK';
    }

    carTooltipName.innerText = fullCar.name || fullCar.id;
    carTooltipId.innerText = fullCar.id;
    carTooltipSkins.innerText = `${t("Скинов:")} ${fullCar.skins?.length || 0}`;

    carTooltip.classList.remove('hidden');
    moveTooltip(mouseEvent, carTooltip);
}

function hideCarHoverCard() { if (carTooltip) carTooltip.classList.add('hidden'); }

function attachCarHoverEvents(element, car) {
    element.addEventListener('mouseenter', (e) => showCarHoverCard(car, e));
    element.addEventListener('mousemove', (e) => moveTooltip(e, carTooltip));
    element.addEventListener('mouseleave', hideCarHoverCard);
}

function moveTooltip(e, tooltipElement = carTooltip) {
    if (!tooltipElement || tooltipElement.classList.contains('hidden')) return;
    const pad = 18;
    const rect = tooltipElement.getBoundingClientRect();
    const w = rect.width || 280;
    const h = rect.height || 215;

    let x = e.clientX + pad;
    let y = e.clientY - Math.round(h / 2);

    if (x + w > window.innerWidth - 12) x = e.clientX - w - pad;
    if (y < 44) y = 44;
    if (y + h > window.innerHeight - 62) y = window.innerHeight - h - 62;

    tooltipElement.style.left = `${x}px`;
    tooltipElement.style.top = `${y}px`;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 250);
    }, 3800);
}

document.getElementById('win-min').addEventListener('click', () => ipcRenderer.send('win:minimize'));
document.getElementById('win-max').addEventListener('click', () => ipcRenderer.send('win:maximize'));
document.getElementById('win-close').addEventListener('click', () => ipcRenderer.send('win:close'));

document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        hideCarHoverCard();
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
    });
});

async function initApp() {
    const initData = await ipcRenderer.invoke('launcher:init');
    appState.acPath = initData.acPath;
    appState.serverDir = initData.serverDir;
    appState.installedVersion = initData.installedVersion;

    applyTheme(initData.theme || 'dark');
    applyLanguage(initData.language || 'ru');

    const langSelect = document.getElementById('app-language-select');
    if (langSelect) {
        langSelect.addEventListener('change', (e) => {
            const newLang = e.target.value;
            ipcRenderer.send('launcher:saveLanguage', newLang);
            setTimeout(() => location.reload(), 300); 
        });
    }

    document.getElementById('sys-ac-path').value = appState.acPath || 'Не найдено';
    document.getElementById('sys-server-dir').value = appState.serverDir;
    updateVersionLabels();

    const wdCheck = document.getElementById('watchdog-check');
    if (wdCheck) {
        wdCheck.checked = initData.autoRestart;
        ipcRenderer.send('server:toggleAutoRestart', wdCheck.checked);
        wdCheck.addEventListener('change', (e) => {
            ipcRenderer.send('server:toggleAutoRestart', e.target.checked);
            showToast(e.target.checked ? t("Автоперезапуск: Включен") : t("Автоперезапуск: Отключен"), 'info');
        });
    }

    if (initData.autoDetected) showToast(t("Игра найдена") + `: ${appState.acPath}`, 'success');

    if (!appState.acPath) {
        showToast(t("Не удалось обнаружить игру. Укажите папку вручную."), 'warn');
        document.getElementById('setup-overlay').classList.remove('hidden');
        return;
    }

    if (!initData.isInitialized) await ipcRenderer.invoke('server:setup', appState.acPath);

    await loadAllData();

    if (!initData.hasServerExe) {
        showToast(t("Скачивание файлов сервера с GitHub..."), 'info');
        await triggerAssettoServerDownload();
    }
}

function updateVersionLabels() {
    const sysVer = document.getElementById('sys-as-version');
    const dashVer = document.getElementById('dash-version-info');
    if (sysVer) sysVer.innerText = appState.installedVersion;
    if (dashVer) dashVer.innerText = `${t("Версия")}: ${appState.installedVersion}`;
}

const setupBrowseBtn = document.getElementById('setup-browse-btn');
const setupAcPathInput = document.getElementById('setup-ac-path');
const setupInstallBtn = document.getElementById('setup-install-btn');
const setupStatus = document.getElementById('setup-status');

setupBrowseBtn.addEventListener('click', async () => {
    const folder = await ipcRenderer.invoke('dialog:selectFolder');
    if (folder) {
        setupAcPathInput.value = folder;
        if (await ipcRenderer.invoke('fs:isAcFolder', folder)) {
            setupStatus.style.color = '#10b981';
            setupStatus.innerText = t("Папка игры найдена!");
            setupInstallBtn.disabled = false;
        } else {
            setupStatus.style.color = '#ef4444';
            setupStatus.innerText = t("В этой папке нет assettocorsa.exe");
            setupInstallBtn.disabled = true;
        }
    }
});

setupInstallBtn.addEventListener('click', async () => {
    setupInstallBtn.disabled = true;
    const res = await ipcRenderer.invoke('server:setup', setupAcPathInput.value);
    if (res.success) {
        appState.acPath = setupAcPathInput.value;
        document.getElementById('sys-ac-path').value = appState.acPath;
        document.getElementById('setup-overlay').classList.add('hidden');
        showToast(t("Папка сохранена"), 'success');
        await loadAllData();
    } else {
        showToast(t("Ошибка: ") + res.error, 'error');
        setupInstallBtn.disabled = false;
    }
});

async function loadAllData() {
    const content = await ipcRenderer.invoke('content:scan');
    appState.allCars = content.cars || [];
    appState.allTracks = content.tracks || [];

    const configs = await ipcRenderer.invoke('config:load');
    appState.serverCfg = configs.serverCfg || {};
    appState.extraCfg = configs.extraCfg || {};
    appState.weatherTimeline = configs.weatherTimeline;

    if (configs.preset && (configs.preset.playerCars || configs.preset.trafficCars)) {
        appState.playerCars = (configs.preset.playerCars || []).filter(pc => appState.allCars.some(ac => ac.id === pc.id)).map(pc => {
            const real = appState.allCars.find(ac => ac.id === pc.id);
            return { ...pc, name: real.name, skins: real.skins, previewUrl: real.previewUrl, badgeUrl: real.badgeUrl, brand: real.brand, isTraffic: real.isTraffic };
        });
        appState.trafficCars = (configs.preset.trafficCars || []).filter(tc => appState.allCars.some(ac => ac.id === tc.id)).map(tc => {
            const real = appState.allCars.find(ac => ac.id === tc.id);
            return { ...tc, name: real.name, skins: real.skins, previewUrl: real.previewUrl, badgeUrl: real.badgeUrl, brand: real.brand, isTraffic: real.isTraffic };
        });
    } else {
        appState.playerCars = [];
        appState.trafficCars = [];
    }

    if (appState.playerCars.length === 0 && appState.allCars.length > 0) {
        const firstRegular = appState.allCars.find(c => !c.isTraffic) || appState.allCars[0];
        appState.playerCars.push({
            id: firstRegular.id, name: firstRegular.name, slots: 2, skins: firstRegular.skins, previewUrl: firstRegular.previewUrl, badgeUrl: firstRegular.badgeUrl, brand: firstRegular.brand, isTraffic: firstRegular.isTraffic
        });
    }

    if (appState.trafficCars.length === 0) autoPopulateTrafficCars(false);

    renderTracksDropdown();
    renderAvailableCars();
    renderSelectedCarsColumns();
    populateSettingsFields();
    renderWeatherTimeline();
    updateDashboardSummary();
    await loadProfilesList();
    await initToolPanels();
}

const rescanBtn = document.getElementById('rescan-content-btn');
const rescanIcon = document.getElementById('rescan-icon');
const importAiLineBtn = document.getElementById('import-ai-line-btn');

async function rescanTracksAndCars(showNotification = true) {
    const savedTrack = trackSelect.value;
    const savedConfig = trackConfigSelect.value;

    rescanIcon.classList.remove('spin-anim');
    void rescanIcon.offsetWidth;
    rescanIcon.classList.add('spin-anim');

    const content = await ipcRenderer.invoke('content:scan');
    appState.allCars = content.cars || [];
    appState.allTracks = content.tracks || [];

    if (savedTrack) {
        if (!appState.serverCfg.SERVER) appState.serverCfg.SERVER = {};
        appState.serverCfg.SERVER.TRACK = savedTrack;
        appState.serverCfg.SERVER.CONFIG_TRACK = savedConfig;
    }

    renderTracksDropdown();
    renderAvailableCars(carSearchInput.value);
    renderSelectedCarsColumns();
    updateDashboardSummary();

    if (showNotification) showToast(t("Список карт и машин обновлен!"), 'success');
}

rescanBtn.addEventListener('click', () => rescanTracksAndCars(true));

importAiLineBtn.addEventListener('click', async () => {
    const trackId = trackSelect.value;
    const trackConfig = trackConfigSelect.value;
    const res = await ipcRenderer.invoke('track:importAiFile', { trackId, trackConfig });
    if (res.canceled) return;
    if (res.success) {
        showToast(t("Трафик успешно распакован и установлен в карту!"), 'success');
        await rescanTracksAndCars(false);
        updateTrackConfigsDropdown();
    } else {
        showToast(t("Ошибка установки архива: ") + res.error, 'error');
    }
});

function autoPopulateTrafficCars(notify = true) {
    const trafficModels = appState.allCars.filter(c => c.isTraffic);
    let addedCount = 0;

    trafficModels.forEach(car => {
        if (!appState.trafficCars.some(tc => tc.id === car.id)) {
            appState.trafficCars.push({ id: car.id, name: car.name, slots: 1, skins: car.skins, previewUrl: car.previewUrl, badgeUrl: car.badgeUrl, brand: car.brand, isTraffic: car.isTraffic });
            addedCount++;
        }
    });

    if (notify) {
        if (addedCount > 0) showToast(`${t("Добавлено машин трафика")}: ${addedCount}`, 'success');
        else showToast(t("Все машины трафика уже добавлены"), 'info');
    }
}

document.getElementById('auto-fill-traffic-btn').addEventListener('click', () => {
    autoPopulateTrafficCars(true);
    renderSelectedCarsColumns();
    updateDashboardSummary();
});

const trackSelect = document.getElementById('track-select');
const trackConfigSelect = document.getElementById('track-config-select');
const trackAiWarning = document.getElementById('track-ai-warning');

function renderTracksDropdown() {
    trackSelect.innerHTML = '';
    appState.allTracks.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.innerText = `${t.layouts[0]?.name || t.id} [${t.id}]`;
        trackSelect.appendChild(opt);
    });

    const currentTrack = appState.serverCfg.SERVER?.TRACK || '';
    if (currentTrack && appState.allTracks.some(t => t.id === currentTrack)) {
        trackSelect.value = currentTrack;
    } else if (appState.allTracks.some(t => t.id.includes('shuto'))) {
        trackSelect.value = appState.allTracks.find(t => t.id.includes('shuto')).id;
    }
    updateTrackConfigsDropdown();
}

function updateTrackConfigsDropdown() {
    trackConfigSelect.innerHTML = '';
    const selectedTrackObj = appState.allTracks.find(t => t.id === trackSelect.value);
    if (!selectedTrackObj) return;

    selectedTrackObj.layouts.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.config;
        opt.innerText = l.config ? `${l.name} (${l.config})` : `${l.name} (Основная)`;
        opt.dataset.hasAi = l.hasAi;
        opt.dataset.preview = l.previewUrl || '';
        trackConfigSelect.appendChild(opt);
    });

    const currentConfig = appState.serverCfg.SERVER?.CONFIG_TRACK || '';
    if ([...trackConfigSelect.options].some(o => o.value === currentConfig)) trackConfigSelect.value = currentConfig;
    
    applyTrackAiAutomation();
    updateTrackSelectButtonUI(); 
}

function applyTrackAiAutomation() {
    const selectedOpt = trackConfigSelect.options[trackConfigSelect.selectedIndex];
    const hasAi = selectedOpt && selectedOpt.dataset.hasAi === 'true';
    const previewUrl = selectedOpt?.dataset.preview || '';
    appState.currentTrackSupportsAi = hasAi;

    const dashBadge = document.getElementById('dash-ai-badge');
    const trackCard = document.getElementById('dash-track-card');
    const navTabAi = document.getElementById('nav-tab-ai');
    const trafficColBox = document.getElementById('traffic-column-box');
    const dualColsBox = document.getElementById('dual-columns-box');
    const pillTraffic = document.getElementById('pill-filter-traffic');

    if (trackCard) {
        trackCard.style.backgroundImage = previewUrl ? `url("${previewUrl}")` : 'none';
        trackCard.style.backgroundSize = 'cover';
        trackCard.style.backgroundPosition = 'center';
    }

    if (hasAi) {
        navTabAi.classList.remove('hidden');
        trafficColBox.classList.remove('hidden');
        dualColsBox.classList.remove('single-col');
        pillTraffic.classList.remove('hidden');
        importAiLineBtn.classList.add('hidden');

        document.getElementById('ai-enable').checked = true;
        if (appState.trafficCars.length === 0) {
            autoPopulateTrafficCars(false);
            renderSelectedCarsColumns();
        }

        trackAiWarning.style.background = 'rgba(16, 185, 129, 0.12)';
        trackAiWarning.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        trackAiWarning.style.color = '#10b981';
        trackAiWarning.innerText = t("✓ ИИ-трафик обнаружен и полностью готов к работе.");
        dashBadge.className = 'badge ok';
        dashBadge.innerText = t("Трафик активен");
    } else {
        if (navTabAi.classList.contains('active')) document.querySelector('[data-tab="tab-content"]').click();

        navTabAi.classList.add('hidden');
        trafficColBox.classList.add('hidden');
        dualColsBox.classList.add('single-col');
        pillTraffic.classList.add('hidden');
        importAiLineBtn.classList.remove('hidden');

        if (appState.activeFilter === 'traffic') {
            appState.activeFilter = 'all';
            document.querySelectorAll('.pill[data-filter]').forEach(p => p.classList.remove('active'));
            document.querySelector('[data-filter="all"]').classList.add('active');
        }

        const isShuto = (trackSelect.value || '').toLowerCase().includes('shuto');
        trackAiWarning.style.background = 'rgba(245, 158, 11, 0.1)';
        trackAiWarning.style.border = '1px solid rgba(245, 158, 11, 0.3)';
        trackAiWarning.style.color = 'var(--accent-amber)';

        if (isShuto) trackAiWarning.innerText = t("Для этой конфигурации Shutoko нет трафика. Нажмите кнопку ниже и выберите архив .7z с трафиком.");
        else trackAiWarning.innerText = t("Обычная карта без ИИ-трафика. Запуск в стандартном режиме.");

        dashBadge.className = 'badge neutral';
        dashBadge.innerText = t("Без трафика");
    }

    renderAvailableCars(carSearchInput.value);
    updateDashboardSummary();
}

trackSelect.addEventListener('change', updateTrackConfigsDropdown);
trackConfigSelect.addEventListener('change', applyTrackAiAutomation);

openTrackModalBtn.addEventListener('click', () => {
    trackModalSearch.value = '';
    trackModal.classList.remove('hidden');
    renderTrackCards();
    setTimeout(() => {
        trackCardsGrid.style.display = 'none';
        trackCardsGrid.offsetHeight; 
        trackCardsGrid.style.display = 'grid';
    }, 10);
});

closeTrackModalBtn.addEventListener('click', () => trackModal.classList.add('hidden'));
trackModal.addEventListener('click', (e) => {
    if (e.target === trackModal) trackModal.classList.add('hidden');
});

trackModalSearch.addEventListener('input', () => renderTrackCards(trackModalSearch.value));

modalRescanBtn.addEventListener('click', async () => {
    await rescanTracksAndCars(true);
    renderTrackCards(trackModalSearch.value);
});

function renderTrackCards(searchQuery = '') {
    trackCardsGrid.innerHTML = '';
    const q = searchQuery.toLowerCase();
    const currentTrackId = trackSelect.value;

    appState.allTracks.forEach(track => {
        const firstLayoutName = track.layouts[0]?.name || track.id;
        if (q && !firstLayoutName.toLowerCase().includes(q) && !track.id.toLowerCase().includes(q)) return;

        let mainPreviewUrl = '';
        for (const layout of track.layouts) {
            if (layout.previewUrl) { mainPreviewUrl = layout.previewUrl; break; }
        }

        const hasAiOnTrack = track.layouts.some(l => l.hasAi);
        const isSelected = (track.id === currentTrackId);

        const card = document.createElement('div');
        card.className = `track-card-item ${isSelected ? 'active-track' : ''}`;

        const imgWrap = document.createElement('div');
        imgWrap.className = 'track-card-img-wrap';
        
        const img = document.createElement('img');
        img.src = mainPreviewUrl ? mainPreviewUrl + `?t=${Date.now()}` : FALLBACK_TRACK_SVG;
        img.onerror = function() { this.onerror = null; this.src = FALLBACK_TRACK_SVG; };
        imgWrap.appendChild(img);

        const badge = document.createElement('div');
        badge.className = `track-card-badge ${hasAiOnTrack ? 'has-ai' : 'no-ai'}`;
        badge.innerText = hasAiOnTrack ? t("AI ТРАФИК") : t("БЕЗ AI");
        imgWrap.appendChild(badge);

        const info = document.createElement('div');
        info.className = 'track-card-info';
        info.innerHTML = `<div class="track-card-title">${esc(track.layouts[0]?.name || track.id)}</div><div class="track-card-id">${esc(track.id)}</div>`;

        card.appendChild(imgWrap);
        card.appendChild(info);

        card.addEventListener('click', () => {
            trackSelect.value = track.id;
            updateTrackConfigsDropdown(); 
            trackConfigSelect.selectedIndex = 0;
            trackSelect.dispatchEvent(new Event('change'));
            trackConfigSelect.dispatchEvent(new Event('change'));
            updateTrackSelectButtonUI();
            trackModal.classList.add('hidden');
        });

        trackCardsGrid.appendChild(card);
    });
}

function updateTrackSelectButtonUI() {
    const selectedTrack = appState.allTracks.find(t => t.id === trackSelect.value);
    if (selectedTrack) {
        const layout = selectedTrack.layouts.find(l => l.config === trackConfigSelect.value) || selectedTrack.layouts[0];
        displayTrackName.innerText = layout?.name || selectedTrack.id;
        displayTrackLayout.innerText = `${selectedTrack.id} ${layout?.config ? `[${layout.config}]` : ''}`;
    } else {
        displayTrackName.innerText = t("Не выбрана");
        displayTrackLayout.innerText = '—';
    }
}

trackSelect.addEventListener('change', updateTrackSelectButtonUI);
trackConfigSelect.addEventListener('change', updateTrackSelectButtonUI);
setTimeout(updateTrackSelectButtonUI, 100);

const availableCarsList = document.getElementById('available-cars-list');
const carSearchInput = document.getElementById('car-search');
const playerCarsContainer = document.getElementById('player-cars-container');
const trafficCarsContainer = document.getElementById('traffic-cars-container');

document.querySelectorAll('.pill[data-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
        document.querySelectorAll('.pill[data-filter]').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        appState.activeFilter = pill.dataset.filter;
        renderAvailableCars(carSearchInput.value);
    });
});

function renderAvailableCars(searchQuery = '') {
    availableCarsList.innerHTML = '';
    const q = searchQuery.toLowerCase();

    appState.allCars
        .filter(c => {
            if (appState.activeFilter === 'traffic' && !c.isTraffic) return false;
            if (appState.activeFilter === 'regular' && c.isTraffic) return false;
            return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
        })
        .forEach(car => {
            const li = document.createElement('li');
            const badgeHtml = car.badgeUrl ? `<img src="${esc(car.badgeUrl)}" class="car-badge-icon">` : '';
            const trafficBtnHtml = appState.currentTrackSupportsAi ? `<button class="add-btn-mini traffic">${t("+ Трафик")}</button>` : '';

            li.innerHTML = `
                <div class="car-list-left">
                    ${badgeHtml}
                    <span class="car-list-title">${esc(car.name)}</span>
                </div>
                <div class="car-list-actions">
                    <button class="add-btn-mini player">${t("+ Игрокам")}</button>
                    ${trafficBtnHtml}
                </div>
            `;

            attachCarHoverEvents(li, car);

            li.querySelector('.player').addEventListener('click', (e) => {
                e.stopPropagation();
                addCarToColumn(car, 'player');
            });
            const tBtn = li.querySelector('.traffic');
            if (tBtn) {
                tBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    addCarToColumn(car, 'traffic');
                });
            }
            availableCarsList.appendChild(li);
        });
}

carSearchInput.addEventListener('input', (e) => renderAvailableCars(e.target.value));

function addCarToColumn(car, target) {
    const list = target === 'traffic' ? appState.trafficCars : appState.playerCars;
    const existing = list.find(c => c.id === car.id);
    if (existing) existing.slots += 1;
    else {
        list.push({ id: car.id, name: car.name, slots: target === 'traffic' ? 2 : 2, skins: car.skins, previewUrl: car.previewUrl, badgeUrl: car.badgeUrl, brand: car.brand, isTraffic: car.isTraffic });
    }
    renderSelectedCarsColumns();
    updateDashboardSummary();
}

function renderSelectedCarsColumns() {
    hideCarHoverCard();

    playerCarsContainer.innerHTML = '';
    if (appState.playerCars.length === 0) {
        playerCarsContainer.innerHTML = `<div style="color:var(--text-dim); padding:14px; font-size:12px;">${t("Список пуст. Выберите машины из списка слева.")}</div>`;
    } else {
        appState.playerCars.forEach((car, idx) => {
            const row = document.createElement('div');
            row.className = 'selected-car-item';
            row.innerHTML = `
                <div class="car-info-block">
                    <div class="car-info-title">${esc(car.name)}</div>
                    <div class="car-info-id">${esc(car.id)} &bull; ${t("Скинов:")} ${car.skins?.length || 0}</div>
                </div>
                <div class="car-slots-controls">
                    <div class="slot-box">
                        <span>${t("Мест:")}</span>
                        <input type="number" min="1" max="60" value="${parseInt(car.slots) || 1}" data-idx="${idx}" class="inp-p-slots">
                    </div>
                    <button class="btn-small" data-del-p="${idx}" title="${t("Удалить")}">
                        <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.5"/></svg>
                    </button>
                </div>
            `;
            attachCarHoverEvents(row, car);
            playerCarsContainer.appendChild(row);
        });
    }

    trafficCarsContainer.innerHTML = '';
    if (appState.trafficCars.length === 0) {
        trafficCarsContainer.innerHTML = `<div style="color:var(--text-dim); padding:14px; font-size:12px;">${t("Список пуст. Нажмите «Добавить весь трафик».")}</div>`;
    } else {
        appState.trafficCars.forEach((car, idx) => {
            const row = document.createElement('div');
            row.className = 'selected-car-item traffic-item';
            row.innerHTML = `
                <div class="car-info-block">
                    <div class="car-info-title">${esc(car.name)}</div>
                    <div class="car-info-id">${esc(car.id)} (${t("Бот")})</div>
                </div>
                <div class="car-slots-controls">
                    <div class="slot-box">
                        <span>${t("Ботов:")}</span>
                        <input type="number" min="1" max="50" value="${parseInt(car.slots) || 1}" data-idx="${idx}" class="inp-t-slots">
                    </div>
                    <button class="btn-small" data-del-t="${idx}" title="${t("Удалить")}">
                        <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.5"/></svg>
                    </button>
                </div>
            `;
            attachCarHoverEvents(row, car);
            trafficCarsContainer.appendChild(row);
        });
    }

    playerCarsContainer.querySelectorAll('.inp-p-slots').forEach(inp => {
        inp.addEventListener('change', (e) => { appState.playerCars[e.target.dataset.idx].slots = parseInt(e.target.value) || 1; updateDashboardSummary(); });
    });
    playerCarsContainer.querySelectorAll('[data-del-p]').forEach(btn => {
        btn.addEventListener('click', (e) => { appState.playerCars.splice(e.currentTarget.dataset.delP, 1); renderSelectedCarsColumns(); updateDashboardSummary(); });
    });

    trafficCarsContainer.querySelectorAll('.inp-t-slots').forEach(inp => {
        inp.addEventListener('change', (e) => { appState.trafficCars[e.target.dataset.idx].slots = parseInt(e.target.value) || 1; updateDashboardSummary(); });
    });
    trafficCarsContainer.querySelectorAll('[data-del-t]').forEach(btn => {
        btn.addEventListener('click', (e) => { appState.trafficCars.splice(e.currentTarget.dataset.delT, 1); renderSelectedCarsColumns(); updateDashboardSummary(); });
    });
}

document.getElementById('clear-player-cars-btn').addEventListener('click', () => { appState.playerCars = []; renderSelectedCarsColumns(); updateDashboardSummary(); });
document.getElementById('clear-traffic-cars-btn').addEventListener('click', () => { appState.trafficCars = []; renderSelectedCarsColumns(); updateDashboardSummary(); });

const profilesListContainer = document.getElementById('profiles-list-container');
const profileModal = document.getElementById('profile-modal');

async function loadProfilesList() {
    appState.profiles = await ipcRenderer.invoke('profiles:list');
    renderProfilesList();
}

function renderProfilesList() {
    profilesListContainer.innerHTML = '';
    if (appState.profiles.length === 0) {
        profilesListContainer.innerHTML = `<div style="padding:20px; color:var(--text-dim); font-size:12.5px;">${t("Сохраненных профилей пока нет.")}</div>`;
        return;
    }

    appState.profiles.forEach(prof => {
        const item = document.createElement('div');
        item.className = 'profile-item-row';
        item.innerHTML = `
            <span class="profile-item-name">${esc(prof.name)}</span>
            <div class="profile-item-actions">
                <button class="btn-small accent load-prof">${t("Загрузить")}</button>
                <button class="btn-small del-prof" title="${t("Удалить")}">
                    <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.5"/></svg>
                </button>
            </div>
        `;

        item.addEventListener('mouseenter', () => showProfilePreview(prof));
        item.querySelector('.load-prof').addEventListener('click', (e) => { e.stopPropagation(); applyProfile(prof); });
        item.querySelector('.del-prof').addEventListener('click', async (e) => {
            e.stopPropagation();
            await ipcRenderer.invoke('profiles:delete', prof.id);
            showToast(t("Профиль удален"), 'info');
            await loadProfilesList();
        });

        profilesListContainer.appendChild(item);
    });

    if (appState.profiles.length > 0) showProfilePreview(appState.profiles[0]);
}

function showProfilePreview(prof) {
    document.getElementById('preview-title').innerText = prof.name || t("Без названия");
    document.getElementById('prev-track').innerText = prof.trackDisplayName || prof.serverCfg?.SERVER?.TRACK || '—';
    
    const pCount = (prof.playerCars || []).reduce((a, b) => a + (parseInt(b.slots) || 0), 0);
    const tCount = (prof.trafficCars || []).reduce((a, b) => a + (parseInt(b.slots) || 0), 0);
    document.getElementById('prev-cars-count').innerText = `${pCount + tCount} (${t("Игроков")}: ${pCount} / ${t("Ботов")}: ${tCount})`;
    
    document.getElementById('prev-author').innerText = prof.author || t("Не указан");
    const aiOn = prof.extraCfg?.EnableAi;
    const speed = prof.extraCfg?.AiParams?.MaxSpeedKph || 80;
    document.getElementById('prev-ai').innerText = aiOn ? `${t("Включен")} (${speed} км/ч)` : t("Выключен");
    document.getElementById('prev-desc').innerText = prof.description || t("Описание не указано.");
    document.getElementById('prev-date').innerText = prof.dateFormatted || '--.--.--';

    const banner = document.getElementById('preview-banner');
    const trackObj = appState.allTracks.find(t => t.id === prof.serverCfg?.SERVER?.TRACK);
    const layoutObj = trackObj?.layouts.find(l => l.config === (prof.serverCfg?.SERVER?.CONFIG_TRACK || '')) || trackObj?.layouts[0];
    if (layoutObj && layoutObj.previewUrl) banner.style.backgroundImage = `url("${layoutObj.previewUrl}")`;
    else banner.style.backgroundImage = 'none';
}

async function applyProfile(prof) {
    // Загрузка профиля перезаписывает текущие настройки сервера — спрашиваем; автокопия всё равно создаётся при сохранении
    const confirmed = await confirmAction(
        tk('profile.loadTitle', 'Загрузить профиль?'),
        `${tk('profile.loadText', 'Текущие настройки сервера будут заменены профилем')} «${prof.name}». ${tk('profile.loadBackup', 'Предыдущие настройки сохранятся в резервной копии.')}`
    );
    if (!confirmed) return;

    appState.serverCfg = JSON.parse(JSON.stringify(prof.serverCfg || {}));
    appState.extraCfg = JSON.parse(JSON.stringify(prof.extraCfg || {}));
    appState.playerCars = JSON.parse(JSON.stringify(prof.playerCars || [])).filter(pc => appState.allCars.some(ac => ac.id === pc.id));
    appState.trafficCars = JSON.parse(JSON.stringify(prof.trafficCars || [])).filter(tc => appState.allCars.some(ac => ac.id === tc.id));
    if (prof.weatherTimeline) appState.weatherTimeline = JSON.parse(JSON.stringify(prof.weatherTimeline));

    renderTracksDropdown();
    renderSelectedCarsColumns();
    populateSettingsFields();
    renderWeatherTimeline();
    updateDashboardSummary();
    updateTrackSelectButtonUI(); 

    document.getElementById('title-active-profile').innerText = prof.name;
    await saveAllConfigs();
    showToast(t("Профиль загружен") + `: ${prof.name}`, 'success');
}

function openProfileModal() {
    collectSettingsFromUI();
    document.getElementById('prof-name-input').value = '';
    document.getElementById('prof-desc-input').value = '';
    profileModal.classList.remove('hidden');
}

document.getElementById('open-save-profile-btn').addEventListener('click', openProfileModal);
document.getElementById('create-profile-btn').addEventListener('click', openProfileModal);
document.getElementById('prof-cancel-btn').addEventListener('click', () => profileModal.classList.add('hidden'));

document.getElementById('prof-confirm-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('prof-name-input').value.trim();
    const author = document.getElementById('prof-author-input').value.trim() || 'Quaaazi';
    const description = document.getElementById('prof-desc-input').value.trim();

    if (!name) return showToast(t("Введите название профиля"), 'warn');

    collectSettingsFromUI();
    const trackDisplayName = trackSelect.options[trackSelect.selectedIndex]?.text || '';

    const res = await ipcRenderer.invoke('profiles:save', {
        name, author, description, trackDisplayName,
        serverCfg: appState.serverCfg, extraCfg: appState.extraCfg, playerCars: appState.playerCars, trafficCars: appState.trafficCars,
        weatherTimeline: appState.weatherTimeline
    });

    if (res.success) {
        profileModal.classList.add('hidden');
        document.getElementById('title-active-profile').innerText = name;
        showToast(t("Профиль сохранен") + `: ${name}`, 'success');
        await loadProfilesList();
    } else {
        showToast(t("Ошибка: ") + res.error, 'error');
    }
});

const descInput = document.getElementById('cfg-server-description');
const cmLivePreview = document.getElementById('cm-live-preview');
const mediaModal = document.getElementById('media-modal');
const mediaModalTitle = document.getElementById('media-modal-title');
const mediaImgUrl = document.getElementById('media-img-url');
const mediaTargetUrl = document.getElementById('media-target-url');
const mediaLinkGroup = document.getElementById('media-link-group');

function renderCmDescriptionPreview() {
    const raw = descInput.value || '';
    if (!raw.trim()) {
        cmLivePreview.innerHTML = `<span style="color:var(--text-dim);">${t("Описание пустое...")}</span>`;
        return;
    }

    let html = esc(raw);
    html = html.replace(/\[url=([^\]]+)\]\s*\[img\]([^\[]+)\[\/img\]\s*\[\/url\]/gi, (m, linkUrl, imgUrl) => `<a href="${linkUrl.trim()}" data-ext-link="${linkUrl.trim()}"><img src="${imgUrl.trim()}" alt="Banner"></a>`);
    html = html.replace(/\[img\]([^\[]+)\[\/img\]/gi, (m, imgUrl) => `<img src="${imgUrl.trim()}" alt="Image">`);
    html = html.replace(/\[url=([^\]]+)\]([^\[]+)\[\/url\]/gi, (m, linkUrl, text) => `<a href="${linkUrl.trim()}" data-ext-link="${linkUrl.trim()}">${text}</a>`);

    cmLivePreview.innerHTML = html;

    cmLivePreview.querySelectorAll('[data-ext-link]').forEach(a => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            const url = a.dataset.extLink;
            if (url && url.startsWith('http')) shell.openExternal(url);
        });
    });
}

descInput.addEventListener('input', renderCmDescriptionPreview);

document.getElementById('btn-add-img').addEventListener('click', () => {
    mediaInsertMode = 'img';
    mediaModalTitle.innerText = t("Добавить картинку");
    mediaImgUrl.value = '';
    mediaLinkGroup.classList.add('hidden');
    mediaModal.classList.remove('hidden');
});

document.getElementById('btn-add-clickable-banner').addEventListener('click', () => {
    mediaInsertMode = 'clickable';
    mediaModalTitle.innerText = t("Добавить кликабельную картинку (Баннер)");
    mediaImgUrl.value = '';
    mediaTargetUrl.value = '';
    mediaLinkGroup.classList.remove('hidden');
    mediaModal.classList.remove('hidden');
});

document.getElementById('btn-add-link').addEventListener('click', () => {
    const prefix = descInput.value && !descInput.value.endsWith('\n') ? '\n' : '';
    descInput.value += `${prefix}[url=https://discord.gg/invite]Наш Discord сервер[/url]`;
    renderCmDescriptionPreview();
});

document.getElementById('media-cancel-btn').addEventListener('click', () => mediaModal.classList.add('hidden'));

document.getElementById('media-insert-btn').addEventListener('click', () => {
    const img = mediaImgUrl.value.trim();
    const link = mediaTargetUrl.value.trim();

    if (!img) return showToast(t("Укажите ссылку на картинку"), 'warn');

    const prefix = descInput.value && !descInput.value.endsWith('\n') ? '\n' : '';
    if (mediaInsertMode === 'clickable' && link) descInput.value += `${prefix}[url=${link}][img]${img}[/img][/url]`;
    else descInput.value += `${prefix}[img]${img}[/img]`;

    mediaModal.classList.add('hidden');
    renderCmDescriptionPreview();
    showToast(t("Баннер добавлен в описание"), 'success');
});

function populateSettingsFields() {
    const s = appState.serverCfg.SERVER || {};
    
    document.getElementById('cfg-server-name').value = s.NAME || 'AssettoServer';
    document.getElementById('cfg-admin-pass').value = String(s.ADMIN_PASSWORD ?? '');
    document.getElementById('cfg-admin-pass').classList.remove('input-error');
    document.getElementById('cfg-udp-port').value = s.UDP_PORT || 9600;
    document.getElementById('cfg-tcp-port').value = s.TCP_PORT || 9600;
    document.getElementById('cfg-http-port').value = s.HTTP_PORT || 8081;

    const absSelect = document.getElementById('cfg-abs');
    const tcSelect = document.getElementById('cfg-tc');
    
    if (absSelect && tcSelect) {
        const absOpts = ["Запрещено (0)", "Только заводской (1)", "Разрешено всем (2)"];
        const absOptsEn = ["Prohibited (0)", "Factory only (1)", "Allowed for all (2)"];
        const tcOpts = ["Запрещено (0)", "Только заводской (1)", "Разрешено всем (2)"];
        const tcOptsEn = ["Prohibited (0)", "Factory only (1)", "Allowed for all (2)"];

        Array.from(absSelect.options).forEach((opt, i) => { opt.text = (currentLang === 'en') ? absOptsEn[i] : absOpts[i]; });
        Array.from(tcSelect.options).forEach((opt, i) => { opt.text = (currentLang === 'en') ? tcOptsEn[i] : tcOpts[i]; });

        absSelect.value = s.ABS_ALLOWED ?? 1;
        tcSelect.value = s.TC_ALLOWED ?? 1;
    }

    document.getElementById('cfg-damage').value = s.DAMAGE_MULTIPLIER ?? 0;
    document.getElementById('cfg-fuel').value = s.FUEL_RATE ?? 0;
    document.getElementById('cfg-tyre-wear').value = s.TYRE_WEAR_RATE ?? 0;
    document.getElementById('cfg-autoclutch').checked = s.AUTOCLUTCH_ALLOWED == 1;
    document.getElementById('cfg-tyre-blankets').checked = s.TYRE_BLANKETS_ALLOWED == 1;

    const ex = appState.extraCfg || {};
    const ai = ex.AiParams || {};

    document.getElementById('cfg-wrong-way').checked = ex.DisableWrongWayPenalty ?? false;

    descInput.value = ex.ServerDescription || '';
    renderCmDescriptionPreview();

    document.getElementById('ai-enable').checked = ex.EnableAi ?? true;
    document.getElementById('ai-two-way').checked = ai.TwoWayTraffic ?? false;
    document.getElementById('ai-hide-nametags').checked = ai.HideAiCars ?? true;
    document.getElementById('ai-weather-fx').checked = ex.EnableWeatherFx ?? true;
    document.getElementById('cfg-rcon-port').value = ex.RconPort ?? DEFAULT_RCON_PORT;
    document.getElementById('cfg-steam-auth').checked = ex.UseSteamAuth ?? false;
    document.getElementById('cfg-ignore-errors').checked = Boolean(ex.IgnoreConfigurationErrors && Object.values(ex.IgnoreConfigurationErrors).some(Boolean));
    document.getElementById('ai-force-lights').checked = ex.ForceLights ?? false;
    document.getElementById('ai-anti-afk').checked = ex.EnableAntiAfk ?? true;

    bindSlider('ai-per-player', 'val-ai-per-player', ai.AiPerPlayerTargetCount ?? 30, '');
    bindSlider('ai-max-target', 'val-ai-max-target', ai.MaxAiTargetCount ?? 250, '');
    bindSlider('ai-max-speed', 'val-ai-max-speed', ai.MaxSpeedKph ?? 80, ' км/ч');
    bindSlider('ai-lane-offset', 'val-ai-lane-offset', ai.RightLaneOffsetKph ?? 15, ' км/ч');
    bindSlider('ai-safety-dist', 'val-ai-safety-dist', ai.MinAiSafetyDistanceMeters ?? 10, ' м');
}

function bindSlider(sliderId, labelId, initialVal, suffix) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(labelId);
    slider.value = initialVal;
    label.innerText = initialVal + suffix;
    slider.oninput = () => { label.innerText = slider.value + suffix; };
}

function collectSettingsFromUI() {
    if (!appState.serverCfg.SERVER) appState.serverCfg.SERVER = {};
    const s = appState.serverCfg.SERVER;

    s.TRACK = trackSelect.value;
    s.CONFIG_TRACK = trackConfigSelect.value || '';
    s.NAME = document.getElementById('cfg-server-name').value || 'AssettoServer';
    
    s.ADMIN_PASSWORD = document.getElementById('cfg-admin-pass').value.trim();

    s.UDP_PORT = parseInt(document.getElementById('cfg-udp-port').value) || 9600;
    s.TCP_PORT = parseInt(document.getElementById('cfg-tcp-port').value) || 9600;
    s.HTTP_PORT = parseInt(document.getElementById('cfg-http-port').value) || 8081;
    s.REGISTER_TO_LOBBY = 0;

    s.ABS_ALLOWED = parseInt(document.getElementById('cfg-abs').value);
    s.TC_ALLOWED = parseInt(document.getElementById('cfg-tc').value);
    s.DAMAGE_MULTIPLIER = parseInt(document.getElementById('cfg-damage').value) || 0;
    s.FUEL_RATE = parseInt(document.getElementById('cfg-fuel').value) || 0;
    s.TYRE_WEAR_RATE = parseInt(document.getElementById('cfg-tyre-wear').value) || 0;
    s.AUTOCLUTCH_ALLOWED = document.getElementById('cfg-autoclutch').checked ? 1 : 0;
    s.TYRE_BLANKETS_ALLOWED = document.getElementById('cfg-tyre-blankets').checked ? 1 : 0;

    if (!appState.extraCfg.AiParams) appState.extraCfg.AiParams = {};
    const ex = appState.extraCfg;
    const ai = ex.AiParams;

    ex.DisableWrongWayPenalty = document.getElementById('cfg-wrong-way').checked;
    ex.EnableServerDetails = true;
    ex.ServerDescription = descInput.value || '';

    ex.EnableAi = appState.currentTrackSupportsAi && document.getElementById('ai-enable').checked && appState.trafficCars.length > 0;
    ex.EnableWeatherFx = document.getElementById('ai-weather-fx').checked;
    ex.RconPort = Math.min(65535, Math.max(0, parseInt(document.getElementById('cfg-rcon-port').value) || 0));
    ex.UseSteamAuth = document.getElementById('cfg-steam-auth').checked;
    if (document.getElementById('cfg-ignore-errors').checked) {
        ex.IgnoreConfigurationErrors = { MissingCarChecksums: true, MissingTrackParams: true, WrongServerDetails: true, UnsafeAdminWhitelist: true };
    } else {
        delete ex.IgnoreConfigurationErrors;
    }
    ex.ForceLights = document.getElementById('ai-force-lights').checked;
    ex.EnableAntiAfk = document.getElementById('ai-anti-afk').checked;

    ai.TwoWayTraffic = document.getElementById('ai-two-way').checked;
    ai.HideAiCars = document.getElementById('ai-hide-nametags').checked;
    ai.AiPerPlayerTargetCount = parseInt(document.getElementById('ai-per-player').value);
    ai.MaxAiTargetCount = parseInt(document.getElementById('ai-max-target').value);
    ai.MaxSpeedKph = parseInt(document.getElementById('ai-max-speed').value);
    ai.RightLaneOffsetKph = parseInt(document.getElementById('ai-lane-offset').value);
    ai.MinAiSafetyDistanceMeters = parseInt(document.getElementById('ai-safety-dist').value);
}

function updateDashboardSummary() {
    const tName = trackSelect.options[trackSelect.selectedIndex]?.text || t("Не выбрана");
    document.getElementById('dash-track-name').innerText = tName;

    const pSlots = appState.playerCars.reduce((acc, c) => acc + (parseInt(c.slots) || 0), 0);
    if (appState.currentTrackSupportsAi) {
        document.getElementById('dash-slots-count').innerText = `${pSlots} ${t("Игроков")} + ${t("Трафик")}`;
        document.getElementById('dash-cars-models').innerText = `${t("Моделей")}: ${appState.playerCars.length} / ${appState.trafficCars.length}`;
    } else {
        document.getElementById('dash-slots-count').innerText = `${pSlots} ${t("Слотов игроков")}`;
        document.getElementById('dash-cars-models').innerText = `${t("Моделей")}: ${appState.playerCars.length}`;
    }

    const udp = document.getElementById('cfg-udp-port').value || 9600;
    const http = document.getElementById('cfg-http-port').value || 8081;
    document.getElementById('dash-ports').innerText = `UDP/TCP: ${udp}  •  HTTP: ${http}`;
}

const downloadBar = document.getElementById('download-bar');
const downloadText = document.getElementById('download-text');
const downloadPercent = document.getElementById('download-percent');
const downloadFill = document.getElementById('download-fill');

ipcRenderer.on('download:progress', (e, { percent, text }) => {
    downloadBar.classList.remove('hidden');
    downloadText.innerText = text;
    downloadPercent.innerText = `${percent}%`;
    downloadFill.style.width = `${percent}%`;
});

async function triggerAssettoServerDownload() {
    downloadBar.classList.remove('hidden');
    const res = await ipcRenderer.invoke('server:downloadUpdate');
    if (res.success) {
        appState.installedVersion = res.version;
        updateVersionLabels();
        showToast(`AssettoServer (${res.version}) ${t("Обновлен")}`, 'success');
        appendLog('info', `AssettoServer update: ${res.version}`);
    } else {
        showToast(`${t("Ошибка: ")}${res.error}`, 'error');
        appendLog('error', `Error: ${res.error}`);
    }
    setTimeout(() => downloadBar.classList.add('hidden'), 2500);
}

document.getElementById('sys-update-as-btn').addEventListener('click', triggerAssettoServerDownload);

ipcRenderer.on('server:missingExe', async () => {
    showToast(t("Скачивание ядра сервера..."), 'info');
    await triggerAssettoServerDownload();
    await requestServerStart();
});

async function saveAllConfigs() {
    if (appState.playerCars.length === 0 && appState.allCars.length > 0) {
        const firstCar = appState.allCars.find(c => !c.isTraffic) || appState.allCars[0];
        appState.playerCars.push({
            id: firstCar.id, name: firstCar.name, slots: 2, skins: firstCar.skins, previewUrl: firstCar.previewUrl, badgeUrl: firstCar.badgeUrl, brand: firstCar.brand, isTraffic: firstCar.isTraffic
        });
        renderSelectedCarsColumns();
    }

    collectSettingsFromUI();
    updateDashboardSummary();

    // AssettoServer не запустится с паролем короче 8 символов — останавливаем сохранение и показываем поле
    const passInput = document.getElementById('cfg-admin-pass');
    if (String(appState.serverCfg.SERVER.ADMIN_PASSWORD).length < 8) {
        passInput.classList.add('input-error');
        document.querySelector('[data-tab="tab-rules"]').click();
        passInput.focus();
        showToast(t("Пароль администратора должен быть не короче 8 символов"), 'error');
        return false;
    }
    passInput.classList.remove('input-error');

    const saveBtn = document.getElementById('save-all-btn');
    saveBtn.disabled = true;
    const res = await ipcRenderer.invoke('config:save', {
        serverCfg: appState.serverCfg,
        extraCfg: appState.extraCfg,
        playerCars: appState.playerCars,
        trafficCars: appState.trafficCars,
        trackSupportsAi: appState.currentTrackSupportsAi,
        weatherTimeline: appState.weatherTimeline
    });

    saveBtn.disabled = false;
    setSaveProgressLabel(null);

    if (res.success) {
        showToast(`${t("Настройки сохранены")} (${res.totalSlots} ${t("слотов")})`, 'success');
        refreshPortStatus();
        appendLog('info', `Configuration updated. Slots: ${res.totalSlots}, AI: ${res.aiEnabled ? 'ON' : 'OFF'}`);
        return true;
    } else {
        showToast(`${t("Ошибка: ")}${res.error}`, 'error');
        appendLog('error', `Save error: ${res.error}`);
        return false;
    }
}

document.getElementById('save-all-btn').addEventListener('click', saveAllConfigs);

document.getElementById('start-server-btn').addEventListener('click', async () => {
    const ok = await saveAllConfigs();
    if (ok) await requestServerStart();
});

document.getElementById('stop-server-btn').addEventListener('click', () => {
    ipcRenderer.send('server:stop');
});

const consoleOutput = document.getElementById('console-output');

function getFormattedTime() {
    const d = new Date();
    return d.toTimeString().split(' ')[0];
}

function classifyLogLine(line, defaultType) {
    if (line.includes('Starting update loop') || line.includes('Starting HTTP server') || line.includes('Starting TCP server') || line.includes('Starting UDP server') || line.includes('СЕРВЕР ЗАПУЩЕН')) {
        return { category: 'success', badge: t("ГОТОВО") };
    }
    if (defaultType === 'error' || line.includes('[ERR]') || line.includes('[FTL]') || line.includes('Exception') || line.includes('   at ') || line.includes(' ---> ')) {
        return { category: 'error', badge: t("ОШИБКА") };
    }
    if (defaultType === 'warn' || line.includes('[WRN]') || line.includes('Warning') || line.includes('No data.acd found') || line.includes('геолокации')) {
        return { category: 'warn', badge: t("ВНИМАНИЕ") };
    }
    return { category: 'info', badge: t("ЛОГ") };
}

function appendLogToModularBlock(category, badgeText, cleanLine) {
    const now = Date.now();

    if (lastLogGroup.category === category && lastLogGroup.bodyEl && (now - lastLogGroup.timestamp) < 4000) {
        const item = document.createElement('div');
        item.className = 'log-item';
        item.innerText = cleanLine;
        lastLogGroup.bodyEl.appendChild(item);
        lastLogGroup.timestamp = now;
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
        return;
    }

    const group = document.createElement('div');
    group.className = `log-group group-${category}`;

    const header = document.createElement('div');
    header.className = 'log-group-header';
    header.innerHTML = `<span class="log-badge">${badgeText}</span><span class="log-time">${getFormattedTime()}</span>`;

    const body = document.createElement('div');
    body.className = 'log-group-body';

    const item = document.createElement('div');
    item.className = 'log-item';
    item.innerText = cleanLine;

    body.appendChild(item);
    group.appendChild(header);
    group.appendChild(body);
    consoleOutput.appendChild(group);

    lastLogGroup = { category, bodyEl: body, timestamp: now };
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function appendLog(type, text) {
    const lines = text.split(/\r?\n/);

    for (let rawLine of lines) {
        if (!rawLine.trim()) continue;
        let line = rawLine.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+[+-]\d{2}:\d{2}\s+/, '');

        if (line.includes('Failed to get IP geolocation parameters')) {
            appendLogToModularBlock('warn', t("ВНИМАНИЕ"), '[WRN] Проверка геолокации IP пропущена. Сервер работает в обычном режиме.');
            continue;
        }

        if (line.includes('IpApiGeoParamsProvider') || line.includes('GeoParamsManager') || line.includes('System.Net.Http') || line.includes('System.Net.Sockets.Socket') || line.includes('System.IO.IOException: Unable to read data') || line.includes('End of inner exception stack trace')) {
            continue;
        }

        const { category, badge } = classifyLogLine(line, type);
        appendLogToModularBlock(category, badge, line);

        if (line.includes('Starting update loop')) {
            appendLogToModularBlock('success', t("ГОТОВО"), '>>> СЕРВЕР ЗАПУЩЕН И РАБОТАЕТ. МОЖНО ИГРАТЬ!');
        }
    }
}

ipcRenderer.on('server:log', (e, { type, text }) => appendLog(type, text));

ipcRenderer.on('server:status', (e, isRunning) => {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    const startBtn = document.getElementById('start-server-btn');
    const stopBtn = document.getElementById('stop-server-btn');

    if (isRunning) {
        dot.className = 'dot online';
        txt.innerText = t("СЕРВЕР ЗАПУЩЕН (ОНЛАЙН)");
        txt.style.color = '#10b981';
        startBtn.disabled = true;
        stopBtn.disabled = false;
    } else {
        dot.className = 'dot offline';
        txt.innerText = t("СЕРВЕР ОСТАНОВЛЕН");
        txt.style.color = 'var(--text-muted)';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
});

document.getElementById('clear-log-btn').addEventListener('click', () => {
    consoleOutput.innerHTML = '';
    lastLogGroup = { category: null, bodyEl: null, timestamp: 0 };
});
document.getElementById('open-server-dir-btn').addEventListener('click', () => ipcRenderer.send('shell:openFolder', appState.serverDir));
document.getElementById('sys-open-server-btn').addEventListener('click', () => ipcRenderer.send('shell:openFolder', appState.serverDir));

document.getElementById('sys-autodetect-btn').addEventListener('click', async () => {
    const found = await ipcRenderer.invoke('launcher:autoDetectAC');
    if (found) {
        await ipcRenderer.invoke('server:setup', found);
        appState.acPath = found;
        document.getElementById('sys-ac-path').value = found;
        showToast(`${t("Игра найдена")}: ${found}`, 'success');
        await loadAllData();
    } else {
        showToast(t("Автопоиск не обнаружил игру. Укажите папку через «Обзор...»"), 'warn');
    }
});

document.getElementById('sys-change-ac-btn').addEventListener('click', () => {
    document.getElementById('setup-overlay').classList.remove('hidden');
});

initApp();

// --- ЛОГИКА LIVE МОНИТОРИНГА И RCON ---
const livePlayersContainer = document.getElementById('live-players-container');
const livePlayersBadge = document.getElementById('live-players-badge');
const liveBroadcastInput = document.getElementById('live-broadcast-input');
const liveBroadcastBtn = document.getElementById('live-broadcast-btn');

function renderLivePlayers(players = []) {
    if (!livePlayersContainer) return;

    livePlayersBadge.innerText = `${players.length} ${currentLang === 'en' ? 'online' : 'онлайн'}`;
    livePlayersBadge.className = players.length > 0 ? 'badge ok mono' : 'badge neutral mono';
    updateLiveCollapse(players.length);

    if (players.length === 0) {
        livePlayersContainer.innerHTML = `<div class="live-empty-state">${t("На сервере пока никого нет. Ожидание подключения игроков...")}</div>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    players.forEach(p => {
        const carObj = appState.allCars.find(c => p.car.startsWith(c.id));
        const carTitle = carObj ? carObj.name : p.car;

        const row = document.createElement('div');
        row.className = 'live-player-row';
        row.innerHTML = `
            <div class="live-player-info">
                <div class="live-player-name">#${esc(p.sessionId)} ${esc(p.name)}</div>
                <div class="live-player-meta mono" title="SteamID: ${esc(p.steamId)} | IP: ${esc(p.ip)}">${esc(carTitle)} &bull; ${esc(p.ip)}</div>
            </div>
            <div class="live-player-actions">
                <button class="btn-small btn-kick" data-kick="${p.sessionId}" title="Кикнуть игрока">Кик</button>
                <button class="btn-small btn-ban" data-ban="${p.sessionId}" title="Забанить SteamID в blacklist.txt">Бан</button>
            </div>
        `;

        row.querySelector('[data-kick]').addEventListener('click', async () => {
            await ipcRenderer.invoke('live:kick', p.sessionId);
            showToast(`Игрок ${p.name} кикнут`, 'warn');
        });

        row.querySelector('[data-ban]').addEventListener('click', async () => {
            await ipcRenderer.invoke('live:ban', p.sessionId);
            showToast(`Игрок ${p.name} забанен (SteamID в черном списке)`, 'error');
        });

        fragment.appendChild(row);
    });

    livePlayersContainer.innerHTML = '';
    livePlayersContainer.appendChild(fragment);
}

ipcRenderer.on('live:playersUpdate', (e, players) => renderLivePlayers(players));

if (liveBroadcastBtn && liveBroadcastInput) {
    const sendBroadcast = async () => {
        const msg = liveBroadcastInput.value.trim();
        if (!msg) return;
        const res = await ipcRenderer.invoke('live:broadcast', msg);
        if (res.success) {
            liveBroadcastInput.value = '';
            showToast(currentLang === 'en' ? 'Message sent to server chat' : 'Сообщение отправлено в чат сервера', 'success');
        } else {
            showToast(currentLang === 'en' ? 'Server is not running' : 'Сервер сейчас не запущен', 'warn');
        }
    };

    liveBroadcastBtn.addEventListener('click', sendBroadcast);
    liveBroadcastInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendBroadcast();
    });
}

// --- ЛОГИКА DISCORD WEBHOOKS ---
const webhookUrlInput = document.getElementById('webhook-url-input');
const webhookEnableCheck = document.getElementById('webhook-enable-check');
const webhookSaveBtn = document.getElementById('webhook-save-btn');
const webhookTestBtn = document.getElementById('webhook-test-btn');

if (webhookSaveBtn) {
    const saveWebhook = async () => {
        const url = webhookUrlInput.value.trim();
        const enabled = webhookEnableCheck.checked;
        await ipcRenderer.invoke('webhook:save', { url, enabled });
        showToast(currentLang === 'en' ? 'Discord Webhook saved!' : 'Настройки Discord Webhook сохранены!', 'success');
    };

    webhookSaveBtn.addEventListener('click', saveWebhook);
    webhookEnableCheck.addEventListener('change', saveWebhook);

    webhookTestBtn.addEventListener('click', async () => {
        const url = webhookUrlInput.value.trim();
        if (!url.startsWith('https://discord')) {
            return showToast(currentLang === 'en' ? 'Enter a valid Discord Webhook URL' : 'Введите корректную ссылку Discord Webhook', 'warn');
        }
        webhookTestBtn.disabled = true;
        const res = await ipcRenderer.invoke('webhook:test', { url });
        webhookTestBtn.disabled = false;
        if (res.success) {
            showToast(currentLang === 'en' ? 'Test message sent to Discord!' : 'Тестовое сообщение доставлено в Discord!', 'success');
        } else {
            showToast(currentLang === 'en' ? 'Webhook send error. Check URL.' : 'Не удалось отправить вебхук. Проверьте ссылку.', 'error');
        }
    });
}

// --- УПАКОВЩИК МОД-ПАКОВ ---
const packModpackBtn = document.getElementById('pack-modpack-btn');
if (packModpackBtn) {
    packModpackBtn.addEventListener('click', async () => {
        packModpackBtn.disabled = true;
        packModpackBtn.innerText = currentLang === 'en' ? 'Packing modpack...' : 'Упаковка мод-пака...';
        
        showToast(currentLang === 'en' ? 'Collecting tracks and cars...' : 'Сборка файлов карты и машин...', 'info');

        const res = await ipcRenderer.invoke('modpack:create');
        
        packModpackBtn.disabled = false;
        packModpackBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>${currentLang === 'en' ? 'Pack modpack for friends (.zip)' : 'Упаковать мод-пак для друзей (.zip)'}</span>
        `;

        if (res.canceled) return;
        if (res.success) {
            showToast(currentLang === 'en' ? 'Modpack successfully created!' : 'Мод-пак успешно создан!', 'success');
            // Опционально открываем папку с архивом
            shell.showItemInFolder(res.path);
        } else {
            showToast(`${t("Ошибка: ")}${res.error}`, 'error');
        }
    });
}

// --- РЕПОЗИТОРИЙ ПЛАГИНОВ ---
const pluginsGrid = document.getElementById('plugins-grid');
const refreshPluginsBtn = document.getElementById('refresh-plugins-btn');

async function loadPluginsRepository() {
    if (!pluginsGrid) return;
    pluginsGrid.innerHTML = `<div style="color: var(--text-dim); padding: 20px;">Загрузка репозитория...</div>`;

    const plugins = await ipcRenderer.invoke('plugins:list');

    if (!plugins || plugins.length === 0) {
        pluginsGrid.innerHTML = `<div style="color: var(--text-dim); padding: 20px;">Нет доступных плагинов в реестре.</div>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    plugins.forEach(p => {
        const card = document.createElement('div');
        card.className = 'track-card-item';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.padding = '16px';
        card.style.justifyContent = 'space-between';

        card.innerHTML = `
            <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <span style="font-size: 14px; font-weight: 700; color: var(--text-main);">${esc(p.name)}</span>
                    <span class="badge mono" style="font-size: 9.5px;">v${esc(p.version)}</span>
                </div>
                <div style="font-size: 11.5px; color: var(--text-muted); margin-bottom: 6px;">Автор: <span style="color: var(--text-main);">${esc(p.author)}</span></div>
                <p style="font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 16px;">${esc(p.description)}</p>
            </div>
            <div>
                ${p.installed 
                    ? `<button class="btn danger full-width" data-uninstall="${esc(p.id)}">Удалить плагин</button>`
                    : `<button class="btn primary full-width" data-install="${esc(p.id)}">Установить</button>`
                }
            </div>
        `;

        const installBtn = card.querySelector('[data-install]');
        const uninstallBtn = card.querySelector('[data-uninstall]');

        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                installBtn.disabled = true;
                installBtn.innerText = 'Загрузка...';
                const res = await ipcRenderer.invoke('plugins:install', p.id);
                if (res.success) {
                    showToast(`Плагин "${p.name}" успешно установлен!`, 'success');
                    loadPluginsRepository();
                } else {
                    showToast(`Ошибка установки: ${res.error}`, 'error');
                    installBtn.disabled = false;
                    installBtn.innerText = 'Установить';
                }
            });
        }

        if (uninstallBtn) {
            uninstallBtn.addEventListener('click', async () => {
                uninstallBtn.disabled = true;
                uninstallBtn.innerText = 'Удаление...';
                const res = await ipcRenderer.invoke('plugins:uninstall', p.id);
                if (res.success) {
                    showToast(`Плагин "${p.name}" удален`, 'info');
                    loadPluginsRepository();
                } else {
                    showToast(`Ошибка: ${res.error}`, 'error');
                    uninstallBtn.disabled = false;
                    uninstallBtn.innerText = 'Удалить плагин';
                }
            });
        }

        fragment.appendChild(card);
    });

    pluginsGrid.innerHTML = '';
    pluginsGrid.appendChild(fragment);
}

if (refreshPluginsBtn) {
    refreshPluginsBtn.addEventListener('click', loadPluginsRepository);
}

// Загружаем список плагинов при переключении на вкладку
document.querySelectorAll('[data-tab="tab-plugins"]').forEach(tab => {
    tab.addEventListener('click', loadPluginsRepository);
});

// =====================================================================
// ТАЙМЛАЙН ПОГОДЫ И ВРЕМЕНИ СУТОК (CSP WEATHER FX)
// =====================================================================
// rain: 0..1 — интенсивность осадков для графика (сам дождь CSP берёт из типа погоды)
const WX_TYPES = [
    { key: 'Clear', icon: '☀️', ru: 'Ясно', en: 'Clear', rain: 0 },
    { key: 'FewClouds', icon: '🌤️', ru: 'Малооблачно', en: 'Few clouds', rain: 0 },
    { key: 'ScatteredClouds', icon: '⛅', ru: 'Переменная облачность', en: 'Scattered clouds', rain: 0 },
    { key: 'BrokenClouds', icon: '🌥️', ru: 'Облачно', en: 'Broken clouds', rain: 0 },
    { key: 'OvercastClouds', icon: '☁️', ru: 'Пасмурно', en: 'Overcast', rain: 0 },
    { key: 'Mist', icon: '🌫️', ru: 'Дымка', en: 'Mist', rain: 0 },
    { key: 'Fog', icon: '🌫️', ru: 'Туман', en: 'Fog', rain: 0 },
    { key: 'Haze', icon: '🌁', ru: 'Мгла', en: 'Haze', rain: 0 },
    { key: 'Windy', icon: '💨', ru: 'Ветрено', en: 'Windy', rain: 0 },
    { key: 'LightDrizzle', icon: '🌦️', ru: 'Лёгкая морось', en: 'Light drizzle', rain: 0.12 },
    { key: 'Drizzle', icon: '🌦️', ru: 'Морось', en: 'Drizzle', rain: 0.22 },
    { key: 'LightRain', icon: '🌧️', ru: 'Небольшой дождь', en: 'Light rain', rain: 0.4 },
    { key: 'Rain', icon: '🌧️', ru: 'Дождь', en: 'Rain', rain: 0.65 },
    { key: 'HeavyRain', icon: '🌧️', ru: 'Ливень', en: 'Heavy rain', rain: 0.9 },
    { key: 'LightThunderstorm', icon: '⛈️', ru: 'Слабая гроза', en: 'Light thunderstorm', rain: 0.5 },
    { key: 'Thunderstorm', icon: '⛈️', ru: 'Гроза', en: 'Thunderstorm', rain: 0.75 },
    { key: 'HeavyThunderstorm', icon: '⛈️', ru: 'Сильная гроза', en: 'Heavy thunderstorm', rain: 1 },
    { key: 'LightSnow', icon: '🌨️', ru: 'Небольшой снег', en: 'Light snow', rain: 0.35 },
    { key: 'Snow', icon: '❄️', ru: 'Снег', en: 'Snow', rain: 0.6 },
    { key: 'HeavySnow', icon: '❄️', ru: 'Снегопад', en: 'Heavy snow', rain: 0.85 }
];
const wxType = key => WX_TYPES.find(w => w.key === key) || WX_TYPES[0];

const wxKf = (h, type, ambient, road, extra = {}) => ({ time: h * 60, type, ambient, road, windMin: 0, windMax: 5, windDir: 0, transition: 120, ...extra });
const WX_PRESETS = {
    clear: { timeMult: 1, keyframes: [wxKf(7, 'FewClouds', 14, 16), wxKf(13, 'Clear', 26, 38), wxKf(19, 'Clear', 20, 26), wxKf(23, 'Clear', 15, 17)] },
    rainyEvening: { timeMult: 4, keyframes: [wxKf(16, 'BrokenClouds', 19, 25), wxKf(18, 'OvercastClouds', 17, 20), wxKf(19, 'LightRain', 15, 16, { transition: 300 }), wxKf(21, 'Rain', 13, 13, { windMax: 20 })] },
    storm: { timeMult: 2, keyframes: [wxKf(10, 'ScatteredClouds', 24, 33), wxKf(13, 'OvercastClouds', 22, 27), wxKf(14, 'Thunderstorm', 18, 19, { windMin: 15, windMax: 40, transition: 240 }), wxKf(16, 'LightRain', 17, 18), wxKf(18, 'BrokenClouds', 18, 21)] },
    nightFog: { timeMult: 1, keyframes: [wxKf(1, 'Fog', 7, 7, { transition: 600 }), wxKf(5, 'Mist', 6, 6), wxKf(7, 'FewClouds', 9, 10), wxKf(22, 'Mist', 10, 11)] }
};

let wxSelected = null; // ссылка на выбранный ключевой кадр
const wxTimelineEl = document.getElementById('wx-timeline');
const wxSvg = document.getElementById('wx-timeline-svg');
const wxMarkers = document.getElementById('wx-markers');

const wxFmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
const wxSorted = () => [...appState.weatherTimeline.keyframes].sort((a, b) => a.time - b.time);

// Цвет неба по времени суток (фон таймлайна), плавная интерполяция между опорными точками
const WX_SKY_STOPS = [[0, '#0b1026'], [4.5, '#111833'], [6, '#7c2d12'], [7, '#c2622d'], [8.5, '#3f6fb0'], [12, '#2f6fd6'], [16.5, '#3f6fb0'], [18.5, '#b45325'], [19.5, '#3b2d63'], [21, '#0b1026'], [24, '#0b1026']];
function wxSkyColor(hour) {
    const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    for (let i = 0; i < WX_SKY_STOPS.length - 1; i++) {
        const [h1, c1] = WX_SKY_STOPS[i], [h2, c2] = WX_SKY_STOPS[i + 1];
        if (hour <= h2) {
            const p = (hour - h1) / (h2 - h1 || 1);
            const [a, b] = [rgb(c1), rgb(c2)];
            return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * p)).join(',')})`;
        }
    }
    return WX_SKY_STOPS[0][1];
}

// Кадр, действующий в момент minutes (погода держится до следующей точки, с переходом через полночь)
function wxActiveAt(minutes, sorted) {
    let active = sorted[sorted.length - 1];
    for (const k of sorted) if (k.time <= minutes) active = k;
    return active;
}

// Линейная интерполяция температуры между соседними точками (циклично на 24 часа)
function wxInterpolate(minutes, sorted, field) {
    if (sorted.length === 1) return sorted[0][field];
    const next = sorted.find(k => k.time > minutes) || sorted[0];
    const prev = wxActiveAt(minutes, sorted);
    const span = ((next.time - prev.time) + 1440) % 1440 || 1440;
    const pos = ((minutes - prev.time) + 1440) % 1440;
    return prev[field] + (next[field] - prev[field]) * (pos / span);
}

function renderWeatherTimeline() {
    if (!appState.weatherTimeline || !wxSvg) return;
    const tl = appState.weatherTimeline;
    const sorted = wxSorted();
    if (!wxSelected || !tl.keyframes.includes(wxSelected)) wxSelected = sorted[0] || null;

    // --- SVG: viewBox 1440 (минуты суток) x 100 ---
    const temps = sorted.flatMap(k => [k.ambient, k.road]);
    const tMin = Math.min(...temps) - 4, tMax = Math.max(...temps) + 4;
    const yOf = v => 82 - ((v - tMin) / (tMax - tMin || 1)) * 62;

    let skyStops = '';
    for (let h = 0; h <= 24; h += 0.5) skyStops += `<stop offset="${(h / 24) * 100}%" stop-color="${wxSkyColor(h)}"/>`;

    let rainBars = '';
    for (let m = 0; m < 1440; m += 10) {
        const r = wxType(wxActiveAt(m + 5, sorted).type).rain;
        if (r > 0) rainBars += `<rect class="wx-rain-bar" x="${m + 1}" y="${100 - r * 30}" width="8" height="${r * 30}"/>`;
    }

    const linePts = field => Array.from({ length: 145 }, (_, i) => `${i * 10},${yOf(wxInterpolate(i * 10, sorted, field)).toFixed(2)}`).join(' ');
    const hourLines = Array.from({ length: 23 }, (_, i) => `<line class="wx-hour-line" x1="${(i + 1) * 60}" y1="0" x2="${(i + 1) * 60}" y2="100"/>`).join('');
    const kfLines = sorted.map(k => `<line class="wx-kf-line ${k === wxSelected ? 'active' : ''}" x1="${k.time}" y1="0" x2="${k.time}" y2="100"/>`).join('');

    wxSvg.setAttribute('viewBox', '0 0 1440 100');
    wxSvg.innerHTML = `
        <defs><linearGradient id="wx-sky" x1="0" x2="1" y1="0" y2="0">${skyStops}</linearGradient></defs>
        <rect x="0" y="0" width="1440" height="100" fill="url(#wx-sky)" opacity="0.85"/>
        ${hourLines}${rainBars}${kfLines}
        <polyline class="wx-road-line" points="${linePts('road')}"/>
        <polyline class="wx-temp-line" points="${linePts('ambient')}"/>`;

    // --- HTML-слой: подписи часов и перетаскиваемые маркеры ---
    let html = '';
    for (let h = 0; h < 24; h += 3) html += `<span class="wx-axis-label" style="left:${(h / 24) * 100}%;${h === 0 ? 'transform:none;left:4px;' : ''}">${String(h).padStart(2, '0')}:00</span>`;
    wxMarkers.innerHTML = html;

    sorted.forEach(k => {
        const el = document.createElement('div');
        el.className = `wx-marker ${k === wxSelected ? 'active' : ''}`;
        el.style.left = `${(k.time / 1440) * 100}%`;
        el.title = currentLang === 'en' ? wxType(k.type).en : wxType(k.type).ru;
        el.innerHTML = `<span class="wx-marker-icon">${wxType(k.type).icon}</span><span class="wx-marker-time">${wxFmt(k.time)}</span><span class="wx-marker-temp">${Math.round(k.ambient)}°</span>`;
        el.addEventListener('pointerdown', ev => wxStartDrag(ev, k));
        wxMarkers.appendChild(el);
    });

    // Выключенный таймлайн не затемняем, а помечаем плашкой: на сервер уйдёт только первая точка
    const offBadge = document.getElementById('wx-off-badge');
    offBadge.classList.toggle('visible', !tl.enabled);
    offBadge.innerText = currentLang === 'en' ? 'Timeline off — server uses only the first point' : 'Таймлайн выключен — сервер использует только первую точку';
    renderWeatherEditor();
}

function wxMinutesFromEvent(ev) {
    const rect = wxTimelineEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    return Math.min(1435, Math.round((ratio * 1440) / 5) * 5); // шаг 5 минут
}

function wxStartDrag(ev, keyframe) {
    ev.stopPropagation();
    ev.preventDefault();
    wxSelected = keyframe;
    renderWeatherTimeline();

    const onMove = e => {
        const time = wxMinutesFromEvent(e);
        if (appState.weatherTimeline.keyframes.some(k => k !== keyframe && k.time === time)) return;
        keyframe.time = time;
        renderWeatherTimeline();
    };
    const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        appState.weatherTimeline.keyframes.sort((a, b) => a.time - b.time);
        renderWeatherTimeline();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
}

// Клик по пустому месту шкалы — новая точка с интерполированными значениями
wxTimelineEl?.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.wx-marker') || !appState.weatherTimeline) return;
    const tl = appState.weatherTimeline;
    if (tl.keyframes.length >= 24) return showToast(currentLang === 'en' ? 'Maximum 24 points' : 'Максимум 24 точки', 'warn');
    const time = wxMinutesFromEvent(ev);
    if (tl.keyframes.some(k => k.time === time)) return;
    const sorted = wxSorted();
    const created = {
        ...wxActiveAt(time, sorted), time,
        ambient: Math.round(wxInterpolate(time, sorted, 'ambient')),
        road: Math.round(wxInterpolate(time, sorted, 'road'))
    };
    tl.keyframes.push(created);
    tl.keyframes.sort((a, b) => a.time - b.time);
    wxSelected = created;
    renderWeatherTimeline();
});

// --- Редактор выбранной точки ---
const wxFields = {
    ambient: { id: 'wx-kf-ambient', label: 'val-wx-ambient', suffix: ' °C' },
    road: { id: 'wx-kf-road', label: 'val-wx-road', suffix: ' °C' },
    transition: { id: 'wx-kf-transition', label: 'val-wx-transition', suffix: ' с' },
    windMin: { id: 'wx-kf-wind-min', label: 'val-wx-wind-min', suffix: ' км/ч' },
    windMax: { id: 'wx-kf-wind-max', label: 'val-wx-wind-max', suffix: ' км/ч' },
    windDir: { id: 'wx-kf-wind-dir', label: 'val-wx-wind-dir', suffix: '°' }
};

function renderWeatherEditor() {
    const tl = appState.weatherTimeline;
    document.getElementById('wx-enabled').checked = tl.enabled;
    document.getElementById('wx-time-mult').value = tl.timeMult;
    document.getElementById('val-wx-time-mult').innerText = tl.timeMult === 0 ? (currentLang === 'en' ? 'frozen' : 'стоп') : `x${tl.timeMult}`;

    const k = wxSelected;
    if (!k) return;
    document.getElementById('wx-kf-title').innerText = `WEATHER_${wxSorted().indexOf(k)} · ${wxFmt(k.time)}`;
    document.getElementById('wx-kf-time').value = wxFmt(k.time);
    document.getElementById('wx-kf-type').value = k.type;
    for (const [field, cfg] of Object.entries(wxFields)) {
        document.getElementById(cfg.id).value = k[field];
        document.getElementById(cfg.label).innerText = k[field] + cfg.suffix;
    }
    document.getElementById('wx-delete-kf-btn').disabled = tl.keyframes.length <= 1;
}

function refreshWeatherTypeLabels() {
    const typeSelect = document.getElementById('wx-kf-type');
    if (!typeSelect) return;
    const current = typeSelect.value;
    typeSelect.innerHTML = WX_TYPES.map(w => `<option value="${w.key}">${w.icon} ${currentLang === 'en' ? w.en : w.ru}</option>`).join('');
    if (current) typeSelect.value = current;
}

function initWeatherEditor() {
    const typeSelect = document.getElementById('wx-kf-type');
    refreshWeatherTypeLabels();
    typeSelect.onchange = () => { if (wxSelected) { wxSelected.type = typeSelect.value; renderWeatherTimeline(); } };

    for (const [field, cfg] of Object.entries(wxFields)) {
        document.getElementById(cfg.id).oninput = e => {
            if (!wxSelected) return;
            wxSelected[field] = parseInt(e.target.value);
            renderWeatherTimeline();
        };
    }

    document.getElementById('wx-kf-time').onchange = e => {
        if (!wxSelected || !e.target.value) return;
        const [h, m] = e.target.value.split(':').map(Number);
        wxSelected.time = h * 60 + m;
        appState.weatherTimeline.keyframes.sort((a, b) => a.time - b.time);
        renderWeatherTimeline();
    };

    document.getElementById('wx-enabled').onchange = e => { appState.weatherTimeline.enabled = e.target.checked; renderWeatherTimeline(); };
    document.getElementById('wx-time-mult').oninput = e => { appState.weatherTimeline.timeMult = parseInt(e.target.value); renderWeatherEditor(); };

    document.getElementById('wx-delete-kf-btn').onclick = () => {
        const tl = appState.weatherTimeline;
        if (!wxSelected || tl.keyframes.length <= 1) return;
        tl.keyframes = tl.keyframes.filter(k => k !== wxSelected);
        wxSelected = null;
        renderWeatherTimeline();
    };

    document.getElementById('wx-preset-select').onchange = e => {
        const preset = WX_PRESETS[e.target.value];
        if (!preset) return;
        appState.weatherTimeline = { enabled: true, timeMult: preset.timeMult, keyframes: JSON.parse(JSON.stringify(preset.keyframes)) };
        wxSelected = null;
        e.target.value = '';
        renderWeatherTimeline();
        showToast(currentLang === 'en' ? 'Preset applied. Save settings to write config.' : 'Шаблон применён. Нажмите «Сохранить настройки».', 'info');
    };

    document.getElementById('wx-apply-now-btn').onclick = async () => {
        if (!wxSelected) return;
        // Номер WEATHER_N совпадает с конфигом только после сохранения, поэтому шлём время и CSP-погоду
        const res = await ipcRenderer.invoke('weather:applyNow', { keyframe: wxSelected, index: null });
        if (res.success) showToast(currentLang === 'en' ? 'Weather sent to server' : 'Погода отправлена на сервер', 'success');
        else showToast(currentLang === 'en' ? 'Server is not running' : 'Сервер сейчас не запущен', 'warn');
    };
}

// Индикатор игрового времени планировщика (опрос только на открытой вкладке)
setInterval(async () => {
    if (!document.getElementById('tab-weather')?.classList.contains('active')) return;
    const st = await ipcRenderer.invoke('weather:state');
    const el = document.getElementById('wx-live-state');
    if (el) el.innerText = st.running ? `● ${currentLang === 'en' ? 'Live' : 'В эфире'}: ${st.gameTime}` : '';
}, 3000);

if (wxTimelineEl) initWeatherEditor();


// =====================================================================
// ИНСТРУМЕНТЫ: диагностика, RCON, история, логи, доступ, бэкапы, расписание
// =====================================================================
const DEFAULT_RCON_PORT = 9610;

// Перевод по стабильному ключу: русский текст — запасной вариант, английский берётся из словаря по ключу
function tk(key, ruText) {
    if (currentLang === 'en') {
        const dict = getTranslations('en');
        if (dict && dict[key]) return dict[key];
    }
    return ruText;
}

// Элементы с data-i18n / data-i18n-placeholder / data-i18n-title переводятся по ключу, а не по тексту
function applyKeyedTranslations(lang) {
    if (lang !== 'en') return;
    const dict = getTranslations('en') || {};
    document.querySelectorAll('[data-i18n]').forEach(el => { if (dict[el.dataset.i18n]) el.textContent = dict[el.dataset.i18n]; });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { if (dict[el.dataset.i18nPlaceholder]) el.placeholder = dict[el.dataset.i18nPlaceholder]; });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { if (dict[el.dataset.i18nTitle]) el.title = dict[el.dataset.i18nTitle]; });
}

function formatDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString(currentLang === 'en' ? 'en-GB' : 'ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// --- Универсальное подтверждение ---
function confirmAction(title, text, okLabel) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').innerText = title;
    document.getElementById('confirm-text').innerText = text;
    const okBtn = document.getElementById('confirm-ok-btn');
    okBtn.innerText = okLabel || tk('confirm.ok', 'Продолжить');
    modal.classList.remove('hidden');
    return new Promise(resolve => {
        const finish = result => {
            modal.classList.add('hidden');
            okBtn.onclick = null;
            document.getElementById('confirm-cancel-btn').onclick = null;
            resolve(result);
        };
        okBtn.onclick = () => finish(true);
        document.getElementById('confirm-cancel-btn').onclick = () => finish(false);
    });
}

// --- Прогресс сохранения (копирование трассы и машин) ---
function setSaveProgressLabel(text) {
    const label = document.querySelector('#save-all-btn span');
    if (!label) return;
    if (!label.dataset.original) label.dataset.original = label.innerText;
    label.innerText = text || label.dataset.original;
}

ipcRenderer.on('save:progress', (e, { stage, current, total }) => {
    if (stage === 'track') setSaveProgressLabel(tk('save.track', 'Копирую трассу...'));
    if (stage === 'cars') setSaveProgressLabel(`${tk('save.cars', 'Машины')} ${current}/${total}...`);
});

// --- Диагностика ---
const diagModal = document.getElementById('diag-modal');

function diagText(item) {
    const p = item.params || {};
    const texts = {
        exe_ok: tk('diag.exe_ok', 'AssettoServer.exe на месте'),
        exe_missing: tk('diag.exe_missing', 'AssettoServer.exe не найден — скачайте сервер в «Настройках менеджера»'),
        password_short: tk('diag.password_short', 'Пароль администратора короче 8 символов'),
        port_free: `${p.proto} ${p.port}: ${tk('diag.port_free', 'порт свободен')}`,
        port_busy: `${p.proto} ${p.port}: ${tk('diag.port_busy', 'порт занят другой программой (возможно, уже запущен сервер)')}`,
        track_ok: `${tk('diag.track_ok', 'Трасса скопирована на сервер')}: ${p.track}`,
        track_missing: `${tk('diag.track_missing', 'Трасса не найдена в папке сервера — нажмите «Сохранить настройки»')}: ${p.track}`,
        no_cars: tk('diag.no_cars', 'Не выбрано ни одной машины'),
        cars_ok: `${tk('diag.cars_ok', 'Машины на месте')}: ${p.count}`,
        cars_missing_data: `${tk('diag.cars_missing', 'Нет data.acd / data у машин')} (${p.count}): ${p.cars}`,
        admins_without_steam_auth: tk('diag.admins_no_auth', 'Есть админы, но проверка Steam выключена — кто угодно может назваться админом'),
        ignoring_config_errors: tk('diag.ignoring', 'Включено игнорирование ошибок конфигурации — часть проблем сервер не покажет'),
        local_addresses: `${tk('diag.addresses', 'Адреса этого ПК')}: ${p.list}. ${tk('diag.forward', 'Для игры через интернет пробросьте в роутере')} UDP ${p.udp}, TCP ${p.tcp}, TCP ${p.http}`
    };
    return texts[item.code] || item.code;
}

function renderDiagnostics(items, { canStartAnyway = false } = {}) {
    const list = document.getElementById('diag-list');
    const icons = { ok: '✓', warn: '!', error: '✕', info: 'i' };
    list.innerHTML = items.map(i => `<div class="diag-item diag-${i.level}"><span class="diag-icon">${icons[i.level] || '•'}</span><span>${esc(diagText(i))}</span></div>`).join('');
    const hasErrors = items.some(i => i.level === 'error');
    document.getElementById('diag-title').innerText = hasErrors
        ? tk('diag.titleErrors', 'Найдены проблемы — сервер может не запуститься')
        : tk('diag.titleOk', 'Всё готово к запуску');
    document.getElementById('diag-start-anyway-btn').classList.toggle('hidden', !(canStartAnyway && hasErrors));
    diagModal.classList.remove('hidden');
}

async function openDiagnostics() {
    renderDiagnostics(await ipcRenderer.invoke('diag:preflight'));
}

async function requestServerStart(skipPreflight = false) {
    const res = await ipcRenderer.invoke('server:start', { skipPreflight });
    if (res.success) {
        diagModal.classList.add('hidden');
        document.querySelector('[data-tab="tab-dashboard"]').click();
    } else if (res.error === 'preflight') {
        renderDiagnostics(res.items, { canStartAnyway: true });
    }
}

document.getElementById('dash-diag-btn').addEventListener('click', openDiagnostics);
document.getElementById('diag-recheck-btn').addEventListener('click', openDiagnostics);
document.getElementById('diag-close-btn').addEventListener('click', () => diagModal.classList.add('hidden'));
document.getElementById('diag-start-anyway-btn').addEventListener('click', () => requestServerStart(true));

// Быстрая проверка портов при старте лаунчера и после сохранения
async function refreshPortStatus() {
    const el = document.getElementById('dash-port-status');
    if (!el) return;
    const res = await ipcRenderer.invoke('diag:ports');
    if (res.running) {
        el.className = 'port-status mono ok';
        el.innerText = tk('ports.running', '● Сервер работает');
        return;
    }
    const busy = res.checks.filter(c => !c.free);
    el.className = `port-status mono ${busy.length ? 'error' : 'ok'}`;
    el.innerText = busy.length
        ? `✕ ${tk('ports.busy', 'Заняты')}: ${busy.map(c => `${c.proto} ${c.port}`).join(', ')}`
        : `✓ ${tk('ports.free', 'Порты свободны')}`;
    el.title = res.addresses?.length ? `${tk('diag.addresses', 'Адреса этого ПК')}: ${res.addresses.join(', ')}` : '';
}

ipcRenderer.on('server:status', () => setTimeout(refreshPortStatus, 500));

// --- RCON-индикатор ---
ipcRenderer.on('live:rconStatus', (e, { connected }) => {
    document.getElementById('live-rcon-badge').classList.toggle('hidden', !connected);
});

// --- Сворачиваемая Live-панель ---
// Пока игроков нет — панель свёрнута; если пользователь сам развернул/свернул, уважаем его выбор до перезапуска
let liveCollapsedByUser = null;
const liveCard = document.getElementById('live-monitor-card');

function updateLiveCollapse(playersCount) {
    const collapsed = liveCollapsedByUser ?? playersCount === 0;
    liveCard.classList.toggle('collapsed', collapsed);
}

document.getElementById('live-collapse-btn').addEventListener('click', () => {
    liveCollapsedByUser = !liveCard.classList.contains('collapsed');
    liveCard.classList.toggle('collapsed', liveCollapsedByUser);
});
updateLiveCollapse(0);

// --- История игроков ---
const historyModal = document.getElementById('history-modal');
let historyView = 'players';
let historyData = { players: [], sessions: [] };

function renderHistory() {
    const table = document.getElementById('history-table');
    const rows = historyView === 'players' ? historyData.players : historyData.sessions;
    if (!rows.length) {
        table.innerHTML = `<div class="live-empty-state">${esc(tk('history.empty', 'История пока пуста — она начнёт заполняться при следующих подключениях.'))}</div>`;
        return;
    }
    if (historyView === 'players') {
        table.innerHTML = `<div class="history-row history-head"><span>${esc(tk('history.player', 'Игрок'))}</span><span>SteamID</span><span>${esc(tk('history.visits', 'Визиты'))}</span><span>${esc(tk('history.time', 'Время'))}</span><span>${esc(tk('history.last', 'Последний раз'))}</span></div>` +
            rows.map(p => `<div class="history-row"><span title="${esc((p.names || []).join(', '))}">${esc(p.name)}</span><span class="mono">${esc(p.steamId)}</span><span class="mono">${p.visits}</span><span class="mono">${Math.floor(p.totalMinutes / 60)}${tk('time.h', 'ч')} ${p.totalMinutes % 60}${tk('time.m', 'м')}</span><span class="mono">${formatDateTime(p.lastSeen)}</span></div>`).join('');
    } else {
        table.innerHTML = `<div class="history-row history-head"><span>${esc(tk('history.player', 'Игрок'))}</span><span>${esc(tk('history.car', 'Машина'))}</span><span>${esc(tk('history.start', 'Вход'))}</span><span>${esc(tk('history.end', 'Выход'))}</span><span>${esc(tk('history.duration', 'Минут'))}</span></div>` +
            rows.map(s => `<div class="history-row"><span>${esc(s.name)}</span><span class="mono">${esc(s.car)}</span><span class="mono">${formatDateTime(s.start)}</span><span class="mono">${formatDateTime(s.end)}</span><span class="mono">${s.minutes}</span></div>`).join('');
    }
}

document.getElementById('live-history-btn').addEventListener('click', async () => {
    historyData = await ipcRenderer.invoke('history:get');
    renderHistory();
    historyModal.classList.remove('hidden');
});
document.querySelectorAll('[data-history-view]').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('[data-history-view]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    historyView = btn.dataset.historyView;
    renderHistory();
}));
document.getElementById('history-close-btn').addEventListener('click', () => historyModal.classList.add('hidden'));
document.getElementById('history-clear-btn').addEventListener('click', async () => {
    historyModal.classList.add('hidden');
    if (!await confirmAction(tk('history.clearTitle', 'Очистить историю игроков?'), tk('history.clearText', 'Все записи о визитах будут удалены. Это действие нельзя отменить.'), tk('history.clear', 'Очистить историю'))) return;
    await ipcRenderer.invoke('history:clear');
    showToast(tk('history.cleared', 'История очищена'), 'info');
});

// --- Поиск, фильтр и сохранение лога консоли ---
const logSearchInput = document.getElementById('log-search-input');
const logFilterSelect = document.getElementById('log-filter-select');

function applyLogFilter() {
    const query = logSearchInput.value.trim().toLowerCase();
    const category = logFilterSelect.value;
    consoleOutput.querySelectorAll('.log-group').forEach(group => {
        const categoryOk = category === 'all' || group.classList.contains(`group-${category}`);
        let anyItem = false;
        group.querySelectorAll('.log-item').forEach(item => {
            const match = !query || item.textContent.toLowerCase().includes(query);
            item.classList.toggle('hidden', !match);
            if (match) anyItem = true;
        });
        group.classList.toggle('hidden', !(categoryOk && anyItem));
    });
}

logSearchInput.addEventListener('input', applyLogFilter);
logFilterSelect.addEventListener('change', applyLogFilter);

// Новые строки лога тоже проходят через фильтр
new MutationObserver(() => { if (logSearchInput.value || logFilterSelect.value !== 'all') applyLogFilter(); })
    .observe(consoleOutput, { childList: true, subtree: true });

document.getElementById('save-log-btn').addEventListener('click', async () => {
    const text = [...consoleOutput.querySelectorAll('.log-group')].map(g => {
        const head = g.querySelector('.log-group-header')?.innerText.replace(/\s+/g, ' ').trim() || '';
        const items = [...g.querySelectorAll('.log-item')].map(i => `    ${i.innerText}`).join('\n');
        return `${head}\n${items}`;
    }).join('\n');
    const res = await ipcRenderer.invoke('logs:save', text);
    if (res.success) showToast(`${tk('logs.saved', 'Лог сохранён')}: ${res.path}`, 'success');
});

// --- Админы / белый / чёрный список ---
const STEAM_ID_RE = /^7656119\d{10}$/;
let accessData = { admins: [], whitelist: [], blacklist: [] };
let accessActiveList = 'admins';

const ACCESS_HINTS = {
    admins: ['access.hintAdmins', 'Админы могут использовать команды /kick, /ban, /settime и т.д. прямо из игры.'],
    whitelist: ['access.hintWhitelist', 'Если список не пуст, на сервер смогут зайти только перечисленные игроки.'],
    blacklist: ['access.hintBlacklist', 'Забаненные игроки. Сюда же попадают баны из Live-панели.']
};

function renderAccessList() {
    const container = document.getElementById('access-list');
    const hint = ACCESS_HINTS[accessActiveList];
    document.getElementById('access-list-hint').innerText = tk(hint[0], hint[1]);
    const entries = accessData[accessActiveList] || [];
    if (!entries.length) {
        container.innerHTML = `<div class="access-empty">${esc(tk('access.empty', 'Список пуст'))}</div>`;
        return;
    }
    container.innerHTML = entries.map((e, idx) => `
        <div class="access-row">
            <span class="mono access-id">${esc(e.steamId)}</span>
            <input type="text" class="access-name" data-access-idx="${idx}" value="${esc(e.name)}" placeholder="${esc(tk('access.namePh', 'Подпись (ник)'))}" maxlength="64">
            <button class="btn-small" data-access-del="${idx}" title="${esc(tk('access.remove', 'Удалить'))}">
                <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
        </div>`).join('');

    container.querySelectorAll('[data-access-del]').forEach(btn => btn.addEventListener('click', async () => {
        accessData[accessActiveList].splice(parseInt(btn.dataset.accessDel), 1);
        await saveAccessList();
    }));
    container.querySelectorAll('.access-name').forEach(inp => inp.addEventListener('change', async () => {
        accessData[accessActiveList][parseInt(inp.dataset.accessIdx)].name = inp.value.trim();
        await saveAccessList();
    }));
}

async function saveAccessList() {
    const res = await ipcRenderer.invoke('access:save', { list: accessActiveList, entries: accessData[accessActiveList] });
    if (res.success) {
        accessData[accessActiveList] = res.entries;
        showToast(tk('access.saved', 'Список сохранён'), 'success');
    } else {
        showToast(`${t("Ошибка: ")}${res.error}`, 'error');
    }
    renderAccessList();
}

async function loadAccessLists() {
    accessData = await ipcRenderer.invoke('access:load');
    renderAccessList();
}

document.querySelectorAll('[data-access-list]').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('[data-access-list]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    accessActiveList = btn.dataset.accessList;
    renderAccessList();
}));

document.getElementById('access-add-btn').addEventListener('click', async () => {
    const idInput = document.getElementById('access-steamid-input');
    const nameInput = document.getElementById('access-name-input');
    const steamId = idInput.value.trim();
    if (!STEAM_ID_RE.test(steamId)) {
        idInput.classList.add('input-error');
        return showToast(tk('access.invalid', 'Неверный SteamID64: нужно 17 цифр, начиная с 7656119'), 'warn');
    }
    idInput.classList.remove('input-error');
    if (accessData[accessActiveList].some(e => e.steamId === steamId)) return showToast(tk('access.exists', 'Этот SteamID уже в списке'), 'info');
    accessData[accessActiveList].push({ steamId, name: nameInput.value.trim() });
    idInput.value = '';
    nameInput.value = '';
    await saveAccessList();
});

// --- Резервные копии ---
const BACKUP_REASONS = {
    save: ['backup.reasonSave', 'перед сохранением'],
    before_restore: ['backup.reasonRestore', 'перед откатом'],
    access: ['backup.reasonAccess', 'перед изменением доступа']
};

async function loadBackups() {
    const list = await ipcRenderer.invoke('backup:list');
    const container = document.getElementById('backup-list');
    if (!list.length) {
        container.innerHTML = `<div class="access-empty">${esc(tk('backup.empty', 'Копий пока нет'))}</div>`;
        return;
    }
    container.innerHTML = list.map(b => {
        const reason = BACKUP_REASONS[b.reason];
        const label = b.kind === 'manual' ? tk('backup.manual', 'вручную') : (reason ? tk(reason[0], reason[1]) : tk('backup.auto', 'авто'));
        return `
        <div class="backup-row">
            <div>
                <div class="mono backup-date">${formatDateTime(b.createdAt)}</div>
                <div class="backup-kind ${b.kind}">${esc(label)}</div>
            </div>
            <div class="backup-row-actions">
                <button class="btn-small accent" data-backup-restore="${esc(b.id)}">${esc(tk('backup.restore', 'Откатить'))}</button>
                <button class="btn-small" data-backup-zip="${esc(b.id)}">ZIP</button>
                <button class="btn-small" data-backup-del="${esc(b.id)}" title="${esc(tk('access.remove', 'Удалить'))}">
                    <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.5"/></svg>
                </button>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-backup-restore]').forEach(btn => btn.addEventListener('click', async () => {
        if (!await confirmAction(tk('backup.restoreTitle', 'Откатить настройки?'), tk('backup.restoreText', 'Текущие cfg, профили и списки доступа будут заменены этой копией. Перед откатом автоматически создаётся ещё одна копия.'), tk('backup.restore', 'Откатить'))) return;
        const res = await ipcRenderer.invoke('backup:restore', btn.dataset.backupRestore);
        if (res.success) {
            showToast(tk('backup.restored', 'Настройки восстановлены'), 'success');
            await loadAllData();
            await loadAccessLists();
            await loadBackups();
        } else {
            showToast(res.error === 'server_running' ? tk('backup.stopFirst', 'Сначала остановите сервер') : `${t("Ошибка: ")}${res.error}`, 'warn');
        }
    }));
    container.querySelectorAll('[data-backup-zip]').forEach(btn => btn.addEventListener('click', async () => {
        const res = await ipcRenderer.invoke('backup:exportZip', btn.dataset.backupZip);
        if (res.success) { showToast(tk('backup.zipped', 'Архив сохранён'), 'success'); shell.showItemInFolder(res.path); }
        else if (!res.canceled) showToast(`${t("Ошибка: ")}${res.error}`, 'error');
    }));
    container.querySelectorAll('[data-backup-del]').forEach(btn => btn.addEventListener('click', async () => {
        if (!await confirmAction(tk('backup.deleteTitle', 'Удалить копию?'), tk('backup.deleteText', 'Эта резервная копия будет удалена без возможности восстановления.'), tk('access.remove', 'Удалить'))) return;
        await ipcRenderer.invoke('backup:delete', btn.dataset.backupDel);
        await loadBackups();
    }));
}

document.getElementById('backup-create-btn').addEventListener('click', async () => {
    const res = await ipcRenderer.invoke('backup:create');
    if (res.success) showToast(tk('backup.created', 'Резервная копия создана'), 'success');
    else showToast(`${t("Ошибка: ")}${res.error}`, 'error');
    await loadBackups();
});
document.getElementById('backup-open-folder-btn').addEventListener('click', () => ipcRenderer.send('backup:openFolder'));

// --- Расписание рестартов и сообщений ---
async function loadSchedule() {
    const s = await ipcRenderer.invoke('schedule:get');
    document.getElementById('sched-restart-enabled').checked = s.restartEnabled;
    document.getElementById('sched-messages-enabled').checked = s.messagesEnabled;
    document.getElementById('sched-messages').value = s.messages.join('\n');
    bindSlider('sched-restart-hours', 'val-sched-hours', s.restartEveryHours, ` ${tk('time.h', 'ч')}`);
    bindSlider('sched-message-interval', 'val-sched-interval', s.messageIntervalMinutes, ` ${tk('time.min', 'мин')}`);
}

document.getElementById('sched-save-btn').addEventListener('click', async () => {
    const res = await ipcRenderer.invoke('schedule:save', {
        restartEnabled: document.getElementById('sched-restart-enabled').checked,
        restartEveryHours: parseInt(document.getElementById('sched-restart-hours').value),
        messagesEnabled: document.getElementById('sched-messages-enabled').checked,
        messageIntervalMinutes: parseInt(document.getElementById('sched-message-interval').value),
        messages: document.getElementById('sched-messages').value.split('\n')
    });
    if (res.success) showToast(tk('schedule.saved', 'Расписание сохранено'), 'success');
});

// Панели, которым нужны данные с диска — после загрузки основных настроек
async function initToolPanels() {
    refreshPortStatus();
    await Promise.all([loadAccessLists(), loadBackups(), loadSchedule()]);
}

document.querySelectorAll('[data-tab="tab-settings"]').forEach(tab => tab.addEventListener('click', loadBackups));
