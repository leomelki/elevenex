export const AGENT_EVENTS = [
  "DOM.documentUpdated",
  "Runtime.executionContextsCleared",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFailed",
  "Network.loadingFinished",
  "Log.entryAdded",
  "Page.frameNavigated",
  "Page.loadEventFired",
  "Page.javascriptDialogOpening",
] as const;
