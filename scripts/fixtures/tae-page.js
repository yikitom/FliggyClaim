// TAE expense page reconstructed from the 2026-04-26 console dump.
// Class names are the real hashed CSS-module names from the log.

const field = (label, required, inner) => `
  <div class="field_PlvYD ${required ? "required_3ncpN" : ""}">
    <div class="label_3OUma" style="padding-top: 9px;">${label}<icon class="uxcore-icon uxicon-yiwen-full icon_2F4nj tip_1L-pv"></icon></div>
    <div class="box_2Yds_"><div class="content_2mYN3">${inner}</div></div>
  </div>`;

const calendar = () => `
  <span class="kuma-calendar-picker-input">
    <input readonly placeholder="请选择" class="kuma-input" value>
    <i class="uxcore-icon uxicon-riqi kuma-calendar-trigger-icon"></i>
  </span>`;

const numberInput = () => `
  <span class="numberInputWrapper_cWTb2">
    <input class="kuma-input" type="text" placeholder="请输入" value>
  </span>`;

// Single-select select2 that already shows the report's default currency.
const currencySelect = () => `
  <div class="select_hfqDF kuma-select2-large kuma-select2 kuma-select2-enabled">
    <div class="kuma-select2-selection kuma-select2-selection--single" role="combobox" aria-expanded="false" tabindex="0">
      <div class="kuma-select2-selection__rendered">
        <div unselectable="on" class="kuma-select2-selection__placeholder" style="display: none;">请选择</div>
        <div class="kuma-select2-selection-selected-value" title="SGD (新加坡元）" style="display: block; opacity: 1;">SGD (新加坡元）</div>
        <div class="kuma-select2-search kuma-select2-search--inline" style="display: none;">
          <div class="kuma-select2-search__field__wrap">
            <input autocomplete="off" class="kuma-select2-search__field" value>
            <span class="kuma-select2-search__field__mirror"></span>
          </div>
        </div>
      </div>
      <span class="kuma-select2-arrow" unselectable="on"></span>
    </div>
  </div>`;

// Employee picker — same widget family, its typeahead input IS visible.
const employeeSelect = (multiple) => `
  <div class="people_2ITS4">
    <div class="kuma-employee-search kuma-select2-large kuma-select2 kuma-select2-enabled">
      <div class="kuma-select2-selection kuma-select2-selection--${multiple ? "multiple" : "single"}" role="combobox" aria-expanded="false">
        <div class="kuma-select2-selection__rendered">
          <div unselectable="on" class="kuma-select2-selection__placeholder" style="display: block;">输入姓名/花名/工号搜索</div>
          <ul><li class="kuma-select2-search kuma-select2-search--inline">
            <div class="kuma-select2-search__field__wrap">
              <input autocomplete="off" class="kuma-select2-search__field" value>
              <span class="kuma-select2-search__field__mirror"></span>
            </div>
          </li></ul>
        </div>
      </div>
    </div>
    <div class="people-counter_1lCKQ"></div>
  </div>`;

const citySelect = () => `
  <div class="select_hfqDF kuma-select2-large kuma-select2 kuma-select2-combobox kuma-select2-enabled">
    <div class="kuma-select2-selection kuma-select2-selection--single" role="combobox" aria-expanded="false">
      <div class="kuma-select2-selection__rendered">
        <div unselectable="on" class="kuma-select2-selection__placeholder" style="display: block;">请选择</div>
        <ul><li class="kuma-select2-search kuma-select2-search--inline">
          <div class="kuma-select2-search__field__wrap">
            <input autocomplete="off" class="kuma-select2-search__field" value>
          </div>
        </li></ul>
      </div>
      <span class="kuma-select2-arrow" unselectable="on"></span>
    </div>
  </div>`;

const upload = (id) => `
  <div><span class="attachment-placeholder_3e8SO"></span><span class="upload-component_1BMS9">
    <span class="upload-link-container_GV8IB">
      <span class="upload-link_3XFgK">上传附件</span>
      <input id="${id}" type="file" multiple accept="doc,docx,xls,xlsx,pdf,jpg,jpeg,png" style="display: none;">
    </span><div class="file-list_3t5H9"></div>
  </span></div>`;

const receiptRadio = () => `
  <div class="radio_2dhs9 field_PlvYD required_3ncpN">
    <div class="label_3OUma">收据类型</div>
    <div class="box_2Yds_"><div class="content_2mYN3">
      <label class="kuma-radio-wrapper"><input type="radio" class="kuma-radio" name="receipt" checked><span>有收据</span></label>
      <label class="kuma-radio-wrapper"><input type="radio" class="kuma-radio" name="receipt"><span>无收据</span></label>
    </div></div>
  </div>`;

const buttons = () => `
  <div class="buttons_1XdQw"><div class="buttons-box_3Zb06">
    <button type="button" class="kuma-button kuma-button-primary with-aux_XroAO">保存</button>
    <button type="button" class="kuma-button kuma-button-primary aux_1zE0p"></button>
    <button type="button" class="kuma-button kuma-button-secondary">取消</button>
  </div></div>`;

const mealForm = () => `
  <div></div>
  <div class="form_D3dym fluid_D6uvy">
    ${receiptRadio()}
    ${field("费用发生时间", false, calendar())}
    ${field("公司合餐人", false, employeeSelect(true))}
    ${field("金额", true, numberInput())}
    ${field("币种", true, currencySelect())}
    ${field("详细说明", false, `<div class="text_3-6R7"><textarea class="kuma-textarea" placeholder="请输入" maxlength="100"></textarea><div class="text-shadow_19SQk"></div></div>`)}
    ${field("附件", false, upload("meal-attach"))}
    ${buttons()}
  </div>`;

const hotelForm = () => `
  <div></div>
  <div class="form_D3dym fluid_D6uvy">
    ${receiptRadio()}
    ${field("费用发生城市", true, citySelect())}
    ${field("入住时间", true, calendar())}
    ${field("离店时间", true, calendar())}
    ${field("公司内合住人", false, employeeSelect(true))}
    ${field("间夜数", true, numberInput())}
    ${field("金额", true, numberInput())}
    ${field("币种", true, currencySelect())}
    ${field("详细说明", false, `<div class="text_3-6R7"><textarea class="kuma-textarea" placeholder="请输入" maxlength="100"></textarea></div>`)}
    ${field("收款人", true, employeeSelect(false))}
    ${field("酒店住宿相关凭证", true, upload("hotel-receipt"))}
    ${field("附件", false, upload("hotel-attach"))}
    ${buttons()}
  </div>`;

// The master pane: 新增费用 toolbar + a DIV-BASED grid (no <table>, no ARIA
// grid roles) whose column header is literally 「金额」 and whose rows carry
// readonly kuma-checkbox selectors. This is what the page-wide scope used to
// hand the amount lookup.
const masterPane = () => `
  <div class="master_1qSRP">
    <div class="toolbar_2xKp">
      <button type="button" data-breaking="true" class="kuma-button kuma-button-primary">新增费用</button>
    </div>
    <div class="grid_1kWq">
      <div class="grid-header_2Ld">
        <span class="cell_9aQ"><input type="checkbox" class="kuma-checkbox" readonly value="on"></span>
        <span class="cell_9aQ">费用类型</span>
        <span class="cell_9aQ">费用发生时间</span>
        <span class="cell_9aQ">金额</span>
        <span class="cell_9aQ">币种</span>
        <span class="cell_9aQ">详细说明</span>
      </div>
      <div class="grid-row_3Bn">
        <span class="cell_9aQ"><input type="checkbox" class="kuma-checkbox" readonly value="on"></span>
        <span class="cell_9aQ">差旅-住宿</span>
        <span class="cell_9aQ">2026-03-29</span>
        <span class="cell_9aQ">684.44</span>
        <span class="cell_9aQ">CNY</span>
        <span class="cell_9aQ">深圳酒店</span>
      </div>
    </div>
  </div>`;

/**
 * Emulate the uxcore/kuma date picker the real page uses: a READONLY input
 * that ignores typing, plus a popup (rendered at document level) whose day
 * cells are the only way to set a value.
 *
 * @param {Window} window
 * @param {{openMonth?: string, titles?: boolean, panelInput?: boolean, broken?: boolean}} opts
 *   openMonth  which month the popup opens on (default 2026-04, i.e. NOT the
 *              month of the records in the log — the panel must be paged)
 *   titles     render td[title="YYYY-MM-DD"] (false ⇒ day-number fallback)
 *   panelInput give the popup its own editable input (rc-calendar's showDateInput)
 *   broken     a picker that never opens — nothing can write the field
 */
export function installCalendarBehavior(window, opts = {}) {
  const { document } = window;
  const { openMonth = "2026-04", titles = true, panelInput = false, broken = false } = opts;
  let bound = null;
  let panel = null;
  let cursor = openMonth;

  const pad = (n) => String(n).padStart(2, "0");

  function close() {
    panel?.remove();
    panel = null;
  }

  function render() {
    const [y, m] = cursor.split("-").map(Number);
    const days = new Date(y, m, 0).getDate();
    panel.innerHTML = `
      <div class="kuma-calendar">
        <div class="kuma-calendar-header">
          <a class="kuma-calendar-prev-month-btn"></a>
          <span class="kuma-calendar-year-select">${y}年</span>
          <span class="kuma-calendar-month-select">${m}月</span>
          <a class="kuma-calendar-next-month-btn"></a>
        </div>
        ${panelInput ? `<div class="kuma-calendar-input-wrap"><input class="kuma-calendar-input" placeholder="请输入日期"></div>` : ""}
        <table class="kuma-calendar-table"><tbody class="kuma-calendar-tbody"><tr>
          <td class="kuma-calendar-cell kuma-calendar-last-month-cell"${titles ? ` title="${y}-${pad(m === 1 ? 12 : m - 1)}-28"` : ""}><div class="kuma-calendar-date">28</div></td>
          ${Array.from({ length: days }, (_, i) => {
            const d = i + 1;
            return `<td class="kuma-calendar-cell"${titles ? ` title="${y}-${pad(m)}-${pad(d)}"` : ""}><div class="kuma-calendar-date">${d}</div></td>`;
          }).join("")}
        </tr></tbody></table>
      </div>`;

    panel.querySelector(".kuma-calendar-prev-month-btn").addEventListener("click", () => {
      const [yy, mm] = cursor.split("-").map(Number);
      cursor = mm === 1 ? `${yy - 1}-12` : `${yy}-${pad(mm - 1)}`;
      render();
    });
    panel.querySelector(".kuma-calendar-next-month-btn").addEventListener("click", () => {
      const [yy, mm] = cursor.split("-").map(Number);
      cursor = mm === 12 ? `${yy + 1}-01` : `${yy}-${pad(mm + 1)}`;
      render();
    });
    for (const td of panel.querySelectorAll("td")) {
      td.addEventListener("click", () => {
        if (td.className.includes("last-month")) return;
        const [yy, mm] = cursor.split("-").map(Number);
        commit(`${yy}-${pad(mm)}-${pad(Number(td.textContent.trim()))}`);
      });
    }
    const typed = panel.querySelector(".kuma-calendar-input");
    if (typed) {
      typed.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        if (/^\d{4}-\d{2}-\d{2}$/.test(typed.value)) commit(typed.value);
      });
    }
  }

  function commit(iso) {
    bound?.__commit?.(iso);
    close();
  }

  // Model the real controlled input: React owns the value, so a programmatic
  // write is dropped and only the widget can change what the field reads back.
  // (Without this, jsdom would happily accept `input.value = "..."` and a
  // "just type into the readonly box" regression would pass the tests.)
  for (const input of document.querySelectorAll(".kuma-calendar-picker-input input")) {
    let real = input.getAttribute("value") || "";
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => real,
      set: () => {},
    });
    input.__commit = (v) => { real = v; };
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.nodeType !== 1 || !t.closest) return;
    const input = t.matches(".kuma-calendar-picker-input input") ? t : null;
    const icon = t.matches(".kuma-calendar-trigger-icon")
      ? t.parentElement.querySelector("input")
      : null;
    const hit = input || icon;
    if (!hit) return;
    if (broken) return;
    if (panel) close();
    bound = hit;
    cursor = openMonth;
    panel = document.createElement("div");
    panel.className = "kuma-calendar-picker-container";
    document.body.appendChild(panel);
    render();
  });
}

/**
 * Emulate the upload component: on `change` it shows a progress row, then
 * after `uploadMs` replaces it with the file entry. `broken: true` models a
 * slot that ignores the synthetic change event entirely, and `failMs` models
 * an upload that errors out.
 *
 * @param {Window} window
 * @param {{uploadMs?: number, broken?: boolean, fails?: boolean}} opts
 */
export function installUploadBehavior(window, opts = {}) {
  const { document } = window;
  const { uploadMs = 300, broken = false, fails = false, stuckProgress = false } = opts;
  for (const input of document.querySelectorAll('input[type="file"]')) {
    // jsdom's `files` is getter-only; make it assignable so the extension's
    // DataTransfer hand-off behaves like it does in Chrome.
    Object.defineProperty(input, "files", { writable: true, configurable: true, value: [] });
    input.addEventListener("change", () => {
      if (broken) return;
      const name = input.files?.[0]?.name;
      if (!name) return;
      const list = input.closest('[class*="upload-component"]')?.querySelector('[class*="file-list"]');
      if (!list) return;
      list.innerHTML = `<div class="upload-progress_2kd">上传中…</div>`;
      window.setTimeout(() => {
        if (fails) list.innerHTML = `<div class="upload-error_9dK">上传失败</div>`;
        // stuckProgress: the file is listed but a completed progress bar stays
        // in the DOM — a real pattern that must not read as "still uploading".
        else if (stuckProgress) list.innerHTML = `<div class="file-item_1aB">${name}</div><div class="upload-progress_2kd"></div>`;
        else list.innerHTML = `<div class="file-item_1aB">${name}</div>`;
      }, uploadMs);
    });
  }
}

/**
 * Emulate the kuma-select2 dropdown: the option list only exists while the
 * widget is open, it is rendered at document level (not inside the field),
 * and the typeahead <input> that filters it is display:none until then —
 * which is exactly why dispatching events straight at that input did nothing.
 *
 * @param {Window} window
 * @param {{options?: Record<string, string[]>, broken?: boolean}} opts
 *   options keyed by the field's label text; fields without an entry stay inert
 *   (the employee pickers, for instance).
 */
export function installComboBehavior(window, opts = {}) {
  const { document } = window;
  const {
    options = {
      币种: ["CNY (人民币）", "USD (美元）", "SGD (新加坡元）"],
      费用发生城市: ["上海", "深圳", "杭州", "北京"],
    },
    broken = false,
  } = opts;

  const labelOf = (el) => {
    const row = el.closest('[class*="field_"]');
    return (row?.querySelector('[class*="label_"]')?.textContent || "").trim();
  };

  function closeDrop() {
    document.querySelectorAll(".kuma-select2-drop").forEach((d) => d.remove());
  }

  function openDrop(component, list) {
    closeDrop();
    const drop = document.createElement("div");
    drop.className = "kuma-select2-drop";
    document.body.appendChild(drop);
    const search = component.querySelector('input[class*="search__field"]');
    // Opening reveals the typeahead input, as the real widget does.
    const searchWrap = component.querySelector('[class*="kuma-select2-search"]');
    if (searchWrap) searchWrap.style.display = "";

    const render = () => {
      const q = (search?.value || "").trim().toUpperCase();
      const shown = list.filter((o) => !q || o.toUpperCase().includes(q));
      drop.innerHTML = `<ul>${shown
        .map((o) => `<li class="kuma-select2-results__option" role="option">${o}</li>`)
        .join("")}</ul>`;
      for (const li of drop.querySelectorAll("li")) {
        li.addEventListener("click", () => {
          const rendered = component.querySelector('[class*="selection__rendered"]');
          let value = component.querySelector('[class*="selection-selected-value"]');
          if (!value && rendered) {
            // A never-touched widget has no value node at all — the real one
            // creates it on first selection (see the 城市 field in the log).
            value = document.createElement("div");
            value.className = "kuma-select2-selection-selected-value";
            rendered.prepend(value);
          }
          if (value) {
            value.textContent = li.textContent;
            value.setAttribute("title", li.textContent);
            value.style.display = "block";
          }
          const placeholder = component.querySelector('[class*="selection__placeholder"]');
          if (placeholder) placeholder.style.display = "none";
          closeDrop();
        });
      }
    };
    render();
    search?.addEventListener("input", render);
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.nodeType !== 1 || !t.closest) return;
    const selection = t.closest('[class*="select2-selection"]');
    if (!selection || broken) return;
    // Climb to the widget root — closest() would match the selection box
    // itself, whose class already contains "kuma-select2".
    let component = selection;
    while (component.parentElement && /kuma-select2|employee-search|select_/.test(
      (component.parentElement.className || "").toString())) {
      component = component.parentElement;
    }
    const list = options[labelOf(selection)];
    if (!list) return;
    openDrop(component, list);
  });
}

/** @param {"meal"|"hotel"|"skeleton"|"picker"} kind */
export function pageHtml(kind) {
  let drawer;
  if (kind === "picker") {
    drawer = `<div class="detail_1KqLf"><div class="box_34vL-">
      <div class="head_10iVC">选择费用类型</div>
      <div class="cascade_1x"><li title="差旅-餐费" class=""><div class="cascade-item_c1ck5">差旅-餐费</div></li>
      <li title="差旅-住宿" class=""><div class="cascade-item_c1ck5">差旅-住宿</div></li></div>
    </div></div>`;
  } else if (kind === "skeleton") {
    // Drawer mounted, schema not back yet: 保存 exists, fields do not.
    drawer = `<div class="detail_1KqLf"><div class="box_34vL- details_busmF">
      <div class="head_10iVC">差旅-住宿</div>
      <div class="content_3HM_U"><div class="loading_2kd"></div>${buttons()}</div>
    </div></div>`;
  } else {
    drawer = `<div class="detail_1KqLf"><div class="box_34vL- details_busmF">
      <div class="head_10iVC">${kind === "hotel" ? "差旅-住宿" : "差旅-餐费"}</div>
      <div class="content_3HM_U">${kind === "hotel" ? hotelForm() : mealForm()}</div>
    </div></div>`;
  }
  return `<!doctype html><html><body>
    <div class="content_3-5bv">
      ${masterPane()}
      <div class="spliter_3Ng16"></div>
      ${drawer}
    </div>
  </body></html>`;
}
