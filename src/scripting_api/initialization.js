/* Copyright 2020 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Border,
  Cursor,
  Display,
  Font,
  GlobalConstants,
  Highlight,
  Position,
  ScaleHow,
  ScaleWhen,
  Style,
  Trans,
  ZoomType,
} from "./constants.js";
import { CheckboxField, Field, RadioButtonField } from "./field.js";
import { AForm } from "./aform.js";
import { App } from "./app.js";
import { Color } from "./color.js";
import { Console } from "./console.js";
import { Doc } from "./doc.js";
import { ProxyHandler } from "./proxy.js";
import { serializeError } from "./app_utils.js";
import { Util } from "./util.js";

function initSandbox(params) {
  delete globalThis.pdfjsScripting;

  // externalCall is a function to call a function defined
  // outside the sandbox.
  // (see src/pdf.sandbox.external.js).
  const externalCall = globalThis.callExternalFunction;
  delete globalThis.callExternalFunction;

  // eslint-disable-next-line no-eval
  const globalEval = code => globalThis.eval(code);
  const send = data => externalCall("send", [data]);
  const proxyHandler = new ProxyHandler();
  const { data } = params;
  const doc = new Doc({
    send,
    globalEval,
    ...data.docInfo,
  });
  const _document = { obj: doc, wrapped: new Proxy(doc, proxyHandler) };
  const app = new App({
    send,
    globalEval,
    externalCall,
    _document,
    calculationOrder: data.calculationOrder,
    proxyHandler,
    ...data.appInfo,
  });

  const util = new Util({ externalCall });
  const appObjects = app._objects;

  if (data.objects) {
    const annotations = [];

    for (const [name, objs] of Object.entries(data.objects)) {
      annotations.length = 0;
      let container = null;

      for (const obj of objs) {
        if (obj.type !== "") {
          annotations.push(obj);
        } else {
          container = obj;
        }
      }

      let obj = container;
      if (annotations.length > 0) {
        obj = annotations[0];
        obj.send = send;
      }

      obj.globalEval = globalEval;
      obj.doc = _document;
      obj.fieldPath = name;
      obj.appObjects = appObjects;
      obj.util = util;

      const otherFields = annotations.slice(1);

      let field;
      switch (obj.type) {
        case "radiobutton": {
          field = new RadioButtonField(otherFields, obj);
          break;
        }
        case "checkbox": {
          field = new CheckboxField(otherFields, obj);
          break;
        }
        default:
          if (otherFields.length > 0) {
            obj.siblings = otherFields.map(x => x.id);
          }
          field = new Field(obj);
      }

      const wrapped = new Proxy(field, proxyHandler);
      const _object = { obj: field, wrapped };
      doc._addField(name, _object);
      for (const object of objs) {
        appObjects[object.id] = _object;
      }
      if (container) {
        appObjects[container.id] = _object;
      }
    }
  }

  const color = new Color();

  globalThis.event = null;
  globalThis.global = Object.create(null);
  globalThis.app = new Proxy(app, proxyHandler);
  globalThis.color = new Proxy(color, proxyHandler);
  globalThis.console = new Proxy(new Console({ send }), proxyHandler);
  globalThis.util = new Proxy(util, proxyHandler);

  // Shadow the Date constructor to handle numeric strings (Unix timestamps as strings)
  // This allows PDF JavaScript like "new Date('1767143202634')" to work correctly
  const OriginalDate = globalThis.Date;
  globalThis.Date = function (...args) {
    // If called with a single argument that is a numeric string, parse it as an integer
    if (
      args.length === 1 &&
      typeof args[0] === "string" &&
      !isNaN(args[0]) &&
      args[0].trim() !== ""
    ) {
      return new OriginalDate(parseInt(args[0], 10));
    }
    // Otherwise, use the original Date constructor
    return new OriginalDate(...args);
  };
  // Copy static methods from the original Date constructor
  globalThis.Date.prototype = OriginalDate.prototype;
  globalThis.Date.parse = OriginalDate.parse;
  globalThis.Date.UTC = OriginalDate.UTC;
  globalThis.Date.now = OriginalDate.now;

  // Add polyfill for legacy Mozilla toSource() method
  // This allows legacy PDF JavaScript like "eval(this.info.toSource())" to work
  if (!Object.prototype.toSource) {
    Object.defineProperty(Object.prototype, "toSource", {
      value: function () {
        const toSource = (obj, visited = new WeakSet()) => {
          if (obj === null) {
            return "null";
          }
          if (obj === undefined) {
            return "undefined";
          }
          if (typeof obj === "string") {
            return JSON.stringify(obj);
          }
          if (typeof obj === "number" || typeof obj === "boolean") {
            return String(obj);
          }
          if (typeof obj === "function") {
            return "function()";
          }

          // Handle circular references
          if (visited.has(obj)) {
            return "{}";
          }
          visited.add(obj);

          if (Array.isArray(obj)) {
            const items = obj.map(item => toSource(item, visited));
            return `[${items.join(", ")}]`;
          }

          // Handle plain objects
          const pairs = [];
          for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
              const value = toSource(obj[key], visited);
              pairs.push(`${key}: ${value}`);
            }
          }
          return `({${pairs.join(", ")}})`;
        };

        return toSource(this);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  globalThis.border = Border;
  globalThis.cursor = Cursor;
  globalThis.display = Display;
  globalThis.font = Font;
  globalThis.highlight = Highlight;
  globalThis.position = Position;
  globalThis.scaleHow = ScaleHow;
  globalThis.scaleWhen = ScaleWhen;
  globalThis.style = Style;
  globalThis.trans = Trans;
  globalThis.zoomtype = ZoomType;

  // Avoid to have a popup asking to update Acrobat.
  globalThis.ADBE = {
    Reader_Value_Asked: true,
    Viewer_Value_Asked: true,
  };

  // AF... functions
  const aform = new AForm(doc, app, util, color);
  for (const name of Object.getOwnPropertyNames(AForm.prototype)) {
    if (name !== "constructor" && !name.startsWith("_")) {
      globalThis[name] = aform[name].bind(aform);
    }
  }

  // Add global constants such as IDS_GREATER_THAN or RE_NUMBER_ENTRY_DOT_SEP
  for (const [name, value] of Object.entries(GlobalConstants)) {
    Object.defineProperty(globalThis, name, {
      value,
      writable: false,
    });
  }

  // Color functions
  Object.defineProperties(globalThis, {
    ColorConvert: {
      value: color.convert.bind(color),
      writable: true,
    },
    ColorEqual: {
      value: color.equal.bind(color),
      writable: true,
    },
  });

  // The doc properties must live in the global scope too
  const properties = Object.create(null);
  for (const name of Object.getOwnPropertyNames(Doc.prototype)) {
    if (name === "constructor" || name.startsWith("_")) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(Doc.prototype, name);
    if (descriptor.get) {
      properties[name] = {
        get: descriptor.get.bind(doc),
        set: descriptor.set.bind(doc),
      };
    } else {
      properties[name] = {
        value: Doc.prototype[name].bind(doc),
      };
    }
  }
  Object.defineProperties(globalThis, properties);

  const functions = {
    dispatchEvent: app._dispatchEvent.bind(app),
    timeoutCb: app._evalCallback.bind(app),
  };

  return (name, args) => {
    try {
      functions[name](args);
    } catch (error) {
      send(serializeError(error));
    }
  };
}

export { initSandbox };
