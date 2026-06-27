/* global React */
import {formatFormulaValue} from "../formula-eval.js";

let h = React.createElement;

// Inline, interactive "Live Formula" card shown under a formula field's row on
// the Show All Data page. Renders the formula with every sub-expression as a
// hoverable/clickable token whose evaluated value (against the current record)
// appears in a small popover. Inputs can be edited for what-if simulation.
export default class FormulaEvalCard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {activeKey: null, pinnedKey: null, tick: 0};
    this.onCardMouseLeave = this.onCardMouseLeave.bind(this);
    this.onCardClick = this.onCardClick.bind(this);
    this.onClose = this.onClose.bind(this);
  }

  model() {
    return this.props.row.formulaEval;
  }

  keyFor(node) {
    return node.start + "-" + node.end;
  }

  onCardMouseLeave() {
    if (this.state.activeKey) {
      this.setState({activeKey: null});
    }
  }

  onCardClick() {
    // Clicking the card background (tokens stop propagation) unpins.
    if (this.state.pinnedKey) {
      this.setState({pinnedKey: null});
    }
  }

  onClose(e) {
    e.preventDefault();
    let {row} = this.props;
    row.formulaCardOpen = false;
    row.rowList.model.didUpdate();
  }

  onTokenOver(node, e) {
    e.stopPropagation();
    let key = this.keyFor(node);
    if (this.state.activeKey !== key) {
      this.setState({activeKey: key});
    }
  }

  onTokenClick(node, e) {
    e.stopPropagation();
    e.preventDefault();
    let key = this.keyFor(node);
    this.setState({pinnedKey: this.state.pinnedKey === key ? null : key});
  }

  // Re-evaluate after a what-if input change and re-render.
  setOverride(path, value) {
    this.model().setOverride(path, value);
    this.setState({tick: this.state.tick + 1});
  }

  clearOverride(path) {
    this.model().clearOverride(path);
    this.setState({tick: this.state.tick + 1});
  }

  tokenClass(node, key) {
    let classes = ["sfir-formula-token"];
    if (node.error) {
      classes.push("sfir-formula-token_error");
    } else {
      classes.push("sfir-formula-token_" + valueCategory(node.valueType));
    }
    if (node.isField) {
      classes.push("sfir-formula-token_field");
    }
    if (this.state.pinnedKey === key || (this.state.activeKey === key && !this.state.pinnedKey)) {
      classes.push("is-active");
    }
    return classes.join(" ");
  }

  renderPopover(node) {
    return h("span", {className: "sfir-formula-pop slds-popover slds-popover_tooltip slds-nubbin_bottom-left", role: "tooltip"},
      h("div", {className: "slds-popover__body"},
        h("code", {className: "sfir-formula-pop-src"}, node.source),
        node.error
          ? h("div", {className: "sfir-formula-pop-error"},
            h("svg", {className: "slds-icon slds-icon_xx-small slds-m-right_xx-small", viewBox: "0 0 52 52"},
              h("use", {xlinkHref: "symbols.svg#warning"})),
            node.error)
          : h("div", {className: "sfir-formula-pop-value"},
            h("b", {}, formatFormulaValue(node.value)),
            node.valueType ? h("span", {className: "slds-badge slds-m-left_x-small"}, node.valueType) : null)
      )
    );
  }

  // Recursively render an AST render-node: plain text for the gaps between
  // children, interactive spans for evaluable sub-expressions.
  renderNode(node) {
    let model = this.model();
    let key = this.keyFor(node);
    let parts = [];
    let cursor = node.start;
    for (let child of node.children) {
      if (child.start > cursor) {
        parts.push(model.formula.slice(cursor, child.start));
      }
      parts.push(this.renderNode(child));
      cursor = child.end;
    }
    if (cursor < node.end) {
      parts.push(model.formula.slice(cursor, node.end));
    }

    if (!node.evaluable) {
      return h("span", {key}, ...parts);
    }
    let showPop = this.state.pinnedKey === key || (this.state.activeKey === key && !this.state.pinnedKey);
    return h("span", {
      key,
      className: this.tokenClass(node, key),
      onMouseOver: e => this.onTokenOver(node, e),
      onClick: e => this.onTokenClick(node, e),
    }, ...parts, showPop ? this.renderPopover(node) : null);
  }

  renderInputRow(ref) {
    let model = this.model();
    let overridden = Object.prototype.hasOwnProperty.call(model.overrides, ref.path);
    let value = model.inputValue(ref.path);
    let available = model.hasValueFor(ref.path);
    let typeName = ref.type ? ref.type.type : null;

    let control;
    if ((ref.kind === "related" && !ref.available) || ref.pending) {
      // Cross-object / global value still being fetched (or could not be resolved).
      control = h("span", {className: "slds-text-color_weak"}, ref.resolveFailed ? "could not resolve" : "resolving…");
    } else if (typeName === "boolean") {
      control = h("input", {
        type: "checkbox",
        checked: value === true || value === "true",
        onChange: e => this.setOverride(ref.path, e.target.checked),
      });
    } else if (typeName === "picklist" && ref.type.picklistValues && ref.type.picklistValues.length) {
      control = h("select", {
        className: "slds-select slds-select_x-small",
        value: value == null ? "" : value,
        onChange: e => this.setOverride(ref.path, e.target.value),
      },
      h("option", {value: ""}, "(blank)"),
      ref.type.picklistValues.map(p => h("option", {key: p.value, value: p.value}, p.label || p.value)));
    } else {
      let isNumber = typeName === "number" || typeName === "currency" || typeName === "percent";
      control = h("input", {
        type: isNumber ? "number" : "text",
        className: "slds-input slds-input_x-small",
        value: value == null ? "" : value,
        onChange: e => {
          let raw = e.target.value;
          this.setOverride(ref.path, raw === "" ? null : (isNumber ? Number(raw) : raw));
        },
      });
    }

    return h("tr", {key: ref.path, className: available ? "" : "sfir-formula-input_missing"},
      h("td", {className: "sfir-formula-input-name"},
        ref.path,
        ref.kind !== "local" ? h("span", {className: "slds-badge slds-m-left_xx-small"}, ref.kind) : null),
      h("td", {}, control),
      h("td", {className: "sfir-formula-input-reset"},
        overridden ? h("a", {href: "about:blank", onClick: e => { e.preventDefault(); this.clearOverride(ref.path); }}, "reset") : null)
    );
  }

  render() {
    let model = this.model();
    if (!model) {
      return null;
    }

    let header = h("div", {className: "sfir-formula-card-header"},
      h("span", {className: "sfir-formula-card-title"}, "Live Formula"),
      h("span", {className: "slds-text-body_small slds-text-color_weak slds-m-left_x-small"}, "evaluated in your browser"),
      h("button", {className: "slds-button slds-button_icon slds-button_icon-x-small sfir-formula-card-close", title: "Close", onClick: this.onClose},
        h("svg", {className: "slds-button__icon"}, h("use", {xlinkHref: "symbols.svg#close"})))
    );

    if (model.state === "error") {
      return h("div", {className: "sfir-formula-card slds-box slds-box_x-small slds-theme_shade"},
        header,
        h("div", {className: "sfir-formula-pop-error slds-m-top_x-small"}, "Could not parse formula: " + model.parseError));
    }

    let result = model.result || {};
    let differs = !model.hasOverrides() && result.error == null && model.storedValue != null
      && String(result.value) !== String(model.storedValue);

    let resultLine = h("div", {className: "sfir-formula-result slds-m-top_x-small"},
      h("span", {className: "slds-text-title_caps slds-m-right_x-small"}, "Result"),
      result.error
        ? h("span", {className: "sfir-formula-pop-error"}, result.error)
        : h("b", {}, formatFormulaValue(result.value)),
      model.hasOverrides() ? h("span", {className: "slds-badge slds-badge_inverse slds-m-left_x-small"}, "what-if") : null,
      differs ? h("span", {className: "slds-text-color_weak slds-m-left_x-small", title: "The stored value may differ due to client-side evaluation, cross-object data, or org timezone."}, "differs from stored: " + formatFormulaValue(model.storedValue)) : null
    );

    let inputs = model.references.length
      ? h("table", {className: "sfir-formula-inputs slds-table slds-table_bordered slds-table_x-small"},
        h("thead", {}, h("tr", {},
          h("th", {}, "Field / reference"),
          h("th", {}, "Value (editable)"),
          h("th", {}))),
        h("tbody", {}, model.references.map(ref => this.renderInputRow(ref))))
      : null;

    return h("div", {className: "sfir-formula-card slds-box slds-box_x-small", onMouseLeave: this.onCardMouseLeave, onClick: this.onCardClick},
      header,
      // Two columns on wide screens: formula + result on the left, the editable
      // inputs table on the right. Wraps to a single column when space is tight.
      h("div", {className: "sfir-formula-body slds-m-top_x-small"},
        h("div", {className: "sfir-formula-main"},
          h("div", {className: "sfir-formula-expr"}, this.renderNode(model.renderTree)),
          resultLine
        ),
        inputs ? h("div", {className: "sfir-formula-side"}, inputs) : null
      ),
      h("div", {className: "sfir-formula-card-footer slds-text-body_small slds-text-color_weak slds-m-top_x-small"},
        "Hover or click any part to see its value. Related fields and $User / $Profile / $UserRole / $Organization globals are auto-filled from your context; edit any input to simulate.")
    );
  }
}

// Map an sformula value type to a coarse category used for color tinting.
function valueCategory(type) {
  switch (type) {
    case "number":
    case "currency":
    case "percent":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
    case "datetime":
    case "time":
      return "date";
    case "string":
    case "picklist":
    case "multipicklist":
      return "string";
    default:
      return "other";
  }
}
