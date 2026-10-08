(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.VstdAutocompleteLayout = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EDGE_MARGIN = 8;
  const INPUT_GAP = 2;
  const MIN_USABLE_HEIGHT = 44;
  const COMFORTABLE_HEIGHT = 96;
  const MAX_HEIGHT = 320;
  const MIN_WIDTH = 240;
  const MIN_ATTACHED_WIDTH = 120;

  function finite(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function resolveAutocompleteViewport(fixedOriginRect, visualViewport, fallbackViewport) {
    const origin = fixedOriginRect || {};
    const visual = visualViewport || {};
    const fallback = fallbackViewport || {};
    const fixedOriginLeft = finite(origin.left, 0);
    const fixedOriginTop = finite(origin.top, 0);
    const visualOffsetLeft = finite(visual.offsetLeft, 0);
    const visualOffsetTop = finite(visual.offsetTop, 0);

    return {
      // Client rects and fixed CSS offsets are not consistently rooted at the
      // same point while iOS moves the visual viewport for the keyboard. A
      // fixed 0,0 probe measures that difference instead of assuming it.
      offsetLeft: fixedOriginLeft + visualOffsetLeft,
      offsetTop: fixedOriginTop + visualOffsetTop,
      width: Math.max(0, finite(visual.width, finite(fallback.width, 0))),
      height: Math.max(0, finite(visual.height, finite(fallback.height, 0))),
      fixedOriginLeft,
      fixedOriginTop,
      visualOffsetLeft,
      visualOffsetTop
    };
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

    if (!viewportWidth || !viewportHeight
      || rect.bottom <= viewportTop || rect.top >= viewportBottom
      || rect.right <= viewportLeft || rect.left >= viewportRight) {
      return { visible: false };
    }

    const safeLeft = viewportLeft + EDGE_MARGIN;
    const safeRight = viewportRight - EDGE_MARGIN;
    const safeTop = viewportTop + EDGE_MARGIN;
    const safeBottom = viewportBottom - EDGE_MARGIN;
    const availableWidth = Math.max(0, safeRight - safeLeft);
    const preferredWidth = Math.max(rect.width, Math.min(MIN_WIDTH, availableWidth));
    const left = clamp(rect.left, safeLeft, safeRight);
    const width = Math.min(preferredWidth, Math.max(0, safeRight - left));
    const minimumAttachedWidth = Math.min(Math.max(rect.width, 0), MIN_ATTACHED_WIDTH);
    if (width < minimumAttachedWidth) return { visible: false };

    const belowTop = rect.bottom + INPUT_GAP;
    const aboveBottom = rect.top - INPUT_GAP;
    const spaceBelow = Math.max(0, safeBottom - belowTop);
    const spaceAbove = Math.max(0, aboveBottom - safeTop);
    const desiredHeight = Math.min(
      Math.max(finite(contentHeight, MIN_USABLE_HEIGHT), MIN_USABLE_HEIGHT),
      Math.max(COMFORTABLE_HEIGHT, viewportHeight * 0.42),
      MAX_HEIGHT
    );
    const openBelow = spaceBelow >= desiredHeight
      || (spaceAbove < desiredHeight && spaceBelow >= spaceAbove);
    const placement = openBelow ? "below" : "above";
    const availableHeight = openBelow ? spaceBelow : spaceAbove;
    const height = Math.floor(Math.min(desiredHeight, availableHeight));

    if (height < MIN_USABLE_HEIGHT) return { visible: false };

    const top = openBelow ? belowTop : aboveBottom - height;
    return {
      visible: true,
      placement,
      compact: availableHeight < COMFORTABLE_HEIGHT,
      left: Math.round(left),
      top,
      width: Math.round(width),
      height,
      gap: INPUT_GAP,
      viewportLeft,
      viewportTop,
      viewportRight,
      viewportBottom
    };
  }

  function applyAutocompleteLayout(element, layout, viewport) {
    if (!element || !layout || !layout.visible) return null;
    const fixedOriginLeft = finite(viewport && viewport.fixedOriginLeft, 0);
    const fixedOriginTop = finite(viewport && viewport.fixedOriginTop, 0);
    let cssLeft = layout.left - fixedOriginLeft;
    let cssTop = layout.top - fixedOriginTop;

    element.style.left = `${cssLeft}px`;
    element.style.top = `${cssTop}px`;
    element.style.bottom = "auto";
    element.style.width = `${layout.width}px`;
    element.style.height = `${layout.height}px`;
    element.style.maxHeight = `${layout.height}px`;

    // Verify the painted geometry. This compensates for browser-specific
    // fixed-position viewport behavior without arbitrary device offsets.
    let actual = element.getBoundingClientRect();
    const leftError = layout.left - actual.left;
    const topError = layout.top - actual.top;
    if (Math.abs(leftError) > 0.25 || Math.abs(topError) > 0.25) {
      cssLeft += leftError;
      cssTop += topError;
      element.style.left = `${cssLeft}px`;
      element.style.top = `${cssTop}px`;
      actual = element.getBoundingClientRect();
    }
    return actual;
  }

  function autocompleteGeometryIsValid(layout, inputRect, menuRect, tolerance) {
    if (!layout || !layout.visible || !inputRect || !menuRect) return false;
    const allowed = Math.max(0, finite(tolerance, 4));
    const horizontalError = Math.abs(menuRect.left - layout.left);
    const anchorError = layout.placement === "below"
      ? Math.abs(menuRect.top - (inputRect.bottom + layout.gap))
      : Math.abs(menuRect.bottom - (inputRect.top - layout.gap));
    const noInputOverlap = menuRect.bottom <= inputRect.top + allowed
      || menuRect.top >= inputRect.bottom - allowed;
    const insideVisibleViewport = menuRect.left >= layout.viewportLeft - allowed
      && menuRect.right <= layout.viewportRight + allowed
      && menuRect.top >= layout.viewportTop - allowed
      && menuRect.bottom <= layout.viewportBottom + allowed;
    return horizontalError <= allowed
      && anchorError <= allowed
      && noInputOverlap
      && insideVisibleViewport;
  }

  return {
    resolveAutocompleteViewport,
    calculateAutocompleteLayout,
    applyAutocompleteLayout,
    autocompleteGeometryIsValid
  };
});
