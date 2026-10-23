// Мост между интерфейсом и main-процессом.
// Окно работает с contextIsolation + sandbox: у страницы нет доступа к Node.js,
// она видит только window.api и только разрешённые IPC-каналы.
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_PREFIXES = [
    'win:', 'launcher:', 'webhook:', 'dialog:', 'track:', 'shell:', 'server:', 'content:', 'config:',
    'profiles:', 'live:', 'modpack:', 'plugins:', 'weather:', 'download:', 'backup:', 'access:',
    'diag:', 'schedule:', 'history:', 'logs:', 'fs:', 'save:'
];

function assertChannel(channel) {
    if (typeof channel !== 'string' || !ALLOWED_PREFIXES.some(p => channel.startsWith(p))) {
        throw new Error(`IPC channel is not allowed: ${channel}`);
    }
}

contextBridge.exposeInMainWorld('api', {
    ipc: {
        invoke: (channel, ...args) => { assertChannel(channel); return ipcRenderer.invoke(channel, ...args); },
        send: (channel, ...args) => { assertChannel(channel); ipcRenderer.send(channel, ...args); },
        // Объект события через мост не передаётся, поэтому первым аргументом идёт null — сигнатуры (e, data) в renderer.js не меняются
        on: (channel, listener) => { assertChannel(channel); ipcRenderer.on(channel, (e, ...args) => listener(null, ...args)); }
    },
    shell: {
        openExternal: url => ipcRenderer.invoke('shell:openExternal', url),
        showItemInFolder: p => ipcRenderer.send('shell:showItemInFolder', p)
    }
});
