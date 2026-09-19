chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-listening') {
    // サイドパネルが開いていなければ受け手がいないので、エラーは無視する
    chrome.runtime.sendMessage({ type: 'toggle-listening' }).catch(() => {});
  }
});
