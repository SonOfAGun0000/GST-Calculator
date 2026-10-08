(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.VstdAutocompleteLayout = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EDGE_MARGIN = 8;
  const INPUT_GAP = 4;
  const MIN_USABLE_HEIGHT = 44;
  const COMFORTABLE_HEIGHT = 96;
  const MAX_HEIGHT = 320;
  const MIN_WIDTH = 240;

  function finite(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function calculateAutocompleteLayout(inputRect, visualViewport, contentHeight) {
    const viewport = visualViewport || {};
    const viewportLeft = finite(viewport.offsetLeft, 0);
    const viewportTop = finite(viewport.offsetTop, 0);
    const viewportWidth = Math.max(0, finite(viewport.width, 0));
    const viewportHeight = Math.max(0, finite(viewport.height, 0));
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    const rect = {
      left: finite(inputRect && inputRect.left, 0),
      right: finite(inputRect && inputRect.right, 0),
      top: finite(inputRect && inputRect.top, 0),
      bottom: finite(inputRect && inputRect.bottom, 0),
      width: Math.max(0, finite(inputRect && inputRect.width, 0))
    };

    if (!viewportWidth || !viewportHeight || rect.bottom <= viewportTop || rect.top >= viewportBottom) {
      return { visible: false };
    }

    const safeLeft = viewportLeft + EDGE_MARGIN;
    const safeRight = viewportRight - EDGE_MARGIN;
    const safeTop = viewportTop + EDGE_MARGIN;
    const safeBottom = viewportBottom - EDGE_MARGIN;
    const availableWidth = Math.max(0, safeRight - safeLeft);
    const preferredWidth = Math.max(rect.width, Math.min(MIN_WIDTH, availableWidth));
    const width = Math.min(preferredWidth, availableWidth);
    const left = clamp(rect.left, safeLeft, Math.max(safeLeft, safeRight - width));

    const belowTop = rect.bottom + INPUT_GAP;
    const aboveBottom = rect.top - INPUT_GAP;
    const spaceBelow = Math.max(0, safeBottom - belowTop);
    const spaceAbove = Math.max(0, aboveBottom - safeTop);
    const openBelow = spaceBelow >= COMFORTABLE_HEIGHT || spaceBelow >= spaceAbove;
    const placement = openBelow ? "below" : "above";
    const availableHeight = openBelow ? spaceBelow : spaceAbove;
    const desiredHeight = Math.min(
      Math.max(finite(contentHeight, MIN_USABLE_HEIGHT), MIN_USABLE_HEIGHT),
      Math.max(COMFORTABLE_HEIGHT, viewportHeight * 0.42),
      MAX_HEIGHT
    );
    const height = Math.min(desiredHeight, availableHeight);

    if (height < MIN_USABLE_HEIGHT) return { visible: false };

    const top = openBelow ? belowTop : aboveBottom - height;
    return {
      visible: true,
      placement,
      compact: availableHeight < COMFORTABLE_HEIGHT,
      left: Math.round(left),
      top: Math.round(clamp(top, safeTop, safeBottom - height)),
      width: Math.round(width),
      height: Math.floor(height),
      viewportLeft,
      viewportTop
    };
  }

  return { calculateAutocompleteLayout };
});
