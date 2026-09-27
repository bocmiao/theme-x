const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("templates/assets/js/theme.js", "utf8");
const start = source.indexOf("  function initToc() {");
const end = source.indexOf("  /* ------------------------------------------------- 右栏文章大纲", start);
assert.ok(start >= 0 && end > start, "find the real TOC initializer");
const initializer = source.slice(start, end);

function renderToc(count) {
  const headings = Array.from({ length: count }, (_, i) => ({
    id: `section-${i}`,
    tagName: "H2",
    textContent: `Section ${i + 1}`,
    scrollIntoView() { this.scrolled = true; }
  }));
  const makeList = () => ({ links: [], appendChild(link) { this.links.push(link); } });
  const list = makeList();
  const mobileList = makeList();
  const box = { hidden: true, classList: { toggle() {} } };
  const trigger = { hidden: true };
  const page = { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  const mobile = {
    showPopover() {},
    hidePopover() { this.closed = true; },
    children: { "[data-mobile-toc-list]": mobileList, "[data-mobile-toc-close]": {} }
  };
  const elements = {
    "[data-toc]": box,
    "[data-toc-list]": list,
    "[data-mobile-toc]": mobile,
    "[data-mobile-toc-trigger]": trigger,
    "[data-prose]": {},
    "[data-toc-toggle]": {},
    "main.x-feed": page
  };
  const context = {
    $: (selector, within) => (within ? within.children[selector] : elements[selector]),
    $$: () => [],
    proseHeadings: () => headings,
    document: {
      createElement: () => ({
        attributes: {},
        setAttribute(key, value) { this.attributes[key] = value; }
      })
    },
    on: (element, event, handler) => { element[event] = handler; },
    window: {},
    history: { state: null, replaceState() {} },
    SCROLL_BEHAVIOR: "auto"
  };
  vm.runInNewContext(`${initializer}\ninitToc();`, context);
  return { headings, list, mobileList, box, trigger, page, mobile };
}

const short = renderToc(1);
assert.equal(short.trigger.hidden, true);
assert.equal(short.mobileList.links.length, 0);

const full = renderToc(2);
assert.equal(full.box.hidden, false);
assert.equal(full.trigger.hidden, false);
assert.equal(full.list.links.length, 2);
assert.equal(full.mobileList.links.length, 2);
assert.ok(Object.hasOwn(full.page.attributes, "data-mobile-toc-ready"));
let prevented = false;
full.mobileList.links[1].click({ preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(full.mobile.closed, true);
assert.equal(full.headings[1].scrolled, true);
console.log("mobile TOC: short articles stay hidden; long articles open and navigate");
