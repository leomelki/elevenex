/** Keep image copying native so it works for local and remote images without refetching. */
function installImageContextMenu(win, Menu) {
  const contents = win.webContents;
  contents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image') return;

    Menu.buildFromTemplate([
      {
        label: 'Copy Image',
        enabled: params.hasImageContents,
        click: () => {
          if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
        },
      },
    ]).popup({ window: win });
  });
}

module.exports = { installImageContextMenu };
