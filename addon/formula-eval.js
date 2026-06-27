// Live formula evaluation engine for the "Show All Data" page.
//
// Wraps the vendored sformula parser/evaluator (addon/lib/sformula) to:
//  - parse a Salesforce formula into an AST (every node carries a `loc` span),
//  - evaluate the whole formula AND every interesting sub-expression against the
//    current record's values (so the UI can show a value when you hover a part),
//  - expose a render tree the card walks to draw hoverable, nested spans,
//  - degrade gracefully: a node that can't be evaluated (unsupported function,
//    unresolved cross-object / global reference) is flagged with a reason rather
//    than showing a wrong value.
//
// This module is intentionally free of any React/DOM dependency so the logic can
// be unit-tested in isolation; FormulaEvalCard.js renders its output.

import {compileSync, parseFormula, extractFields, createFieldTypeDictionary} from "./lib/sformula/sformula.js";

// Salesforce describe `type` -> sformula primitive type.
export function sfTypeToSformula(fieldDescribe) {
  if (!fieldDescribe) {
    return null;
  }
  switch (fieldDescribe.type) {
    case "boolean":
      return {type: "boolean"};
    case "int":
    case "integer":
    case "long":
    case "double":
      return {type: "number"};
    case "currency":
      return {type: "currency"};
    case "percent":
      return {type: "percent"};
    case "date":
      return {type: "date"};
    case "datetime":
      return {type: "datetime"};
    case "time":
      return {type: "time"};
    case "picklist":
      return {type: "picklist", picklistValues: picklistValues(fieldDescribe)};
    case "multipicklist":
      return {type: "multipicklist", picklistValues: picklistValues(fieldDescribe)};
    default:
      // string, textarea, phone, url, email, encryptedstring, combobox,
      // id, reference, address, location, anyType, base64, ...
      return {type: "string"};
  }
}

function picklistValues(fieldDescribe) {
  return (fieldDescribe.picklistValues || []).map(p => ({label: p.label, value: p.value}));
}

// Node types we treat as interactive (hoverable) sub-expressions.
const EVALUABLE_TYPES = new Set([
  "CallExpression",
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  "MemberExpression",
  "Identifier",
]);

// Direct child expression nodes to recurse into when building the render tree.
// We deliberately skip a CallExpression's `callee` (the function name) so the
// function name renders as plain text rather than an evaluable token.
function childNodesOf(node) {
  switch (node.type) {
    case "CallExpression":
      return (node.arguments || []).filter(Boolean);
    case "BinaryExpression":
    case "LogicalExpression":
      return [node.left, node.right].filter(Boolean);
    case "UnaryExpression":
      return [node.argument].filter(Boolean);
    case "MemberExpression":
    case "Identifier":
    case "Literal":
      return [];
    default: {
      // Generic fallback for node shapes we do not special-case: collect any
      // nested objects that look like expression nodes with a source span.
      const out = [];
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "callee") {
          continue;
        }
        const value = node[key];
        if (Array.isArray(value)) {
          value.forEach(v => { if (isExprNode(v)) out.push(v); });
        } else if (isExprNode(value)) {
          out.push(value);
        }
      }
      return out;
    }
  }
}

function isExprNode(value) {
  return value && typeof value === "object" && typeof value.type === "string" && value.loc;
}

// Reconstruct a dotted reference (e.g. Account.Owner.Name) from a Member/Identifier node.
function memberPath(node) {
  if (!node) {
    return "";
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "MemberExpression") {
    const left = memberPath(node.object);
    const right = node.property && node.property.name ? node.property.name : "";
    return left && right ? left + "." + right : (left || right);
  }
  return "";
}

// Nest a leaf type for a dotted path into a structured object-type dictionary.
function buildStructuredInto(root, dottedPath, leafType) {
  const parts = dottedPath.split(".");
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cursor[key] || cursor[key].type !== "object") {
      cursor[key] = {type: "object", properties: {}};
    }
    cursor = cursor[key].properties;
  }
  cursor[parts[parts.length - 1]] = leafType;
}

// Read the leaf (primitive) type for a dotted path out of a structured dictionary.
function leafTypeFromDict(dict, dottedPath) {
  const parts = dottedPath.split(".");
  let cursor = dict[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (!cursor || cursor.type !== "object" || !cursor.properties) {
      return null;
    }
    cursor = cursor.properties[parts[i]];
  }
  if (!cursor || cursor.type === "object") {
    return null;
  }
  return cursor;
}

// Read a value for a dotted path out of a nested record (SOQL parent traversal result).
function getByPath(record, dottedPath) {
  const parts = dottedPath.split(".");
  let cursor = record;
  for (const part of parts) {
    if (cursor == null) {
      return null;
    }
    cursor = cursor[part];
  }
  return cursor === undefined ? null : cursor;
}

function classifyField(path) {
  if (path.startsWith("$")) {
    return "global";
  }
  if (path.indexOf(".") !== -1) {
    return "related";
  }
  return "local";
}

function describeError(err) {
  if (!err) {
    return "Could not evaluate";
  }
  const message = (err.message || "").toString();
  // Detect by message text rather than class name: minification mangles the
  // sformula error class names, but the messages are stable.
  if (/type information is not found/i.test(message)) {
    return "References data not available locally";
  }
  if (/is not found|not implemented|unsupported/i.test(message)) {
    return "Function or reference not supported client-side";
  }
  if (/syntax/i.test(message)) {
    return "Syntax not supported";
  }
  return message || "Could not evaluate";
}

export class FormulaEvalModel {
  constructor(options) {
    this.formula = options.formula || "";
    // sformula return type for the whole formula (from the field's data type).
    this.returnType = options.returnType || "any";
    // (fieldName) => Salesforce field describe, for the host object's own fields.
    this.getFieldDescribe = options.getFieldDescribe || (() => undefined);
    // The record's current values (REST GET response).
    this.recordData = options.recordData || {};
    // The formula field's currently stored value (for the "differs" note).
    this.storedValue = options.storedValue;
    this.objectName = options.objectName || "";

    // Resolved input types keyed by reference path (filled in build()).
    this.inputTypes = {};
    // What-if overrides keyed by reference path (phase: what-if editing).
    this.overrides = {};
    // Externally supplied values for related / global references (phase: cross-object).
    this.externalValues = {};

    this.state = "idle"; // "idle" | "ready" | "error"
    this.parseError = null;
    this.ast = null;
    this.references = []; // [{path, kind, available, type}]
    this.renderTree = null;
    this.result = null; // {value, type, error}
  }

  build() {
    try {
      this.ast = parseFormula(this.formula, {});
    } catch (err) {
      this.state = "error";
      this.parseError = describeError(err);
      return this;
    }
    this._collectReferences();
    this._buildInputTypes();
    this._evaluate();
    this.state = "ready";
    return this;
  }

  _collectReferences() {
    let paths = [];
    try {
      paths = extractFields(this.ast) || [];
    } catch {
      paths = [];
    }
    this.refByPath = {};
    this.references = paths.map(path => {
      const kind = classifyField(path);
      let type = null;
      let available = false;
      if (kind === "local") {
        const describe = this.getFieldDescribe(path);
        type = sfTypeToSformula(describe);
        available = !!describe;
      } else if (kind === "global") {
        // Globals ($User, $Profile, ...) can't be auto-resolved; expose them as
        // editable text inputs the user can fill in for a what-if evaluation.
        type = {type: "string"};
        available = true;
      }
      // "related" (cross-object) refs stay unresolved until resolveRelated() runs.
      const ref = {path, kind, type, available};
      this.refByPath[path] = ref;
      return ref;
    });
  }

  // Whether we currently have a value to show for a referenced path.
  hasValueFor(path) {
    if (Object.prototype.hasOwnProperty.call(this.overrides, path)) {
      return true;
    }
    if (this.externalValues[path] && Object.prototype.hasOwnProperty.call(this.externalValues[path], "value")) {
      return true;
    }
    const ref = this.refByPath[path];
    if (ref && ref.kind === "global") {
      return true;
    }
    if (ref && ref.kind === "local" && ref.available) {
      return true;
    }
    return Object.prototype.hasOwnProperty.call(this.recordData, path);
  }

  _buildInputTypes() {
    const inputTypes = {};
    for (const ref of this.references) {
      const type = (this.externalValues[ref.path] && this.externalValues[ref.path].type) || ref.type;
      if (!type) {
        continue;
      }
      if (ref.path.indexOf(".") === -1) {
        inputTypes[ref.path] = type;
      } else {
        // Dotted (related / global) refs need nested object types so esformula
        // can resolve member access, e.g. {Account: {type: "object", properties: {...}}}.
        buildStructuredInto(inputTypes, ref.path, type);
      }
    }
    this.inputTypes = inputTypes;
  }

  // Resolve cross-object (related) reference types and values. Called after the
  // initial synchronous build() once API access is available.
  //   describe(sobjectName)  -> Promise<Salesforce describe response>
  //   fetchRecord(paths)     -> Promise<record with nested parent fields>
  async resolveRelated(options) {
    const describe = options.describe;
    const fetchRecord = options.fetchRecord;
    const sobjectName = options.sobjectName || this.objectName;
    const relatedPaths = [...new Set(this.references.filter(r => r.kind === "related").map(r => r.path))];
    if (!relatedPaths.length) {
      return this;
    }

    let dict = {};
    try {
      dict = await createFieldTypeDictionary({}, relatedPaths, {sobject: sobjectName, describe});
    } catch {
      dict = {};
    }

    let record = null;
    try {
      record = await fetchRecord(relatedPaths);
    } catch {
      record = null;
    }

    for (const path of relatedPaths) {
      const ref = this.refByPath[path];
      const leafType = leafTypeFromDict(dict, path);
      if (leafType) {
        const value = record ? getByPath(record, path) : null;
        this.externalValues[path] = {value: value === undefined ? null : value, type: leafType};
        if (ref) {
          ref.type = leafType;
          ref.available = true;
        }
      } else if (ref) {
        ref.resolveFailed = true;
      }
    }

    this._buildInputTypes();
    this._evaluate();
    return this;
  }

  // Current input value for a reference path (override > external > record > null).
  inputValue(path) {
    if (Object.prototype.hasOwnProperty.call(this.overrides, path)) {
      return this.overrides[path];
    }
    if (this.externalValues[path] && Object.prototype.hasOwnProperty.call(this.externalValues[path], "value")) {
      return this.externalValues[path].value;
    }
    if (Object.prototype.hasOwnProperty.call(this.recordData, path)) {
      return this.recordData[path];
    }
    return null;
  }

  // Build the evaluation context. Same-object fields are flat keys; dotted and
  // global references are nested objects so esformula can walk member access.
  _buildContext() {
    const context = {};
    for (const ref of this.references) {
      const value = this.inputValue(ref.path);
      if (ref.path.indexOf(".") === -1) {
        context[ref.path] = value;
      } else {
        const parts = ref.path.split(".");
        let cursor = context;
        for (let i = 0; i < parts.length - 1; i++) {
          cursor[parts[i]] = cursor[parts[i]] || {};
          cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = value;
      }
    }
    return context;
  }

  _evaluate() {
    const context = this._buildContext();
    this.renderTree = this._buildNode(this.ast, context);
    // Whole-formula result, cast to the field's declared return type when possible.
    this.result = this._evalNode(this.ast, context, this.returnType);
  }

  // Evaluate a single AST node independently against the shared context.
  _evalNode(node, context, returnType) {
    try {
      const options = {inputTypes: this.inputTypes};
      if (returnType && returnType !== "any") {
        options.returnType = returnType;
      }
      const compiled = compileSync(node, options);
      const value = compiled.evaluate(context);
      return {value, type: compiled.returnType, error: null};
    } catch (err) {
      return {value: undefined, type: null, error: describeError(err)};
    }
  }

  _buildNode(node, context) {
    if (!node || !node.loc) {
      return null;
    }
    const start = node.loc.start.offset;
    const end = node.loc.end.offset;
    const evaluable = EVALUABLE_TYPES.has(node.type);
    const isField = node.type === "Identifier" || node.type === "MemberExpression";

    // A field reference shows the record's raw value directly (which is exactly
    // "the value of this field for this record") rather than being recompiled -
    // that avoids sformula rejecting a bare picklist/encrypted field as its own
    // expression, and naturally surfaces related/global refs as not-yet-available.
    let evaluation;
    if (isField) {
      const path = memberPath(node);
      if (this.hasValueFor(path)) {
        const ref = this.refByPath[path];
        evaluation = {value: this.inputValue(path), type: ref && ref.type ? ref.type.type : null, error: null};
      } else {
        evaluation = {value: undefined, type: null, error: "References data not available locally"};
      }
    } else if (evaluable) {
      evaluation = this._evalNode(node, context);
    } else {
      evaluation = {value: undefined, type: null, error: null};
    }

    // sformula folds left-associative chains (a & b & c) into nested binary
    // nodes that all carry the *outer* source span. A child sharing this node's
    // exact span is such a folding artifact: inline its children so spans stay
    // non-overlapping (otherwise the tail operand would render twice).
    const children = [];
    for (const childNode of childNodesOf(node)) {
      const built = this._buildNode(childNode, context);
      if (!built) {
        continue;
      }
      if (built.start === start && built.end === end && built.children.length) {
        children.push(...built.children);
      } else {
        children.push(built);
      }
    }
    children.sort((a, b) => a.start - b.start);

    return {
      type: node.type,
      kind: nodeKind(node),
      start,
      end,
      source: this.formula.slice(start, end),
      evaluable,
      isField,
      fieldPath: isField ? memberPath(node) : null,
      operator: node.operator || null,
      value: evaluation.value,
      valueType: evaluation.type,
      error: evaluation.error,
      children,
    };
  }

  // --- mutation API (what-if editing) -------------------------------------

  setOverride(path, value) {
    this.overrides[path] = value;
    this._evaluate();
  }

  clearOverride(path) {
    delete this.overrides[path];
    this._evaluate();
  }

  hasOverrides() {
    return Object.keys(this.overrides).length > 0;
  }
}

function nodeKind(node) {
  switch (node.type) {
    case "CallExpression": {
      const name = node.callee && node.callee.name ? node.callee.name : "fn";
      return {category: "call", label: name};
    }
    case "BinaryExpression":
      return {category: "binary", label: node.operator};
    case "LogicalExpression":
      return {category: "logical", label: node.operator};
    case "UnaryExpression":
      return {category: "unary", label: node.operator};
    case "MemberExpression":
      return {category: "field", label: memberPath(node)};
    case "Identifier":
      return {category: "field", label: node.name};
    case "Literal":
      return {category: "literal", label: String(node.value)};
    default:
      return {category: "other", label: node.type};
  }
}

// Display formatting shared by the card.
export function formatFormulaValue(value) {
  if (value === null || value === undefined) {
    return "(blank)";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return value === "" ? "(empty text)" : value;
  }
  if (typeof value === "object" && typeof value.toString === "function") {
    return value.toString();
  }
  return String(value);
}
