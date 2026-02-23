import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
    getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),
    startRecording: () => ipcRenderer.invoke('start-recording'),
    stopRecording: () => ipcRenderer.invoke('stop-recording'),
    saveReplay: () => ipcRenderer.invoke('save-replay'),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    windowControl: (action: string) => ipcRenderer.invoke('window-control', action),
    onRecordingStateChange: (callback: (state: boolean) => void) => ipcRenderer.on('recording-state', (e, state) => callback(state)),
    sendSystemAudioData: (buffer: ArrayBuffer) => ipcRenderer.send('system-audio-data', Buffer.from(buffer)),
    onStartSystemAudio: (callback: () => void) => ipcRenderer.on('start-system-audio', () => callback()),
    onStopSystemAudio: (callback: () => void) => ipcRenderer.on('stop-system-audio', () => callback())
});
