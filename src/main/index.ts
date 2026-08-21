import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerPdfHandlers } from './pdf/handlers'

const RELEASES_URL = 'https://github.com/christophebypretto-crypto/pdf-propulse/releases/latest'

// Vrai pendant une verification lancee a la main depuis le menu : les erreurs de
// mise a jour sont alors affichees, au lieu de passer inapercues.
let manualUpdateCheck = false

// Path PDF reçu via "Ouvrir avec" / argv en attente que la fenetre soit prete
let pendingFilePath: string | null = null
let mainWindow: BrowserWindow | null = null

function findPdfInArgv(): string | null {
  // Windows : "Ouvrir avec" passe le chemin du fichier comme argv[1] (ou plus)
  const argv = process.argv
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg.startsWith('-')) continue
    if (arg.toLowerCase().endsWith('.pdf') && existsSync(arg)) {
      return arg
    }
  }
  return null
}

function bringWindowToFront(): void {
  const doFocus = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (process.platform === 'darwin') {
      // Mac : app.focus pour passer devant les autres apps, puis window.focus + moveTop
      app.focus({ steal: true })
      mainWindow.moveTop()
      mainWindow.focus()
    } else if (process.platform === 'win32') {
      // Windows : contourne le focus-stealing prevention
      mainWindow.setAlwaysOnTop(true)
      mainWindow.focus()
      mainWindow.setAlwaysOnTop(false)
      mainWindow.moveTop()
    } else {
      mainWindow.focus()
      mainWindow.moveTop()
    }
  }
  // Premier appel immediat, second appel apres 120ms pour gerer le timing
  // de l'event open-file qui peut arriver avant que la fenetre soit prete a
  // recevoir le focus (cas typique : "Ouvrir avec" depuis le Finder pendant
  // que l'app est en arriere-plan dans un autre Space).
  doFocus()
  setTimeout(doFocus, 120)
}

function sendOpenFile(path: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:openFile', path)
    bringWindowToFront()
  } else {
    pendingFilePath = path
  }
}

function setupAutoUpdater(win: BrowserWindow): void {
  // Pas de check en dev
  if (is.dev) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    win.webContents.send('updater:status', { state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    win.webContents.send('updater:status', { state: 'none' })
  })

  autoUpdater.on('download-progress', (p) => {
    win.webContents.send('updater:status', {
      state: 'downloading',
      percent: Math.round(p.percent)
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    win.webContents.send('updater:status', { state: 'ready', version: info.version })
    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Redémarrer et installer', 'Plus tard'],
        defaultId: 0,
        cancelId: 1,
        title: 'Mise à jour disponible',
        message: `Propulse PDF ${info.version} est prête à être installée.`,
        detail: "Redémarre l'app pour appliquer la mise à jour."
      })
      .then((res) => {
        if (res.response === 0) autoUpdater.quitAndInstall()
      })
  })

  autoUpdater.on('error', (err) => {
    win.webContents.send('updater:status', {
      state: 'error',
      message: err.message
    })
    // Une verification lancee a la main doit toujours donner une reponse, meme
    // mauvaise : sinon l'utilisateur croit etre a jour alors qu'il ne l'est pas.
    if (!manualUpdateCheck) return
    manualUpdateCheck = false
    dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'Mise à jour impossible',
        message: "La mise à jour automatique n'a pas pu aboutir.",
        detail: `${err.message}\n\nTu peux installer la dernière version à la main : télécharge le .dmg, puis glisse l'app dans Applications en remplaçant l'ancienne.`,
        buttons: ['Ouvrir la page de téléchargement', 'Fermer'],
        defaultId: 0,
        cancelId: 1
      })
      .then((r) => {
        if (r.response === 0) shell.openExternal(RELEASES_URL)
      })
  })

  // Check au demarrage puis toutes les 30 min
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    /* silencieux : si le repo est privé sans token, on ignore */
  })
  setInterval(
    () => {
      autoUpdater.checkForUpdates().catch(() => {})
    },
    30 * 60 * 1000
  )

  ipcMain.handle('updater:check', async () => {
    try {
      const r = await autoUpdater.checkForUpdates()
      return r ? { version: r.updateInfo.version } : null
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('updater:quitAndInstall', () => {
    autoUpdater.quitAndInstall()
    return true
  })
}

/**
 * Vérification de mise à jour lancée à la main depuis le menu.
 * Donne toujours une réponse a l'utilisateur — y compris en cas d'echec, sinon
 * on croit etre a jour alors qu'on ne l'est pas.
 */
async function checkForUpdatesFromMenu(): Promise<void> {
  manualUpdateCheck = true
  try {
    const r = await autoUpdater.checkForUpdates()
    const dispo = r?.updateInfo?.version
    // checkForUpdates renvoie toujours un updateInfo, y compris quand rien de
    // neuf : il faut comparer les versions.
    if (dispo && dispo !== app.getVersion()) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Mise à jour trouvée',
        message: `Propulse PDF ${dispo} est disponible.`,
        detail:
          'Le téléchargement démarre en arrière-plan. Une fenêtre te proposera de redémarrer quand ce sera prêt.'
      })
    } else {
      manualUpdateCheck = false
      dialog.showMessageBox({
        type: 'info',
        message: "L'app est à jour.",
        detail: `Version installée : ${app.getVersion()}.`
      })
    }
  } catch (e) {
    manualUpdateCheck = false
    const res = await dialog.showMessageBox({
      type: 'warning',
      message: 'Vérification impossible',
      detail: `${e instanceof Error ? e.message : String(e)}\n\nTu peux installer la dernière version à la main.`,
      buttons: ['Ouvrir la page de téléchargement', 'Fermer'],
      defaultId: 0,
      cancelId: 1
    })
    if (res.response === 0) shell.openExternal(RELEASES_URL)
  }
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Propulse PDF',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Vérifier les mises à jour…',
                click: () => {
                  void checkForUpdatesFromMenu()
                }
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    // Sur macOS l'entree vit dans le menu applicatif ci-dessus. Ailleurs il n'y a
    // pas de menu applicatif : sans ce menu Aide, aucun moyen de declencher une
    // verification a la main.
    ...(isMac
      ? []
      : [
          {
            label: 'Aide',
            submenu: [
              {
                label: `Version ${app.getVersion()}`,
                enabled: false
              },
              {
                label: 'Vérifier les mises à jour…',
                click: (): void => {
                  void checkForUpdatesFromMenu()
                }
              }
            ]
          } as Electron.MenuItemConstructorOptions
        ])
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#FAF6F2',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Une fois la fenetre prete, livre le fichier en attente (Ouvrir avec…)
  win.webContents.once('did-finish-load', () => {
    const path = pendingFilePath || findPdfInArgv()
    pendingFilePath = null
    if (path) {
      // Petit delai pour que React soit prêt à recevoir l'event
      setTimeout(() => win.webContents.send('app:openFile', path), 300)
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  mainWindow = win
  return win
}

// Mac : "open-file" est l'event natif quand un fichier est passé via Finder
app.on('open-file', (event, path) => {
  event.preventDefault()
  sendOpenFile(path)
})

// Single-instance lock : si une 2e instance est lancée avec un PDF, on l'envoie
// à l'instance existante (évite d'ouvrir 2 fenetres pour le meme app)
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Cherche un .pdf dans les args de la 2e instance
    let foundPdf = false
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]
      if (arg && arg.toLowerCase().endsWith('.pdf') && existsSync(arg)) {
        sendOpenFile(arg)
        foundPdf = true
        break
      }
    }
    // sendOpenFile() ramene deja la fenetre au premier plan. Si pas de PDF,
    // on la ramene quand meme (user a clique sur l'app pendant qu'elle tournait).
    if (!foundPdf) bringWindowToFront()
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('fr.bypretto.pdf100k')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Dialogues file I/O
  // Version affichee en haut a droite de la fenetre. On la lit sur l'app elle-meme
  // (et pas sur une constante figee au build) : c'est la seule valeur qui
  // correspond a coup sur au binaire en train de tourner.
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('dialog:openPdf', async (_evt, multi: boolean = false) => {
    const result = await dialog.showOpenDialog({
      title: 'Ouvrir un PDF',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle('dialog:openPdfOrImage', async (_evt, multi: boolean = false) => {
    const result = await dialog.showOpenDialog({
      title: 'Ajouter un PDF ou une image',
      filters: [
        { name: 'PDF ou image', extensions: ['pdf', 'jpg', 'jpeg', 'png'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }
      ],
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle('dialog:savePdf', async (_evt, defaultName?: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Enregistrer le PDF',
      defaultPath: defaultName || 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle('fs:readPdf', async (_evt, filePath: string) => {
    const buf = await readFile(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle('fs:writePdf', async (_evt, filePath: string, data: ArrayBuffer) => {
    await writeFile(filePath, Buffer.from(data))
    return true
  })

  // Ouvre le Finder (Mac) / Explorateur (Windows) sur le dossier parent
  // avec le fichier sélectionné.
  ipcMain.handle('shell:showInFolder', async (_evt, filePath: string) => {
    if (!filePath || !existsSync(filePath)) return false
    shell.showItemInFolder(filePath)
    return true
  })

  registerPdfHandlers()
  buildAppMenu()

  const win = createWindow()
  setupAutoUpdater(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
