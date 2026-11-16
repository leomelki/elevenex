/** Public API membership, not an implementation of browser actions. Every
 * permitted call is delegated to the pinned Playwright object. Private members
 * and prototype traversal never cross the serialization boundary. */
const common =
  'evaluate evaluateHandle waitForFunction waitForLoadState waitForURL goto title content setContent addScriptTag addStyleTag click dblclick dispatchEvent fill focus hover innerHTML innerText textContent inputValue isChecked isDisabled isEditable isEnabled isHidden isVisible press selectOption setChecked check uncheck tap type waitForSelector setInputFiles';
const locate =
  'locator getByRole getByText getByLabel getByTestId getByAltText getByPlaceholder getByTitle frameLocator';
const events = 'on once off removeListener removeAllListeners waitForEvent';
export const PLAYWRIGHT_METHODS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.fromEntries(
    Object.entries({
      Browser: 'version isConnected contexts',
      BrowserContext: `${events} pages newPage browser cookies addCookies clearCookies storageState setStorageState addInitScript exposeBinding exposeFunction route unroute unrouteAll routeFromHAR routeWebSocket setExtraHTTPHeaders setGeolocation setOffline setDefaultTimeout setDefaultNavigationTimeout newCDPSession`,
      Page: `${common} ${locate} ${events} mainFrame frames frame context url isClosed close reload goBack goForward bringToFront screenshot pdf waitForTimeout waitForResponse waitForRequest route unroute unrouteAll routeWebSocket routeFromHAR exposeFunction exposeBinding addInitScript setViewportSize viewportSize emulateMedia setExtraHTTPHeaders setDefaultTimeout setDefaultNavigationTimeout opener workers video`,
      Frame: `${common} ${locate} page url name isDetached parentFrame childFrames frameElement`,
      Locator: `${locate} all allInnerTexts allTextContents and or filter nth first last describe description count boundingBox screenshot scrollIntoViewIfNeeded waitFor elementHandle elementHandles page contentFrame evaluate evaluateAll evaluateHandle ariaSnapshot getAttribute innerHTML innerText textContent inputValue isChecked isDisabled isEditable isEnabled isHidden isVisible check uncheck setChecked click dblclick dispatchEvent dragTo fill focus blur hover press pressSequentially selectOption selectText setInputFiles tap type highlight`,
      FrameLocator: `${locate} owner first last nth`,
      ElementHandle:
        'evaluate evaluateHandle getProperty getProperties dispose asElement boundingBox screenshot ownerFrame contentFrame getAttribute $ $$ scrollIntoViewIfNeeded waitForElementState waitForSelector click dblclick dispatchEvent fill focus hover innerHTML innerText textContent inputValue isChecked isDisabled isEditable isEnabled isHidden isVisible press selectOption setChecked check uncheck tap type selectText setInputFiles',
      JSHandle:
        'evaluate evaluateHandle getProperty getProperties jsonValue dispose asElement',
      Keyboard: 'down up press insertText type',
      Mouse: 'click dblclick down up move wheel',
      Touchscreen: 'tap',
      Request:
        'url method headers headersArray allHeaders headerValue postData postDataBuffer postDataJSON resourceType isNavigationRequest frame response redirectedFrom redirectedTo failure timing sizes serviceWorker',
      Response:
        'url status statusText ok headers headersArray allHeaders headerValue headerValues body json text finished request frame securityDetails serverAddr fromServiceWorker',
      Route: 'request abort continue fallback fulfill fetch',
      Dialog: 'type message defaultValue page accept dismiss',
      FileChooser: 'element isMultiple page setFiles',
      Download:
        'url suggestedFilename page failure path saveAs cancel delete createReadStream',
      Worker: `${events} url evaluate evaluateHandle`,
      ConsoleMessage: 'type text args location page',
      WebSocket: `${events} url isClosed`,
      WebSocketRoute: 'url send close onMessage onClose',
      CDPSession: 'on once off removeListener removeAllListeners send detach',
      Tracing: 'start startChunk stop stopChunk group groupEnd',
      Clock:
        'install fastForward pauseAt resume runFor setFixedTime setSystemTime',
      APIRequestContext: 'fetch get post put patch delete head storageState',
      APIResponse:
        'url status statusText ok headers headersArray body json text dispose',
      Buffer: 'toString subarray slice equals',
      DisposableStub: 'dispose',
      Disposable: 'dispose',
      Readable: `${events} destroy`,
      Assertion:
        'toBe toEqual toStrictEqual toBeTruthy toBeFalsy toBeDefined toBeUndefined toBeNull toContain toContainEqual toMatch toMatchObject toHaveLength toBeGreaterThan toBeGreaterThanOrEqual toBeLessThan toBeLessThanOrEqual toBeCloseTo toHaveProperty toBeVisible toBeHidden toBeAttached toBeChecked toBeDisabled toBeEditable toBeEmpty toBeEnabled toBeFocused toBeInViewport toContainText toHaveText toHaveAttribute toHaveClass toContainClass toHaveCount toHaveCSS toHaveId toHaveJSProperty toHaveRole toHaveAccessibleName toHaveAccessibleDescription toHaveAccessibleErrorMessage toHaveValue toHaveValues toHaveTitle toHaveURL toBeOK toPass',
    }).map(([type, methods]) => [type, new Set(methods.split(/\s+/u))]),
  );

export const PLAYWRIGHT_PROPERTIES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  Page: {
    keyboard: 'Keyboard',
    mouse: 'Mouse',
    touchscreen: 'Touchscreen',
    clock: 'Clock',
    request: 'APIRequestContext',
  },
  BrowserContext: {
    tracing: 'Tracing',
    request: 'APIRequestContext',
    clock: 'Clock',
  },
  Assertion: { not: 'Assertion', resolves: 'Assertion', rejects: 'Assertion' },
};
export function assertMethod(type: string, member: string): void {
  if (!PLAYWRIGHT_METHODS[type]?.has(member))
    throw new Error(
      `Unsupported or privileged ${type}.${member}. Only documented public task-scoped APIs are exposed.`,
    );
}
