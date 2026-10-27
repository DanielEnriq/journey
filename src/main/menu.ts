import { app, Menu } from 'electron';

// The menu bar names the app Vowe. Only the labels change: app.name stays the package's, since the data folder
// (userData) and the Keychain key safeStorage seals sign-ins with are both derived from it. In development the
// bold title beside the Apple menu comes from Electron's own bundle; scripts/name-dev-app.mjs names that too.

export const APP_TITLE = 'Vowe';

export function setAppMenu(): void {
  if (process.platform !== 'darwin') return;
  app.setAboutPanelOptions({ applicationName: APP_TITLE });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_TITLE,
      submenu: [
        { role: 'about', label: `About ${APP_TITLE}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_TITLE}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_TITLE}` },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}
