// A target session must never grow into a browser/process/filesystem capability.
// Keep an exact method allowlist: a new Chromium method needs explicit review.
export const CDP_METHODS: ReadonlySet<string> = new Set(
  `
Accessibility.enable Accessibility.disable Accessibility.getFullAXTree Accessibility.getPartialAXTree Accessibility.queryAXTree
DOM.enable DOM.disable DOM.getDocument DOM.describeNode DOM.querySelector DOM.querySelectorAll DOM.getAttributes DOM.getOuterHTML DOM.getBoxModel DOM.getContentQuads DOM.getNodeForLocation DOM.resolveNode DOM.requestNode DOM.focus DOM.scrollIntoViewIfNeeded DOM.setAttributeValue DOM.removeAttribute DOM.setNodeValue DOM.setOuterHTML
CSS.enable CSS.disable CSS.getComputedStyleForNode CSS.getMatchedStylesForNode CSS.getStyleSheetText CSS.setStyleSheetText CSS.setStyleTexts CSS.getMediaQueries CSS.forcePseudoState
Runtime.enable Runtime.disable Runtime.evaluate Runtime.callFunctionOn Runtime.getProperties Runtime.releaseObject Runtime.releaseObjectGroup Runtime.getHeapUsage
Page.enable Page.disable Page.reload Page.stopLoading Page.getFrameTree Page.getLayoutMetrics Page.getNavigationHistory Page.navigateToHistoryEntry
Network.enable Network.disable Network.getResponseBody Network.getRequestPostData Network.setCacheDisabled Network.setExtraHTTPHeaders Network.emulateNetworkConditions
Log.enable Log.disable Log.clear
Performance.enable Performance.disable Performance.getMetrics
Emulation.setDeviceMetricsOverride Emulation.clearDeviceMetricsOverride Emulation.setEmulatedMedia Emulation.setCPUThrottlingRate Emulation.setTouchEmulationEnabled
Input.dispatchMouseEvent Input.dispatchKeyEvent Input.insertText Input.imeSetComposition Input.synthesizeScrollGesture
Animation.enable Animation.disable Animation.setPlaybackRate Animation.getPlaybackRate
Overlay.enable Overlay.disable Overlay.highlightNode Overlay.highlightRect Overlay.hideHighlight
`
    .trim()
    .split(/\s+/u),
);

export function validateCdp(
  method: unknown,
  params: Record<string, unknown>,
): string {
  if (typeof method !== "string" || !CDP_METHODS.has(method))
    throw new Error(
      `CDP method unavailable: ${String(method)}. Use goto/screenshot helpers; browser-wide, file and transport operations are excluded.`,
    );
  if (Buffer.byteLength(JSON.stringify(params)) > 131072)
    throw new Error("CDP parameters exceeded 128 KiB");
  if (method === "Emulation.setDeviceMetricsOverride") {
    for (const key of ["width", "height"]) {
      const value = params[key];
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 2560
      )
        throw new Error("Viewport dimensions must be integers from 1 to 2560");
    }
    const ratio = params["deviceScaleFactor"];
    if (typeof ratio !== "number" || ratio < 0 || ratio > 2)
      throw new Error("Device scale factor must be between zero and two");
  }
  if (method === "Network.enable") {
    params["maxTotalBufferSize"] = 4 * 1024 * 1024;
    params["maxResourceBufferSize"] = 1024 * 1024;
    params["maxPostDataSize"] = 0;
  }
  return method;
}
