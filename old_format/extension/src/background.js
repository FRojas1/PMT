/* Opens the reddit submit page next to the HLTV tab. Done here rather than
 * with window.open so it survives popup blocking. */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'openTab') {
    chrome.tabs.create({ url: msg.url, index: (sender.tab ? sender.tab.index + 1 : undefined) });
    sendResponse({ ok: true });
  }
  return false;
});

// Clicking the toolbar icon nudges the content script on the active tab.
chrome.action.onClicked.addListener(function (tab) {
  if (tab && /^https:\/\/www\.hltv\.org\/matches\//.test(tab.url || '')) {
    chrome.tabs.sendMessage(tab.id, { type: 'generate' });
  }
});
