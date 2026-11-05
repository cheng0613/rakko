/* 由 scripts/build-genui-browser.mjs 生成，别手改；源在 packages/genui */
"use strict";
var RakkoGenUI = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/genui/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    COMPONENTS: () => COMPONENTS,
    MAX_DEPTH: () => MAX_DEPTH,
    MAX_NODES: () => MAX_NODES,
    SPECS: () => SPECS,
    checkAction: () => checkAction,
    checkFields: () => checkFields,
    checkFilter: () => checkFilter,
    collectStateKeys: () => collectStateKeys,
    filterRows: () => filterRows,
    formMessage: () => formMessage,
    interpolate: () => interpolate,
    resolveAction: () => resolveAction,
    toPlainText: () => toPlainText,
    validateTree: () => validateTree
  });

  // packages/genui/src/interactive.ts
  var isScalar = (value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  function checkAction(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `${path}: action \u5FC5\u987B\u662F\u5BF9\u8C61`;
    }
    const action = value;
    const hasSend = action.send !== void 0;
    const hasSet = action.set !== void 0;
    if (!hasSend && !hasSet) return `${path}: action \u81F3\u5C11\u8981\u6709\u4E00\u4E2A send \u6216 set`;
    if (hasSend && (typeof action.send !== "string" || action.send.trim() === "")) {
      return `${path}.send: \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`;
    }
    if (hasSet) {
      const set = action.set;
      if (typeof set !== "object" || set === null || Array.isArray(set)) return `${path}.set: \u5FC5\u987B\u662F\u5BF9\u8C61`;
      const entries = Object.entries(set);
      if (entries.length === 0) return `${path}.set: \u4E0D\u80FD\u662F\u7A7A\u5BF9\u8C61`;
      for (const [key, item] of entries) {
        if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) return `${path}.set.${key}: \u72B6\u6001\u540D\u53EA\u80FD\u662F\u5C0F\u5199\u5B57\u6BCD\u6570\u5B57\u4E0B\u5212\u7EBF`;
        if (!isScalar(item)) return `${path}.set.${key}: \u53EA\u80FD\u662F\u5B57\u7B26\u4E32/\u6570\u5B57/\u5E03\u5C14`;
      }
    }
    for (const key of Object.keys(action)) {
      if (key !== "send" && key !== "set") return `${path}.${key}: action \u91CC\u4E0D\u8BA4\u8BC6\u7684\u5B57\u6BB5`;
    }
    return null;
  }
  function checkFields(value, path) {
    if (!Array.isArray(value) || value.length === 0) return `${path}: fields \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4`;
    if (value.length > 8) return `${path}: \u5B57\u6BB5\u6700\u591A 8 \u4E2A`;
    for (const [index, item] of value.entries()) {
      const at = `${path}[${index}]`;
      if (typeof item !== "object" || item === null) return `${at}: \u5B57\u6BB5\u5FC5\u987B\u662F\u5BF9\u8C61`;
      const field = item;
      if (typeof field.key !== "string" || !/^[a-z][a-z0-9_]{0,23}$/.test(field.key)) {
        return `${at}.key: \u53EA\u80FD\u662F\u5C0F\u5199\u5B57\u6BCD\u6570\u5B57\u4E0B\u5212\u7EBF`;
      }
      if (typeof field.label !== "string" || field.label.trim() === "") return `${at}.label: \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`;
      if (field.type !== "text" && field.type !== "number" && field.type !== "select") {
        return `${at}.type: \u53EA\u80FD\u662F text / number / select`;
      }
      if (field.type === "select") {
        if (!Array.isArray(field.options) || field.options.length === 0) return `${at}.options: select \u8981\u6709\u9009\u9879`;
        if (!field.options.every((option) => typeof option === "string")) return `${at}.options: \u9009\u9879\u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
      } else if (field.options !== void 0) {
        return `${at}.options: \u53EA\u6709 select \u80FD\u5E26\u9009\u9879`;
      }
      if (field.placeholder !== void 0 && typeof field.placeholder !== "string") {
        return `${at}.placeholder: \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
      }
    }
    return null;
  }
  function checkFilter(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path}: filterBy \u5FC5\u987B\u662F\u5BF9\u8C61`;
    const filter = value;
    if (typeof filter.key !== "string") return `${path}.key: \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
    if (typeof filter.field !== "string") return `${path}.field: \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
    for (const key of Object.keys(filter)) {
      if (key !== "key" && key !== "field") return `${path}.${key}: filterBy \u91CC\u4E0D\u8BA4\u8BC6\u7684\u5B57\u6BB5`;
    }
    return null;
  }
  function interpolate(text, state) {
    return text.replace(/\{\{\s*([a-z][a-z0-9_]{0,23})\s*\}\}/gi, (_, key) => {
      const value = state[key];
      return value === void 0 ? "" : String(value);
    });
  }
  function resolveAction(action, state) {
    const resolved = {};
    if (action.send !== void 0) resolved.send = interpolate(action.send, state).trim();
    if (action.set !== void 0) resolved.set = { ...action.set };
    return resolved;
  }
  function filterRows(columns, rows, filterBy, state) {
    if (!filterBy) return rows;
    const wanted = state[filterBy.key];
    if (wanted === void 0 || wanted === "") return rows;
    const index = columns.indexOf(filterBy.field);
    if (index === -1) return rows;
    return rows.filter((row) => String(row[index]) === String(wanted));
  }
  function formMessage(fields, state, template) {
    if (template && template.trim() !== "") return interpolate(template, state).trim();
    const parts = fields.filter((field) => state[field.key] !== void 0 && state[field.key] !== "").map((field) => `${field.label}\uFF1A${String(state[field.key])}`);
    return parts.join("\n");
  }
  function collectStateKeys(node, into = /* @__PURE__ */ new Set()) {
    if (node.bind) into.add(node.bind);
    const action = node.props.action;
    if (action?.set) for (const key of Object.keys(action.set)) into.add(key);
    const filter = node.props.filterBy;
    if (filter?.key) into.add(filter.key);
    const fields = node.props.fields;
    if (Array.isArray(fields)) for (const field of fields) into.add(field.key);
    for (const child of node.children ?? []) collectStateKeys(child, into);
    return into;
  }

  // packages/genui/src/index.ts
  var COMPONENTS = [
    "text",
    "markdown",
    "stack",
    "row",
    "card",
    "list",
    "table",
    "chart",
    "form",
    "button",
    "code",
    "callout"
  ];
  var SPECS = {
    text: { props: { text: "string" }, required: ["text"], children: false },
    markdown: { props: { text: "string" }, required: ["text"], children: false },
    stack: { props: { gap: "number", align: "string" }, required: [], children: true },
    row: { props: { gap: "number", wrap: "boolean" }, required: [], children: true },
    card: { props: { title: "string", tone: "string" }, required: [], children: true },
    list: { props: { ordered: "boolean" }, required: [], children: true },
    table: {
      props: { columns: "string[]", rows: "json", caption: "string", filterBy: "json" },
      required: ["columns", "rows"],
      children: false
    },
    chart: { props: { variant: "string", data: "json", label: "string" }, required: ["variant", "data"], children: false },
    form: {
      props: { submitLabel: "string", action: "json", fields: "json", hint: "string" },
      required: ["action", "fields"],
      children: true
    },
    button: {
      props: { label: "string", action: "json", tone: "string" },
      required: ["label", "action"],
      children: false
    },
    code: { props: { text: "string", language: "string" }, required: ["text"], children: false },
    callout: { props: { tone: "string", text: "string" }, required: ["tone", "text"], children: false }
  };
  var MAX_DEPTH = 8;
  var MAX_NODES = 512;
  var isComponentName = (value) => COMPONENTS.includes(value);
  function checkPropType(type, value) {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "boolean":
        return typeof value === "boolean";
      case "string[]":
        return Array.isArray(value) && value.every((item) => typeof item === "string");
      case "json":
        return value !== void 0 && value !== null;
      default:
        return false;
    }
  }
  function walk(input, depth, path, cursor) {
    cursor.nodes += 1;
    if (cursor.nodes > MAX_NODES) return { ok: false, reason: `${path}: \u8282\u70B9\u6570\u8D85\u8FC7\u4E0A\u9650 ${MAX_NODES}` };
    if (depth > MAX_DEPTH) return { ok: false, reason: `${path}: \u5D4C\u5957\u8D85\u8FC7 ${MAX_DEPTH} \u5C42` };
    if (typeof input !== "object" || input === null) return { ok: false, reason: `${path}: \u8282\u70B9\u5FC5\u987B\u662F\u5BF9\u8C61` };
    const node = input;
    if (typeof node.component !== "string") return { ok: false, reason: `${path}: \u7F3A\u5C11 component` };
    if (!isComponentName(node.component)) {
      return { ok: false, reason: `${path}: \u7EC4\u4EF6 ${node.component} \u4E0D\u5728\u767D\u540D\u5355\u5185` };
    }
    const spec = SPECS[node.component];
    const rawProps = node.props ?? {};
    if (typeof rawProps !== "object" || rawProps === null || Array.isArray(rawProps)) {
      return { ok: false, reason: `${path}: props \u5FC5\u987B\u662F\u5BF9\u8C61` };
    }
    const props = {};
    for (const [key, value] of Object.entries(rawProps)) {
      const declared = spec.props[key];
      if (declared === void 0) return { ok: false, reason: `${path}.${key}: \u672A\u58F0\u660E\u7684\u5C5E\u6027` };
      if (!checkPropType(declared, value)) return { ok: false, reason: `${path}.${key}: \u5E94\u4E3A ${declared}` };
      props[key] = value;
    }
    for (const key of spec.required) {
      if (!(key in props)) return { ok: false, reason: `${path}: \u7F3A\u5C11\u5FC5\u586B\u5C5E\u6027 ${key}` };
    }
    if (node.component === "button" || node.component === "form") {
      const problem = checkAction(props.action, `${path}.action`);
      if (problem) return { ok: false, reason: problem };
    }
    if (node.component === "form") {
      const problem = checkFields(props.fields, `${path}.fields`);
      if (problem) return { ok: false, reason: problem };
    }
    if (node.component === "table" && props.filterBy !== void 0) {
      const problem = checkFilter(props.filterBy, `${path}.filterBy`);
      if (problem) return { ok: false, reason: problem };
    }
    const rawChildren = node.children;
    if (rawChildren !== void 0) {
      if (!spec.children) return { ok: false, reason: `${path}: ${node.component} \u4E0D\u80FD\u6709\u5B50\u8282\u70B9` };
      if (!Array.isArray(rawChildren)) return { ok: false, reason: `${path}: children \u5FC5\u987B\u662F\u6570\u7EC4` };
      const children = [];
      for (const [index, child] of rawChildren.entries()) {
        const parsed = walk(child, depth + 1, `${path}[${node.component}].${index}`, cursor);
        if (!parsed.ok) return parsed;
        children.push(parsed.value);
      }
      const parsedNode = { component: node.component, props, children };
      if (typeof node.bind === "string") {
        if (!/^[a-z][a-z0-9_]{0,23}$/.test(node.bind)) return { ok: false, reason: `${path}.bind: \u72B6\u6001\u540D\u53EA\u80FD\u662F\u5C0F\u5199\u5B57\u6BCD\u6570\u5B57\u4E0B\u5212\u7EBF` };
        parsedNode.bind = node.bind;
      }
      return { ok: true, value: parsedNode };
    }
    const leaf = { component: node.component, props };
    if (typeof node.bind === "string") {
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(node.bind)) return { ok: false, reason: `${path}.bind: \u72B6\u6001\u540D\u53EA\u80FD\u662F\u5C0F\u5199\u5B57\u6BCD\u6570\u5B57\u4E0B\u5212\u7EBF` };
      leaf.bind = node.bind;
    }
    return { ok: true, value: leaf };
  }
  function validateTree(input) {
    return walk(input, 0, "$", { nodes: 0 });
  }
  function toPlainText(node) {
    switch (node.component) {
      case "text":
      case "markdown":
      case "code":
        return String(node.props.text ?? "");
      case "callout":
        return String(node.props.text ?? "");
      case "button":
        return `[${String(node.props.label ?? "")}]`;
      case "table": {
        const columns = Array.isArray(node.props.columns) ? node.props.columns : [];
        const rows = Array.isArray(node.props.rows) ? node.props.rows : [];
        const lines = [columns.join(" | ")];
        for (const row of rows) lines.push((Array.isArray(row) ? row : []).map((cell) => String(cell)).join(" | "));
        return lines.join("\n");
      }
      case "chart":
        return `[\u56FE\u8868 ${String(node.props.variant ?? "")}] ${String(node.props.label ?? "")}`.trim();
      case "form": {
        const fields = Array.isArray(node.props.fields) ? node.props.fields : [];
        const submit = String(node.props.submitLabel ?? "\u63D0\u4EA4");
        const inner = (node.children ?? []).map((child) => toPlainText(child)).filter(Boolean).join("\n");
        return [fields.map((field) => `${field.label ?? ""}\uFF1A____`).join("\n"), inner, `[${submit}]`].filter(Boolean).join("\n");
      }
      default: {
        const children = node.children ?? [];
        return children.map((child) => toPlainText(child)).filter(Boolean).join("\n");
      }
    }
  }
  return __toCommonJS(index_exports);
})();
