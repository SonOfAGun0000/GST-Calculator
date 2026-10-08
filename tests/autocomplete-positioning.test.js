"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { calculateAutocompleteLayout } = require("../autocomplete-positioning.js");

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
assert(below.top >= 144, "Below placement must not cover the active input");
assert(below.top + below.height <= 692, "Below placement must stay inside the visible viewport");

const above = calculateAutocompleteLayout(rect(40, 610, 280, 40), viewport(390, 700), 300);
assert.strictEqual(above.visible, true);
assert.strictEqual(above.placement, "above");
assert(above.top + above.height <= 606, "Above placement must not cover the active input");

const keyboardViewport = calculateAutocompleteLayout(
  rect(30, 390, 270, 40),
  viewport(390, 300, 0, 180),
  260
);
assert.strictEqual(keyboardViewport.visible, true);
assert(keyboardViewport.top >= 188, "Position must honor visualViewport.offsetTop");
assert(keyboardViewport.top + keyboardViewport.height <= 472, "Dropdown must stay above the keyboard-constrained viewport bottom");
assert(keyboardViewport.top + keyboardViewport.height <= 386 || keyboardViewport.top >= 434, "Dropdown must not cover the input");

const horizontallyClamped = calculateAutocompleteLayout(
  rect(360, 250, 80, 40),
  viewport(320, 500, 100, 0),
  200
);
assert.strictEqual(horizontallyClamped.visible, true);
assert(horizontallyClamped.left >= 108);
assert(horizontallyClamped.left + horizontallyClamped.width <= 412);
assert(horizontallyClamped.width >= 240, "Narrow table inputs should receive a usable menu width when space permits");

const compact = calculateAutocompleteLayout(rect(20, 68, 250, 40), viewport(320, 170), 300);
assert.strictEqual(compact.visible, true);
assert.strictEqual(compact.compact, true);
assert(compact.height >= 44, "Compact fallback must retain one usable suggestion row");
assert(compact.top + compact.height <= 64 || compact.top >= 112, "Compact fallback must not cover the active input");

const outside = calculateAutocompleteLayout(rect(20, 800, 250, 40), viewport(390, 700), 200);
assert.strictEqual(outside.visible, false, "A fully offscreen input must not leave a stale dropdown visible");

const longList = calculateAutocompleteLayout(rect(20, 100, 260, 40), viewport(390, 900), 2000);
assert(longList.height <= 320, "Long suggestion lists must scroll internally instead of covering the page");

for (const filename of ["app.js", "purchase-order.js"]) {
  const source = fs.readFileSync(path.join(projectRoot, filename), "utf8");
  assert(source.includes("input.getBoundingClientRect()"), `${filename} must anchor to the active input rectangle`);
  assert(source.includes("window.visualViewport.addEventListener(\"resize\""), `${filename} must follow keyboard viewport resizing`);
  assert(source.includes("window.visualViewport.addEventListener(\"scroll\""), `${filename} must follow mobile toolbar viewport movement`);
  assert(source.includes("VstdAutocompleteLayout"), `${filename} must use the shared coordinate calculation`);
  assert(source.includes('event.key === "ArrowDown"'), `${filename} must retain desktop keyboard navigation`);
  assert(source.includes("pointerActive"), `${filename} must protect touch selection from premature blur`);
  assert(!source.includes("scrollIntoView"), `${filename} must not jump the page while typing`);
}

for (const filename of ["index.html", "quotation.html"]) {
  const source = fs.readFileSync(path.join(projectRoot, filename), "utf8");
  assert(source.includes('src="autocomplete-positioning.js"'), `${filename} must load the shared autocomplete positioning helper`);
}

console.log("Autocomplete positioning tests passed: below, above, keyboard viewport, offsets, compact fallback, clamping, and long lists.");
