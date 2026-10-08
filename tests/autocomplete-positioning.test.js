"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  resolveAutocompleteViewport,
  calculateAutocompleteLayout,
  applyAutocompleteLayout,
  autocompleteGeometryIsValid
} = require("../autocomplete-positioning.js");

const projectRoot = path.resolve(__dirname, "..");

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function viewport(width, height, offsetLeft = 0, offsetTop = 0) {
  return { width, height, offsetLeft, offsetTop };
}

const below = calculateAutocompleteLayout(rect(20, 100, 260, 40), viewport(390, 700), 280);
assert.strictEqual(below.visible, true);
assert.strictEqual(below.placement, "below");
assert(Math.abs(below.top - 142) <= 0.01, "Below placement must remain attached within the 0-4px gap");
assert(Math.abs(below.left - 20) <= 1, "Dropdown must share the input's horizontal alignment when space permits");
assert(below.top + below.height <= 692, "Below placement must stay inside the visible viewport");

const above = calculateAutocompleteLayout(rect(40, 610, 280, 40), viewport(390, 700), 300);
assert.strictEqual(above.visible, true);
assert.strictEqual(above.placement, "above");
assert(Math.abs((above.top + above.height) - 608) <= 0.01, "Above placement must remain attached within the 0-4px gap");

const keyboardViewport = calculateAutocompleteLayout(
  rect(30, 390, 270, 40),
  viewport(390, 300, 0, 180),
  260
);
assert.strictEqual(keyboardViewport.visible, true);
assert(keyboardViewport.top >= 188, "Position must honor visualViewport.offsetTop");
assert(keyboardViewport.top + keyboardViewport.height <= 472, "Dropdown must stay above the keyboard-constrained viewport bottom");
assert(keyboardViewport.top + keyboardViewport.height <= 388 || keyboardViewport.top >= 432, "Dropdown must not cover the input");

const standardViewport = resolveAutocompleteViewport(
  { left: 0, top: 0 },
  viewport(390, 300, 12, 180),
  viewport(390, 700)
);
const iosPannedViewport = resolveAutocompleteViewport(
  { left: -12, top: -180 },
  viewport(390, 300, 12, 180),
  viewport(390, 700)
);
assert.strictEqual(standardViewport.offsetTop, 180, "Standards geometry must retain the visual viewport offset");
assert.strictEqual(standardViewport.offsetLeft, 12, "Standards geometry must retain the horizontal visual viewport offset");
assert.strictEqual(iosPannedViewport.offsetTop, 0, "A panned iOS fixed origin must cancel an already-applied client offset");
assert.strictEqual(iosPannedViewport.offsetLeft, 0, "Horizontal fixed-origin calibration must avoid a doubled offset");

const standardLayout = calculateAutocompleteLayout(rect(42, 390, 270, 40), standardViewport, 260);
const iosLayout = calculateAutocompleteLayout(rect(30, 210, 270, 40), iosPannedViewport, 260);
assert.strictEqual(standardLayout.top - standardViewport.fixedOriginTop, iosLayout.top - iosPannedViewport.fixedOriginTop,
  "Equivalent painted inputs must produce the same fixed CSS top across viewport coordinate models");
assert.strictEqual(standardLayout.left - standardViewport.fixedOriginLeft, iosLayout.left - iosPannedViewport.fixedOriginLeft,
  "Equivalent painted inputs must produce the same fixed CSS left across viewport coordinate models");

for (const animationFrame of [
  { originTop: -60, visualTop: 60, height: 520, inputTop: 320 },
  { originTop: -120, visualTop: 120, height: 410, inputTop: 260 },
  { originTop: -180, visualTop: 180, height: 300, inputTop: 210 }
]) {
  const animatedViewport = resolveAutocompleteViewport(
    { left: 0, top: animationFrame.originTop },
    viewport(390, animationFrame.height, 0, animationFrame.visualTop),
    viewport(390, 700)
  );
  const animatedInput = rect(30, animationFrame.inputTop, 270, 40);
  const animatedLayout = calculateAutocompleteLayout(animatedInput, animatedViewport, 260);
  const animatedElement = fakeFixedElement(animatedViewport.fixedOriginLeft, animatedViewport.fixedOriginTop);
  const animatedRect = applyAutocompleteLayout(animatedElement, animatedLayout, animatedViewport);
  assert(autocompleteGeometryIsValid(animatedLayout, animatedInput, animatedRect, 4),
    "Every keyboard animation frame must remain geometrically attached");
}

const horizontallyClamped = calculateAutocompleteLayout(
  rect(130, 250, 80, 40),
  viewport(320, 500, 100, 0),
  200
);
assert.strictEqual(horizontallyClamped.visible, true);
assert(horizontallyClamped.left >= 108);
assert(horizontallyClamped.left + horizontallyClamped.width <= 412);
assert(horizontallyClamped.width >= 240, "Narrow table inputs should receive a usable menu width when space permits");
assert(Math.abs(horizontallyClamped.left - 130) <= 1, "A non-zero horizontal viewport offset must not detach the menu from its input");

const noHorizontalRoom = calculateAutocompleteLayout(
  rect(360, 250, 80, 40),
  viewport(320, 500, 100, 0),
  200
);
assert.strictEqual(noHorizontalRoom.visible, false, "The menu must close instead of floating away when attached width is unusable");

const compact = calculateAutocompleteLayout(rect(20, 68, 250, 40), viewport(320, 170), 300);
assert.strictEqual(compact.visible, true);
assert.strictEqual(compact.compact, true);
assert(compact.height >= 44, "Compact fallback must retain one usable suggestion row");
assert(compact.top + compact.height <= 66 || compact.top >= 110, "Compact fallback must not cover the active input");

const outside = calculateAutocompleteLayout(rect(20, 800, 250, 40), viewport(390, 700), 200);
assert.strictEqual(outside.visible, false, "A fully offscreen input must not leave a stale dropdown visible");

const longList = calculateAutocompleteLayout(rect(20, 100, 260, 40), viewport(390, 900), 2000);
assert(longList.height <= 320, "Long suggestion lists must scroll internally instead of covering the page");

const firstRow = calculateAutocompleteLayout(rect(20, 75, 260, 40), viewport(390, 700), 280);
const lastRow = calculateAutocompleteLayout(rect(20, 620, 260, 40), viewport(390, 700), 280);
assert.strictEqual(firstRow.placement, "below", "The first product row should open below when it fits better");
assert.strictEqual(lastRow.placement, "above", "The last product row should flip above when it fits better");

function fakeFixedElement(originLeft, originTop) {
  const style = {};
  return {
    style,
    getBoundingClientRect() {
      const left = originLeft + (parseFloat(style.left) || 0);
      const top = originTop + (parseFloat(style.top) || 0);
      const width = parseFloat(style.width) || 0;
      const height = parseFloat(style.height) || 0;
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
  };
}

for (const testCase of [
  { name: "PO below", input: rect(20, 100, 260, 40), viewport: viewport(390, 700), content: 280 },
  { name: "Quotation above", input: rect(40, 610, 280, 40), viewport: viewport(390, 700), content: 300 },
  { name: "iPhone keyboard offset", input: rect(30, 210, 270, 40), viewport: iosPannedViewport, content: 260 },
  { name: "Android keyboard", input: rect(30, 310, 270, 40), viewport: viewport(390, 420), content: 800 },
  { name: "desktop long list", input: rect(260, 180, 420, 40), viewport: viewport(1024, 768), content: 2000 }
]) {
  const layout = calculateAutocompleteLayout(testCase.input, testCase.viewport, testCase.content);
  const element = fakeFixedElement(testCase.viewport.fixedOriginLeft || 0, testCase.viewport.fixedOriginTop || 0);
  const rendered = applyAutocompleteLayout(element, layout, testCase.viewport);
  assert(autocompleteGeometryIsValid(layout, testCase.input, rendered, 4), `${testCase.name} must pass rendered geometry validation`);
}

for (const filename of ["app.js", "purchase-order.js"]) {
  const source = fs.readFileSync(path.join(projectRoot, filename), "utf8");
  assert(source.includes("input.getBoundingClientRect()"), `${filename} must anchor to the active input rectangle`);
  assert(source.includes("window.visualViewport.addEventListener(\"resize\""), `${filename} must follow keyboard viewport resizing`);
  assert(source.includes("window.visualViewport.addEventListener(\"scroll\""), `${filename} must follow mobile toolbar viewport movement`);
  assert(source.includes("VstdAutocompleteLayout"), `${filename} must use the shared coordinate calculation`);
  assert(source.includes("fixedOrigin.getBoundingClientRect()"), `${filename} must calibrate the fixed containing-block origin`);
  assert(source.includes("applyAutocompleteLayout"), `${filename} must verify actual rendered dropdown geometry`);
  assert(source.includes('event.key === "ArrowDown"'), `${filename} must retain desktop keyboard navigation`);
  assert(source.includes("pointerActive"), `${filename} must protect touch selection from premature blur`);
  assert(!source.includes("scrollIntoView"), `${filename} must not jump the page while typing`);
}

for (const filename of ["index.html", "quotation.html"]) {
  const source = fs.readFileSync(path.join(projectRoot, filename), "utf8");
  assert(source.includes('src="autocomplete-positioning.js"'), `${filename} must load the shared autocomplete positioning helper`);
}

console.log("Autocomplete positioning tests passed: rendered anchoring, PO/Quotation, iPhone/Android keyboard offsets, animation geometry, page rows, desktop, compact fallback, and long lists.");
